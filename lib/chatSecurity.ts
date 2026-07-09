import "server-only";

import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
    getModelBillingProfile,
    type AiModel,
    type ModelTier,
} from "@/lib/models";

const GUEST_COOKIE_NAME = "tomverse_guest";
const GUEST_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const CHAT_REQUEST_LIMITS = {
    maxBodyBytes: 2 * 1024 * 1024,
    maxMessages: 100,
    maxMessageCharacters: 50_000,
    maxTotalCharacters: 300_000,
} as const;

export type AccessKind = "user" | "guest";
type Period = "minute" | "day" | "month";
type LimitRule = { period: Period; limit: number };
export type ChatAccess = {
    kind: AccessKind;
    subjectKey: string;
    ipKey: string;
    setCookie?: string;
};

export type ChatBudget = {
    inputTokens: number;
    maxOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
    provider: AiModel["provider"];
};

type ReservationEntry = {
    key: string;
    period: string;
    periodStart: Date;
    amount: number;
    metric: "tokens" | "cost";
};

export type ChatUsageReservation = {
    entries: ReservationEntry[];
    inputTokens: number;
    maxOutputTokens: number;
    inputUsdPerMillionTokens: number;
    outputUsdPerMillionTokens: number;
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

const TIER_RANK: Record<ModelTier, number> = {
    Free: 0,
    Pro: 1,
    Max: 2,
};

const configuredTier = (
    value: string | undefined,
    fallback: ModelTier
): ModelTier =>
    value === "Free" || value === "Pro" || value === "Max"
        ? value
        : fallback;

export const assertModelAccess = (kind: AccessKind, model: AiModel) => {
    const maximumTier =
        kind === "guest"
            ? configuredTier(process.env.CHAT_GUEST_MAX_TIER, "Free")
            : configuredTier(process.env.CHAT_USER_MAX_TIER, "Max");

    if (TIER_RANK[model.tier] > TIER_RANK[maximumTier]) {
        throw new ChatAccessError(
            403,
            "MODEL_TIER_FORBIDDEN",
            "This model is not available for your account."
        );
    }
};

const microdollarsFor = (tokens: number, usdPerMillionTokens: number) =>
    Math.ceil(tokens * usdPerMillionTokens);

export const createChatBudget = (
    kind: AccessKind,
    model: AiModel,
    estimatedInputTokens: number
): ChatBudget => {
    const profile = getModelBillingProfile(model);
    const maxInputTokens =
        kind === "guest"
            ? positiveInteger(process.env.CHAT_GUEST_MAX_INPUT_TOKENS, 16_000)
            : positiveInteger(process.env.CHAT_USER_MAX_INPUT_TOKENS, 128_000);

    if (
        !Number.isSafeInteger(estimatedInputTokens) ||
        estimatedInputTokens <= 0 ||
        estimatedInputTokens > maxInputTokens
    ) {
        throw new ChatAccessError(
            413,
            "CHAT_INPUT_TOKEN_LIMIT",
            "Chat context exceeds the allowed token budget."
        );
    }

    return {
        inputTokens: estimatedInputTokens,
        maxOutputTokens: profile.maxOutputTokens,
        inputUsdPerMillionTokens: profile.inputUsdPerMillionTokens,
        outputUsdPerMillionTokens: profile.outputUsdPerMillionTokens,
        provider: model.provider,
    };
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
    period: string,
    start: Date,
    limit: number,
    amount = 1
) => {
    if (!Number.isSafeInteger(amount) || amount <= 0 || amount > limit) {
        return false;
    }
    const rows = await tx.$queryRaw<Array<{ count: number }>>`
        INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
        VALUES (${key}, ${period}, ${start}, ${amount}, NOW())
        ON CONFLICT ("key", "period", "periodStart")
        DO UPDATE SET
            "count" = "ChatUsageBucket"."count" + ${amount},
            "updatedAt" = NOW()
        WHERE "ChatUsageBucket"."count" <= ${limit - amount}
        RETURNING "count"
    `;
    return rows.length > 0;
};

export const acquireChatAccess = async (
    access: ChatAccess,
    budget: ChatBudget
) => {
    const now = new Date();
    const leaseId = randomUUID();
    const reservationEntries: ReservationEntry[] = [];
    const concurrentLimit =
        access.kind === "user"
            ? positiveInteger(process.env.CHAT_USER_CONCURRENT, 3)
            : positiveInteger(process.env.CHAT_GUEST_CONCURRENT, 3);
    const ipPerMinute = positiveInteger(process.env.CHAT_IP_PER_MINUTE, 40);
    const reservedTokens = budget.inputTokens + budget.maxOutputTokens;
    const reservedCost =
        microdollarsFor(
            budget.inputTokens,
            budget.inputUsdPerMillionTokens
        ) +
        microdollarsFor(
            budget.maxOutputTokens,
            budget.outputUsdPerMillionTokens
        );
    const tokenLimits =
        access.kind === "user"
            ? [
                  {
                      period: "tokens-day",
                      start: periodStart("day", now),
                      limit: positiveInteger(
                          process.env.CHAT_USER_TOKENS_PER_DAY,
                          1_000_000
                      ),
                  },
                  {
                      period: "tokens-month",
                      start: periodStart("month", now),
                      limit: positiveInteger(
                          process.env.CHAT_USER_TOKENS_PER_MONTH,
                          20_000_000
                      ),
                  },
              ]
            : [
                  {
                      period: "tokens-day",
                      start: periodStart("day", now),
                      limit: positiveInteger(
                          process.env.CHAT_GUEST_TOKENS_PER_DAY,
                          40_000
                      ),
                  },
                  {
                      period: "tokens-month",
                      start: periodStart("month", now),
                      limit: positiveInteger(
                          process.env.CHAT_GUEST_TOKENS_PER_MONTH,
                          200_000
                      ),
                  },
              ];
    const costLimits =
        access.kind === "user"
            ? [
                  {
                      period: "cost-day",
                      start: periodStart("day", now),
                      limit: positiveInteger(
                          process.env.CHAT_USER_COST_MICROUSD_PER_DAY,
                          2_000_000
                      ),
                  },
                  {
                      period: "cost-month",
                      start: periodStart("month", now),
                      limit: positiveInteger(
                          process.env.CHAT_USER_COST_MICROUSD_PER_MONTH,
                          20_000_000
                      ),
                  },
              ]
            : [
                  {
                      period: "cost-day",
                      start: periodStart("day", now),
                      limit: positiveInteger(
                          process.env.CHAT_GUEST_COST_MICROUSD_PER_DAY,
                          20_000
                      ),
                  },
                  {
                      period: "cost-month",
                      start: periodStart("month", now),
                      limit: positiveInteger(
                          process.env.CHAT_GUEST_COST_MICROUSD_PER_MONTH,
                          100_000
                      ),
                  },
              ];
    const providerEnvKey = `CHAT_PROVIDER_${budget.provider.toUpperCase()}_COST_MICROUSD_PER_MONTH`;
    const providerLimit = positiveInteger(
        process.env[providerEnvKey],
        100_000_000
    );

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

        for (const rule of tokenLimits) {
            const allowed = await incrementUsage(
                tx,
                access.subjectKey,
                rule.period,
                rule.start,
                rule.limit,
                reservedTokens
            );
            if (!allowed) {
                throw new ChatAccessError(
                    429,
                    "CHAT_TOKEN_QUOTA_EXCEEDED",
                    "Chat token quota exceeded.",
                    retryAfterFor(
                        rule.period === "tokens-day" ? "day" : "month",
                        now
                    )
                );
            }
            reservationEntries.push({
                key: access.subjectKey,
                period: rule.period,
                periodStart: rule.start,
                amount: reservedTokens,
                metric: "tokens",
            });
        }

        for (const rule of costLimits) {
            const allowed = await incrementUsage(
                tx,
                access.subjectKey,
                rule.period,
                rule.start,
                rule.limit,
                reservedCost
            );
            if (!allowed) {
                throw new ChatAccessError(
                    429,
                    "CHAT_COST_QUOTA_EXCEEDED",
                    "Chat cost quota exceeded.",
                    retryAfterFor(
                        rule.period === "cost-day" ? "day" : "month",
                        now
                    )
                );
            }
            reservationEntries.push({
                key: access.subjectKey,
                period: rule.period,
                periodStart: rule.start,
                amount: reservedCost,
                metric: "cost",
            });
        }

        const providerKey = `provider:${budget.provider}`;
        const providerStart = periodStart("month", now);
        const providerAllowed = await incrementUsage(
            tx,
            providerKey,
            "provider-cost-month",
            providerStart,
            providerLimit,
            reservedCost
        );
        if (!providerAllowed) {
            throw new ChatAccessError(
                503,
                "PROVIDER_SPEND_LIMIT_REACHED",
                "This AI provider is temporarily unavailable."
            );
        }
        reservationEntries.push({
            key: providerKey,
            period: "provider-cost-month",
            periodStart: providerStart,
            amount: reservedCost,
            metric: "cost",
        });

        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${access.subjectKey}))`;
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

    return {
        leaseId,
        setCookie: access.setCookie,
        usageReservation: {
            entries: reservationEntries,
            inputTokens: budget.inputTokens,
            maxOutputTokens: budget.maxOutputTokens,
            inputUsdPerMillionTokens: budget.inputUsdPerMillionTokens,
            outputUsdPerMillionTokens: budget.outputUsdPerMillionTokens,
        } satisfies ChatUsageReservation,
    };
};

export const settleChatUsage = async (
    reservation: ChatUsageReservation,
    usage: { inputTokens?: number; outputTokens?: number }
) => {
    const actualInput = Number.isSafeInteger(usage.inputTokens)
        ? Math.max(0, usage.inputTokens!)
        : reservation.inputTokens;
    const actualOutput = Number.isSafeInteger(usage.outputTokens)
        ? Math.max(0, usage.outputTokens!)
        : reservation.maxOutputTokens;
    const actualTokens = actualInput + actualOutput;
    const actualCost =
        microdollarsFor(
            actualInput,
            reservation.inputUsdPerMillionTokens
        ) +
        microdollarsFor(
            actualOutput,
            reservation.outputUsdPerMillionTokens
        );

    await prisma.$transaction(
        reservation.entries.map((entry) => {
            const actual = entry.metric === "tokens" ? actualTokens : actualCost;
            const difference = actual - entry.amount;
            return prisma.chatUsageBucket.updateMany({
                where: {
                    key: entry.key,
                    period: entry.period,
                    periodStart: entry.periodStart,
                },
                data: {
                    count:
                        difference > 0
                            ? { increment: difference }
                            : { decrement: Math.abs(difference) },
                },
            });
        })
    );
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

    const payload = body as {
        messages?: unknown;
        modelId?: unknown;
        conversationId?: unknown;
        assistantMessageId?: unknown;
    };
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
    if (
        payload.conversationId !== undefined &&
        (typeof payload.conversationId !== "string" ||
            payload.conversationId.length < 1 ||
            payload.conversationId.length > 64 ||
            !/^[A-Za-z0-9_-]+$/.test(payload.conversationId))
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_CONVERSATION",
            "Invalid conversation."
        );
    }
    if (
        payload.assistantMessageId !== undefined &&
        (typeof payload.assistantMessageId !== "string" ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
                payload.assistantMessageId
            ))
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_MESSAGE_ID",
            "Invalid message ID."
        );
    }
    if (
        Boolean(payload.conversationId) !== Boolean(payload.assistantMessageId)
    ) {
        throw new ChatAccessError(
            400,
            "INVALID_PERSISTENCE_TARGET",
            "Incomplete persistence target."
        );
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
        conversationId?: string;
        assistantMessageId?: string;
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
