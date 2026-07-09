import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const GUEST_COOKIE_NAME = "tomverse_guest";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const CHAT_REQUEST_LIMITS = {
    maxBodyBytes: 2 * 1024 * 1024,
    maxMessages: 100,
    maxMessageCharacters: 50_000,
    maxTotalCharacters: 300_000,
} as const;

type AccessKind = "user" | "guest";
type Period = "minute" | "day" | "month";
type LimitRule = { period: Period; limit: number };
type ChatAccess = {
    kind: AccessKind;
    subjectKey: string;
    ipKey: string;
    setCookie?: string;
};

export class ChatAccessError extends Error {
    constructor(
        public readonly status: number,
        public readonly code: string,
        message: string,
        public readonly retryAfter?: number
    ) {
        super(message);
    }
}

const positiveInteger = (value: string | undefined, fallback: number) => {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

const limitsFor = (kind: AccessKind): LimitRule[] =>
    kind === "user"
        ? [
              { period: "minute", limit: positiveInteger(process.env.CHAT_USER_PER_MINUTE, 20) },
              { period: "day", limit: positiveInteger(process.env.CHAT_USER_PER_DAY, 500) },
              { period: "month", limit: positiveInteger(process.env.CHAT_USER_PER_MONTH, 10_000) },
          ]
        : [
              { period: "minute", limit: positiveInteger(process.env.CHAT_GUEST_PER_MINUTE, 5) },
              { period: "day", limit: positiveInteger(process.env.CHAT_GUEST_PER_DAY, 20) },
              { period: "month", limit: positiveInteger(process.env.CHAT_GUEST_PER_MONTH, 100) },
          ];

const getSecret = () => {
    const secret = process.env.NEXTAUTH_SECRET;
    if (!secret) {
        throw new ChatAccessError(
            503,
            "SECURITY_NOT_CONFIGURED",
            "Chat security is not configured."
        );
    }
    return secret;
};

const signGuestId = (guestId: string) =>
    createHmac("sha256", getSecret()).update(guestId).digest("base64url");

const parseCookies = (header: string | null) =>
    new Map(
        (header || "")
            .split(";")
            .map((part) => part.trim())
            .filter(Boolean)
            .map((part) => {
                const separator = part.indexOf("=");
                return separator === -1
                    ? [part, ""]
                    : [part.slice(0, separator), part.slice(separator + 1)];
            })
    );

const readGuestId = (request: Request) => {
    const token = parseCookies(request.headers.get("cookie")).get(GUEST_COOKIE_NAME);
    if (!token) return null;

    const separator = token.lastIndexOf(".");
    if (separator === -1) return null;

    const guestId = token.slice(0, separator);
    const signature = token.slice(separator + 1);
    if (!/^[0-9a-f-]{36}$/i.test(guestId)) return null;

    const expected = signGuestId(guestId);
    const actualBuffer = Buffer.from(signature);
    const expectedBuffer = Buffer.from(expected);
    if (
        actualBuffer.length !== expectedBuffer.length ||
        !timingSafeEqual(actualBuffer, expectedBuffer)
    ) {
        return null;
    }
    return guestId;
};

const createGuestCookie = (guestId: string) => {
    const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
    return `${GUEST_COOKIE_NAME}=${guestId}.${signGuestId(guestId)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_COOKIE_MAX_AGE}${secure}`;
};

const getClientIp = (request: Request) => {
    const forwarded = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
    return (
        request.headers.get("cf-connecting-ip")?.trim() ||
        request.headers.get("x-real-ip")?.trim() ||
        forwarded ||
        "unknown"
    );
};

const hashKey = (scope: string, value: string) =>
    createHash("sha256")
        .update(`${scope}:${value}:${getSecret()}`)
        .digest("hex");

export const identifyChatCaller = (
    request: Request,
    userId?: string | null
): ChatAccess => {
    const ipKey = `ip:${hashKey("ip", getClientIp(request))}`;
    if (userId) {
        return {
            kind: "user",
            subjectKey: `user:${hashKey("user", userId)}`,
            ipKey,
        };
    }

    const existingGuestId = readGuestId(request);
    const guestId = existingGuestId || randomUUID();
    return {
        kind: "guest",
        subjectKey: `guest:${hashKey("guest", guestId)}`,
        ipKey,
        setCookie: existingGuestId ? undefined : createGuestCookie(guestId),
    };
};

const periodStart = (period: Period, now: Date) => {
    if (period === "minute") {
        return new Date(
            Date.UTC(
                now.getUTCFullYear(),
                now.getUTCMonth(),
                now.getUTCDate(),
                now.getUTCHours(),
                now.getUTCMinutes()
            )
        );
    }
    if (period === "day") {
        return new Date(
            Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
        );
    }
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
};

const retryAfterFor = (period: Period, now: Date) => {
    let end: Date;
    if (period === "minute") {
        end = new Date(periodStart(period, now).getTime() + 60_000);
    } else if (period === "day") {
        end = new Date(periodStart(period, now).getTime() + 86_400_000);
    } else {
        end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
    }
    return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
};

const incrementUsage = async (
    tx: Prisma.TransactionClient,
    key: string,
    period: Period,
    start: Date,
    limit: number
) => {
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${key}, ${period}, ${start}, 1, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET
            "count" = "ChatUsageBucket"."count" + 1,
            "updatedAt" = NOW()
        WHERE "ChatUsageBucket"."count" < ${limit}
        RETURNING "count"
    `;
    return rows.length > 0;
};

export const acquireChatAccess = async (access: ChatAccess) => {
    const now = new Date();
    const leaseId = randomUUID();
    const concurrentLimit =
        access.kind === "user"
            ? positiveInteger(process.env.CHAT_USER_CONCURRENT, 3)
            : positiveInteger(process.env.CHAT_GUEST_CONCURRENT, 3);
    const ipPerMinute = positiveInteger(process.env.CHAT_IP_PER_MINUTE, 40);

    await prisma.$transaction(async (tx) => {
        for (const rule of limitsFor(access.kind)) {
            const allowed = await incrementUsage(
                tx,
                access.subjectKey,
                rule.period,
                periodStart(rule.period, now),
                rule.limit
            );
            if (!allowed) {
                throw new ChatAccessError(
                    429,
                    "CHAT_QUOTA_EXCEEDED",
                    "Chat usage limit exceeded.",
                    retryAfterFor(rule.period, now)
                );
            }
        }

        const ipAllowed = await incrementUsage(
            tx,
            access.ipKey,
            "minute",
            periodStart("minute", now),
            ipPerMinute
        );
        if (!ipAllowed) {
            throw new ChatAccessError(
                429,
                "CHAT_RATE_LIMITED",
                "Too many chat requests.",
                retryAfterFor("minute", now)
            );
        }

        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${access.subjectKey}))`;
        await tx.$executeRaw`
            DELETE FROM "ChatRequestLease"
            WHERE "subjectKey" = ${access.subjectKey} AND "expiresAt" <= NOW()
        `;
        const activeRows = await tx.$queryRaw<Array<{ count: bigint }>>`
            SELECT COUNT(*)::bigint AS "count"
            FROM "ChatRequestLease"
            WHERE "subjectKey" = ${access.subjectKey}
        `;
        if (Number(activeRows[0]?.count || 0) >= concurrentLimit) {
            throw new ChatAccessError(
                429,
                "CHAT_CONCURRENCY_EXCEEDED",
                "Too many chats are running at once.",
                5
            );
        }

        await tx.$executeRaw`
            INSERT INTO "ChatRequestLease" ("id", "subjectKey", "expiresAt", "createdAt")
            VALUES (${leaseId}, ${access.subjectKey}, ${new Date(now.getTime() + 120_000)}, NOW())
        `;
    });

    return { leaseId, setCookie: access.setCookie };
};

export const releaseChatAccess = async (leaseId: string) => {
    try {
        await prisma.$executeRaw`
            DELETE FROM "ChatRequestLease" WHERE "id" = ${leaseId}
        `;
    } catch (error) {
        console.error("Failed to release chat request lease:", error);
    }
};

export const assertChatRequestSize = (request: Request) => {
    const contentLength = Number(request.headers.get("content-length"));
    if (
        Number.isFinite(contentLength) &&
        contentLength > CHAT_REQUEST_LIMITS.maxBodyBytes
    ) {
        throw new ChatAccessError(
            413,
            "CHAT_BODY_TOO_LARGE",
            "Chat request is too large."
        );
    }
};

export const readChatJsonBody = async (request: Request) => {
    if (!request.body) {
        throw new ChatAccessError(400, "INVALID_CHAT_REQUEST", "Invalid request.");
    }

    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let totalBytes = 0;
    let text = "";

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            totalBytes += value.byteLength;
            if (totalBytes > CHAT_REQUEST_LIMITS.maxBodyBytes) {
                await reader.cancel();
                throw new ChatAccessError(
                    413,
                    "CHAT_BODY_TOO_LARGE",
                    "Chat request is too large."
                );
            }
            text += decoder.decode(value, { stream: true });
        }
        text += decoder.decode();
    } finally {
        reader.releaseLock();
    }

    try {
        return JSON.parse(text) as unknown;
    } catch {
        throw new ChatAccessError(
            400,
            "INVALID_CHAT_JSON",
            "Invalid JSON request."
        );
    }
};

export const validateChatPayload = (body: unknown) => {
    if (!body || typeof body !== "object") {
        throw new ChatAccessError(400, "INVALID_CHAT_REQUEST", "Invalid request.");
    }

    const payload = body as { messages?: unknown; modelId?: unknown };
    if (
        !Array.isArray(payload.messages) ||
        payload.messages.length === 0 ||
        payload.messages.length > CHAT_REQUEST_LIMITS.maxMessages
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_CHAT_MESSAGES",
            "Invalid message count."
        );
    }
    if (
        payload.modelId !== undefined &&
        (typeof payload.modelId !== "string" || payload.modelId.length > 100)
    ) {
        throw new ChatAccessError(400, "INVALID_MODEL", "Invalid model.");
    }

    let totalCharacters = 0;
    for (const message of payload.messages) {
        if (!message || typeof message !== "object") {
            throw new ChatAccessError(400, "INVALID_CHAT_MESSAGE", "Invalid message.");
        }
        const candidate = message as {
            role?: unknown;
            content?: unknown;
            attachments?: unknown;
        };
        if (
            candidate.role !== "user" &&
            candidate.role !== "assistant" &&
            candidate.role !== "system"
        ) {
            throw new ChatAccessError(400, "INVALID_CHAT_ROLE", "Invalid role.");
        }
        if (
            typeof candidate.content !== "string" ||
            candidate.content.length > CHAT_REQUEST_LIMITS.maxMessageCharacters
        ) {
            throw new ChatAccessError(
                400,
                "INVALID_CHAT_CONTENT",
                "Invalid message content."
            );
        }
        totalCharacters += candidate.content.length;
        if (totalCharacters > CHAT_REQUEST_LIMITS.maxTotalCharacters) {
            throw new ChatAccessError(
                413,
                "CHAT_CONTENT_TOO_LARGE",
                "Chat history is too large."
            );
        }
        if (
            candidate.attachments !== undefined &&
            !Array.isArray(candidate.attachments)
        ) {
            throw new ChatAccessError(
                400,
                "INVALID_ATTACHMENTS",
                "Invalid attachments."
            );
        }
    }

    return payload as {
        messages: Array<{
            role: "user" | "assistant" | "system";
            content: string;
            attachments?: unknown[];
        }>;
        modelId?: string;
    };
};

export const chatErrorResponse = (error: unknown) => {
    if (!(error instanceof ChatAccessError)) return null;

    const headers = new Headers({ "Content-Type": "application/json" });
    if (error.retryAfter) {
        headers.set("Retry-After", String(error.retryAfter));
    }
    return new Response(
        JSON.stringify({ error: error.message, code: error.code }),
        { status: error.status, headers }
    );
};
