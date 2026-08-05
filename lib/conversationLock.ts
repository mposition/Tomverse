import "server-only";

import {
    createHash,
    createHmac,
    randomBytes,
    scrypt,
    timingSafeEqual,
} from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { logSecurityAuditEvent } from "@/lib/securityAudit";

const HASH_PREFIX = "scrypt";
const HASH_VERSION = "1";
const SCRYPT_N = 16_384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SALT_BYTES = 16;
const KEY_BYTES = 64;
const ATTEMPT_WINDOW_MS = 15 * 60 * 1000;
const USER_ATTEMPT_LIMIT = 5;
const IP_ATTEMPT_LIMIT = 20;
const UNLOCK_GRANT_TTL_SECONDS = 30 * 60;
const UNLOCK_COOKIE_PREFIX = "tomverse_unlock_";

/**
 * What a lock can protect (policy §7, release B5).
 *
 * The lock began life owning exactly one kind of thing, so "conversation" is
 * spelled into its cookie names, its grant signatures and its attempt keys.
 * Generalising it has one hard requirement and one soft one:
 *
 *   * **hard** — a grant for one resource type must never verify for another,
 *     even when the two ids are identical. Ids come from different tables and
 *     nothing stops them colliding.
 *   * **soft** — the native conversation path should not change at all. Every
 *     existing unlock cookie stays valid, every existing attempt counter keeps
 *     counting, and the eighteen call sites keep their current signatures.
 *
 * Both are met by leaving `conversation` byte-identical and giving every other
 * type its own derived signing key, its own cookie name and its own attempt
 * key. A derived *key* rather than a prefixed string, because a prefix is only
 * a separator if no input can contain it — and `userId` is an input.
 */
export const LOCK_RESOURCE_TYPES = [
    "conversation",
    "external_conversation",
] as const;

export type LockResourceType = (typeof LOCK_RESOURCE_TYPES)[number];

const NATIVE_RESOURCE: LockResourceType = "conversation";

export class ConversationLockError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly retryAfter?: number
    ) {
        super(message);
    }
}

const deriveKey = (password: string, salt: Buffer) =>
    new Promise<Buffer>((resolve, reject) => {
        scrypt(
            password,
            salt,
            KEY_BYTES,
            {
                N: SCRYPT_N,
                r: SCRYPT_R,
                p: SCRYPT_P,
                maxmem: 64 * 1024 * 1024,
            },
            (error, key) => {
                if (error) reject(error);
                else resolve(key);
            }
        );
    });

const assertPasswordLength = (password: unknown, minimum: number) => {
    if (
        typeof password !== "string" ||
        password.length < minimum ||
        password.length > 128 ||
        Buffer.byteLength(password, "utf8") > 512
    ) {
        throw new ConversationLockError(
            400,
            "INVALID_LOCK_PASSWORD",
            `Password must be between ${minimum} and 128 characters.`
        );
    }
    return password;
};

export const hashConversationPassword = async (password: unknown) => {
    const validated = assertPasswordLength(password, 8);
    const salt = randomBytes(SALT_BYTES);
    const key = await deriveKey(validated, salt);
    return [
        HASH_PREFIX,
        HASH_VERSION,
        SCRYPT_N,
        SCRYPT_R,
        SCRYPT_P,
        salt.toString("base64url"),
        key.toString("base64url"),
    ].join("$");
};

export const isHashedConversationPassword = (stored: string) =>
    stored.startsWith(`${HASH_PREFIX}$${HASH_VERSION}$`);

/**
 * SEC-011, stage 1 of 2. This is not a password check: it compares
 * `sha256(candidate)` with `sha256(stored)`, which can only match when `stored`
 * is the plaintext. It exists solely so rows written before scrypt hashing keep
 * unlocking while `scripts/migrate-legacy-conversation-passwords.mjs` clears
 * them.
 *
 * Do not delete this together with the migration. See §7.5 of
 * `.github/RELEASE_CHECKLIST.md`: it goes in a *later* release, after
 * production has been observed at zero plaintext rows. Removing it early turns
 * any row the migration missed from insecurely unlockable into permanently
 * unlockable, with no recovery path for the owner.
 */
const compareLegacyPassword = (password: string, stored: string) => {
    const actual = createHash("sha256").update(password).digest();
    const expected = createHash("sha256").update(stored).digest();
    return timingSafeEqual(actual, expected);
};

export const verifyConversationPassword = async (
    password: unknown,
    stored: string
) => {
    const validated = assertPasswordLength(password, 1);
    if (!isHashedConversationPassword(stored)) {
        return {
            matches: compareLegacyPassword(validated, stored),
            needsUpgrade: true,
        };
    }

    const parts = stored.split("$");
    if (parts.length !== 7) {
        return { matches: false, needsUpgrade: false };
    }

    const [, version, nValue, rValue, pValue, saltValue, keyValue] = parts;
    if (
        version !== HASH_VERSION ||
        Number(nValue) !== SCRYPT_N ||
        Number(rValue) !== SCRYPT_R ||
        Number(pValue) !== SCRYPT_P
    ) {
        return { matches: false, needsUpgrade: false };
    }

    try {
        const expected = Buffer.from(keyValue, "base64url");
        const actual = await deriveKey(
            validated,
            Buffer.from(saltValue, "base64url")
        );
        return {
            matches:
                actual.length === expected.length &&
                timingSafeEqual(actual, expected),
            needsUpgrade: false,
        };
    } catch {
        return { matches: false, needsUpgrade: false };
    }
};

const getSecret = () => {
    if (!process.env.NEXTAUTH_SECRET) {
        throw new ConversationLockError(
            503,
            "SECURITY_NOT_CONFIGURED",
            "Lock security is not configured."
        );
    }
    return process.env.NEXTAUTH_SECRET;
};

const unlockCookieName = (
    resourceType: LockResourceType,
    resourceId: string
) =>
    resourceType === NATIVE_RESOURCE
        ? `${UNLOCK_COOKIE_PREFIX}${resourceId}`
        : `${UNLOCK_COOKIE_PREFIX}${resourceType}_${resourceId}`;

/**
 * The HMAC key for one resource type. Native uses the secret itself, which is
 * what keeps existing cookies valid; every other type uses a key derived from
 * it under a type-specific label, so a grant cannot be replayed across types
 * however the ids line up.
 */
const grantKey = (resourceType: LockResourceType): string | Buffer =>
    resourceType === NATIVE_RESOURCE
        ? getSecret()
        : createHmac("sha256", getSecret())
              .update(`lock-resource.${resourceType}.v1`)
              .digest();

const passwordFingerprint = (storedPassword: string) =>
    createHash("sha256").update(storedPassword).digest("base64url");

const signUnlockGrant = (
    resourceType: LockResourceType,
    userId: string,
    resourceId: string,
    expiresAt: number,
    fingerprint: string
) =>
    createHmac("sha256", grantKey(resourceType))
        .update(`${userId}:${resourceId}:${expiresAt}:${fingerprint}`)
        .digest("base64url");

const readCookie = (request: Request, name: string) => {
    const header = request.headers.get("cookie") || "";
    for (const part of header.split(";")) {
        const separator = part.indexOf("=");
        if (separator < 0) continue;
        if (part.slice(0, separator).trim() === name) {
            return part.slice(separator + 1).trim();
        }
    }
    return null;
};

export const createResourceUnlockCookie = (
    resourceType: LockResourceType,
    userId: string,
    resourceId: string,
    storedPassword: string
) => {
    const expiresAt = Math.floor(Date.now() / 1000) + UNLOCK_GRANT_TTL_SECONDS;
    const fingerprint = passwordFingerprint(storedPassword);
    const signature = signUnlockGrant(
        resourceType,
        userId,
        resourceId,
        expiresAt,
        fingerprint
    );
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${unlockCookieName(resourceType, resourceId)}=${expiresAt}.${fingerprint}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${UNLOCK_GRANT_TTL_SECONDS}; Priority=High${secure}`;
};

/** The native shape, unchanged, for the eighteen call sites that use it. */
export const createConversationUnlockCookie = (
    userId: string,
    conversationId: string,
    storedPassword: string
) =>
    createResourceUnlockCookie(
        NATIVE_RESOURCE,
        userId,
        conversationId,
        storedPassword
    );

export const clearResourceUnlockCookie = (
    resourceType: LockResourceType,
    resourceId: string
) => {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${unlockCookieName(resourceType, resourceId)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0; Priority=High${secure}`;
};

export const clearConversationUnlockCookie = (conversationId: string) =>
    clearResourceUnlockCookie(NATIVE_RESOURCE, conversationId);

export const hasResourceUnlockGrant = (
    resourceType: LockResourceType,
    request: Request,
    userId: string,
    resourceId: string,
    storedPassword: string | null
) => {
    if (!storedPassword) return true;

    const conversationId = resourceId;
    const token = readCookie(request, unlockCookieName(resourceType, resourceId));
    if (!token) return false;

    const [expiresValue, fingerprint, signature, ...extra] = token.split(".");
    const expiresAt = Number(expiresValue);
    if (
        extra.length > 0 ||
        !Number.isSafeInteger(expiresAt) ||
        expiresAt <= Math.floor(Date.now() / 1000) ||
        fingerprint !== passwordFingerprint(storedPassword)
    ) {
        return false;
    }

    const expected = signUnlockGrant(
        resourceType,
        userId,
        conversationId,
        expiresAt,
        fingerprint
    );
    const actualBuffer = Buffer.from(signature || "");
    const expectedBuffer = Buffer.from(expected);
    return (
        actualBuffer.length === expectedBuffer.length &&
        timingSafeEqual(actualBuffer, expectedBuffer)
    );
};

/** The native shape, unchanged. */
export const hasConversationUnlockGrant = (
    request: Request,
    userId: string,
    conversationId: string,
    storedPassword: string | null
) =>
    hasResourceUnlockGrant(
        NATIVE_RESOURCE,
        request,
        userId,
        conversationId,
        storedPassword
    );

export const conversationLockedResponse = () =>
    new Response(
        JSON.stringify({
            error: "Conversation is locked.",
            code: "CONVERSATION_LOCKED",
        }),
        {
            status: 423,
            headers: {
                "Content-Type": "application/json",
                "Cache-Control": "no-store",
            },
        }
    );

const rateKey = (...values: string[]) =>
    `lock:${createHash("sha256")
        .update(`${values.join(":")}:${getSecret()}`)
        .digest("hex")}`;

const attemptWindowStart = (now: Date) =>
    new Date(
        Math.floor(now.getTime() / ATTEMPT_WINDOW_MS) * ATTEMPT_WINDOW_MS
    );

const incrementAttempt = async (
    tx: Prisma.TransactionClient,
    key: string,
    start: Date,
    limit: number
) => {
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${key}, 'lock-15m', ${start}, 1, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET
            "count" = "ChatUsageBucket"."count" + 1,
            "updatedAt" = NOW()
        WHERE "ChatUsageBucket"."count" < ${limit}
        RETURNING "count"
    `;
    return rows.length > 0;
};

export const consumeLockVerificationAttempt = async (
    request: Request,
    userId: string,
    resourceId: string,
    resourceType: LockResourceType = NATIVE_RESOURCE
) => {
    const now = new Date();
    const start = attemptWindowStart(now);
    // Native keeps its exact key so an in-flight 15-minute window is not reset
    // by this change — resetting it would hand an attacker a fresh budget.
    // Other types get a distinct key so their attempts are counted separately
    // rather than sharing a budget with a conversation of the same id.
    const attemptScope =
        resourceType === NATIVE_RESOURCE
            ? resourceId
            : `${resourceType}:${resourceId}`;
    const userKey = rateKey("user", userId, attemptScope);
    const ipKey = rateKey(
        "ip",
        getAnonymousClientKey(request),
        attemptScope
    );

    await prisma.$transaction(async (tx) => {
        const userAllowed = await incrementAttempt(
            tx,
            userKey,
            start,
            USER_ATTEMPT_LIMIT
        );
        const ipAllowed = await incrementAttempt(
            tx,
            ipKey,
            start,
            IP_ATTEMPT_LIMIT
        );
        if (!userAllowed || !ipAllowed) {
            logSecurityAuditEvent("conversation.lock.verify", {
                userId,
                resourceId:
                    resourceType === NATIVE_RESOURCE
                        ? resourceId
                        : `${resourceType}:${resourceId}`,
                request,
                outcome: "rate_limited",
                reason: "LOCK_RATE_LIMITED",
            });
            throw new ConversationLockError(
                429,
                "LOCK_RATE_LIMITED",
                "Too many password attempts.",
                Math.max(
                    1,
                    Math.ceil(
                        (start.getTime() + ATTEMPT_WINDOW_MS - now.getTime()) /
                            1000
                    )
                )
            );
        }
    });

    return { userKey, ipKey, start };
};

export const clearLockVerificationAttempts = async (attempt: {
    userKey: string;
    ipKey: string;
    start: Date;
}) => {
    await prisma.$executeRaw`
        DELETE FROM "ChatUsageBucket"
        WHERE "period" = 'lock-15m'
          AND "periodStart" = ${attempt.start}
          AND "key" IN (${attempt.userKey}, ${attempt.ipKey})
    `;
};

export const lockErrorResponse = (error: unknown) => {
    if (!(error instanceof ConversationLockError)) return null;

    const headers = new Headers({ "Content-Type": "application/json" });
    if (error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
    return new Response(
        JSON.stringify({ success: false, error: error.message, code: error.code }),
        { status: error.status, headers }
    );
};
