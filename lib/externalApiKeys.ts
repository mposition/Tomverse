import "server-only";
import type { Session } from "next-auth";
import { prisma } from "@/lib/prisma";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { keyCreditTotals } from "@/lib/externalApiAdmission";
import {
    EXTERNAL_API_KEY_LIMITS,
    digestExternalApiKey,
    externalApiKeyState,
    generateExternalApiKey,
    parseExternalApiBearer,
} from "@/lib/externalApiKeyCore";

/**
 * Account-side management of external API keys, and Bearer authentication of
 * the /api/v1 routes. Management is cookie-authenticated (the caller resolves
 * the session); authentication never reads a cookie.
 *
 * Every state change -- create, rename, cap change, revoke -- is written to the
 * hash-chained audit log in the same transaction as the change, with the key's
 * public prefix and never its secret or digest.
 */

export class ExternalApiKeyError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string
    ) {
        super(message);
    }
}

const keyListSelect = {
    id: true,
    name: true,
    keyPrefix: true,
    creditCap: true,
    expiresAt: true,
    revokedAt: true,
    lastUsedAt: true,
    createdAt: true,
} as const;

export type ExternalApiKeySummary = {
    id: string;
    name: string;
    keyPrefix: string;
    creditCap: number | null;
    committedCredits: number;
    heldCredits: number;
    requestCount: number;
    state: "active" | "expired" | "revoked";
    expiresAt: string | null;
    revokedAt: string | null;
    lastUsedAt: string | null;
    createdAt: string;
};

export const listExternalApiKeys = async (
    userId: string,
    now = new Date()
): Promise<ExternalApiKeySummary[]> => {
    const keys = await prisma.externalApiKey.findMany({
        where: { userId },
        select: keyListSelect,
        orderBy: { createdAt: "desc" },
    });
    const totals = await keyCreditTotals(prisma, keys.map((key) => key.id));
    return keys.map((key) => {
        const total = totals.get(key.id) ?? { committed: 0, held: 0, count: 0 };
        return {
            id: key.id,
            name: key.name,
            keyPrefix: key.keyPrefix,
            creditCap: key.creditCap,
            committedCredits: total.committed,
            heldCredits: total.held,
            requestCount: total.count,
            state: externalApiKeyState(key, now),
            expiresAt: key.expiresAt?.toISOString() ?? null,
            revokedAt: key.revokedAt?.toISOString() ?? null,
            lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
            createdAt: key.createdAt.toISOString(),
        };
    });
};

type AuditContext = { session: Session; request: Request };

const isUniqueViolation = (error: unknown) =>
    typeof error === "object" && error !== null && (error as { code?: unknown }).code === "P2002";

/**
 * The public prefix is ~41 random bits and unique, so two accounts can, very
 * rarely, draw the same one. That is a reason to draw again, not to fail: the
 * whole transaction rolls back and nothing about the losing draw is kept.
 */
export const createExternalApiKey = async (
    input: { userId: string; name: string; creditCap: number | null; expiresAt: Date | null },
    audit: AuditContext
) => {
    for (let attempt = 0; ; attempt += 1) {
        try {
            return await createExternalApiKeyOnce(input, audit);
        } catch (error) {
            if (attempt < 3 && isUniqueViolation(error)) continue;
            throw error;
        }
    }
};

const createExternalApiKeyOnce = async (
    input: { userId: string; name: string; creditCap: number | null; expiresAt: Date | null },
    audit: AuditContext
) => {
    const generated = generateExternalApiKey();
    const created = await prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const active = await tx.externalApiKey.count({
            where: {
                userId: input.userId,
                revokedAt: null,
                OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
        });
        if (active >= EXTERNAL_API_KEY_LIMITS.maxKeysPerUser) {
            throw new ExternalApiKeyError(
                409,
                "EXTERNAL_API_KEY_LIMIT",
                `An account can hold at most ${EXTERNAL_API_KEY_LIMITS.maxKeysPerUser} active keys. Revoke one first.`
            );
        }
        const key = await tx.externalApiKey.create({
            data: {
                userId: input.userId,
                name: input.name,
                keyPrefix: generated.keyPrefix,
                secretDigest: generated.secretDigest,
                creditCap: input.creditCap,
                expiresAt: input.expiresAt,
            },
            select: keyListSelect,
        });
        await writeAdminAuditLog({
            tx,
            session: audit.session,
            request: audit.request,
            action: "external_api_key.created",
            targetType: "ExternalApiKey",
            targetId: key.id,
            summary: `External API key ${key.keyPrefix} created`,
            metadata: {
                keyPrefix: key.keyPrefix,
                creditCap: key.creditCap,
                expiresAt: key.expiresAt?.toISOString() ?? null,
            },
        });
        return key;
    });
    // The only time the secret leaves the server.
    return { key: generated.key, summary: created };
};

const ownedKey = async (
    tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0],
    userId: string,
    keyId: string
) => {
    const rows = await tx.$queryRaw<
        Array<{ id: string; keyPrefix: string; revokedAt: Date | null }>
    >`SELECT "id", "keyPrefix", "revokedAt" FROM "ExternalApiKey"
      WHERE "id" = ${keyId} AND "userId" = ${userId} FOR UPDATE`;
    const key = rows[0];
    // Another account's key and a key that does not exist answer the same way.
    if (!key) throw new ExternalApiKeyError(404, "EXTERNAL_API_KEY_NOT_FOUND", "Key not found.");
    return key;
};

export const updateExternalApiKey = async (
    input: { userId: string; keyId: string; name?: string; creditCap?: number | null },
    audit: AuditContext
) =>
    prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const key = await ownedKey(tx, input.userId, input.keyId);
        if (key.revokedAt) {
            throw new ExternalApiKeyError(409, "EXTERNAL_API_KEY_REVOKED", "A revoked key cannot be changed.");
        }
        const updated = await tx.externalApiKey.update({
            where: { id: key.id },
            data: {
                ...(input.name !== undefined ? { name: input.name } : {}),
                ...(input.creditCap !== undefined ? { creditCap: input.creditCap } : {}),
            },
            select: keyListSelect,
        });
        await writeAdminAuditLog({
            tx,
            session: audit.session,
            request: audit.request,
            action: "external_api_key.updated",
            targetType: "ExternalApiKey",
            targetId: key.id,
            summary: `External API key ${key.keyPrefix} updated`,
            metadata: {
                keyPrefix: key.keyPrefix,
                renamed: input.name !== undefined,
                ...(input.creditCap !== undefined ? { creditCap: input.creditCap } : {}),
            },
        });
        return updated;
    });

/**
 * Revocation is immediate for new requests: admission reads the key row with
 * `FOR UPDATE` inside its own transaction, so once this commits no request can
 * be admitted on the key. A request admitted just before keeps its reservation
 * and is settled normally -- its provider call may already be under way.
 */
export const revokeExternalApiKey = async (
    input: { userId: string; keyId: string },
    audit: AuditContext
) =>
    prisma.$transaction(async (tx) => {
        await takeAuditChainLock(tx);
        const key = await ownedKey(tx, input.userId, input.keyId);
        if (key.revokedAt) return { alreadyRevoked: true };
        await tx.externalApiKey.update({
            where: { id: key.id },
            data: { revokedAt: new Date() },
        });
        await writeAdminAuditLog({
            tx,
            session: audit.session,
            request: audit.request,
            action: "external_api_key.revoked",
            targetType: "ExternalApiKey",
            targetId: key.id,
            summary: `External API key ${key.keyPrefix} revoked`,
            metadata: { keyPrefix: key.keyPrefix },
        });
        return { alreadyRevoked: false };
    });

export type AuthenticatedExternalApiKey = {
    keyId: string;
    keyPrefix: string;
    userId: string;
    creditCap: number | null;
};

/**
 * Resolves a Bearer header to a live key. This is a read-side check only:
 * admission re-reads the key under lock (lib/externalApiAdmission.ts), so a
 * revocation that lands between this read and the reservation still refuses.
 */
export const authenticateExternalApiKey = async (
    authorization: string | null,
    now = new Date()
): Promise<AuthenticatedExternalApiKey> => {
    const parsed = parseExternalApiBearer(authorization);
    if (parsed.kind !== "key") {
        throw new ExternalApiKeyError(401, "invalid_api_key", "A valid Tomverse API key is required.");
    }
    const key = await prisma.externalApiKey.findUnique({
        where: { secretDigest: digestExternalApiKey(parsed.key) },
        select: {
            id: true,
            keyPrefix: true,
            userId: true,
            creditCap: true,
            expiresAt: true,
            revokedAt: true,
            user: { select: { accountStatus: true } },
        },
    });
    // Unknown, revoked and expired keys answer identically, so a probe learns
    // nothing about which keys once existed.
    if (
        !key ||
        key.keyPrefix !== parsed.keyPrefix ||
        externalApiKeyState(key, now) !== "active" ||
        key.user.accountStatus !== "active"
    ) {
        throw new ExternalApiKeyError(401, "invalid_api_key", "A valid Tomverse API key is required.");
    }
    return {
        keyId: key.id,
        keyPrefix: key.keyPrefix,
        userId: key.userId,
        creditCap: key.creditCap,
    };
};

export const externalApiKeyUsage = async (keyId: string, limit = 50) => {
    const rows = await prisma.externalApiRequest.findMany({
        where: { keyId },
        orderBy: { createdAt: "desc" },
        take: Math.min(200, Math.max(1, limit)),
        select: {
            id: true,
            modelId: true,
            stream: true,
            clientName: true,
            finishReason: true,
            errorCode: true,
            createdAt: true,
            completedAt: true,
            reservation: {
                select: {
                    status: true,
                    outcome: true,
                    reservedCredits: true,
                    settledCredits: true,
                    settledInputTokens: true,
                    settledCachedInputTokens: true,
                    settledCacheWriteInputTokens: true,
                    settledOutputTokens: true,
                },
            },
        },
    });
    return rows.map((row) => {
        const held = row.reservation.status === "reserved";
        return {
            requestId: row.id,
            modelId: row.modelId,
            stream: row.stream,
            client: row.clientName,
            createdAt: row.createdAt.toISOString(),
            completedAt: row.completedAt?.toISOString() ?? null,
            finishReason: row.finishReason,
            errorCode: row.errorCode,
            // `held` is in flight or unresolved; its numbers are not final and
            // are reported as null rather than as zero.
            status: held ? "held" : row.reservation.status,
            outcome: row.reservation.outcome,
            heldCredits: held ? row.reservation.reservedCredits : 0,
            chargedCredits: held ? null : row.reservation.settledCredits,
            usage: held
                ? null
                : {
                      inputTokens: row.reservation.settledInputTokens,
                      cachedInputTokens: row.reservation.settledCachedInputTokens,
                      cacheWriteInputTokens: row.reservation.settledCacheWriteInputTokens,
                      outputTokens: row.reservation.settledOutputTokens,
                  },
        };
    });
};
