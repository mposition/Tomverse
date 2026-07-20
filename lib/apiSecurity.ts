import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getTrustedClientIp } from "@/lib/clientIp";

type ApiPeriod = "minute" | "day";

export class ApiSecurityError extends Error {
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

const secret = () => {
  if (!process.env.NEXTAUTH_SECRET) {
    throw new ApiSecurityError(
      503,
      "SECURITY_NOT_CONFIGURED",
      "API security is not configured."
    );
  }
  return process.env.NEXTAUTH_SECRET;
};

const hashKey = (...parts: string[]) =>
  createHash("sha256")
    .update(`${parts.join(":")}:${secret()}`)
    .digest("hex");

const periodStart = (period: ApiPeriod, now: Date) =>
  period === "minute"
    ? new Date(
        Date.UTC(
          now.getUTCFullYear(),
          now.getUTCMonth(),
          now.getUTCDate(),
          now.getUTCHours(),
          now.getUTCMinutes()
        )
      )
    : new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
      );

const retryAfter = (period: ApiPeriod, now: Date) => {
  const start = periodStart(period, now);
  const end = new Date(
    start.getTime() + (period === "minute" ? 60_000 : 86_400_000)
  );
  return Math.max(1, Math.ceil((end.getTime() - now.getTime()) / 1000));
};

const incrementBucket = async (
  tx: Prisma.TransactionClient,
  key: string,
  period: string,
  start: Date,
  amount: number,
  limit: number
) => {
  if (amount <= 0 || amount > limit) return false;
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

export async function consumeApiRateLimit(
  request: Request,
  userId: string,
  scope: string,
  limits: { minute: number; day: number }
) {
  const now = new Date();
  const userKey = `api:${hashKey(scope, "user", userId)}`;
  const clientIp = getTrustedClientIp(request);
  // A resolvable IP is checked as a secondary, coarser bucket on top of the
  // per-user one. When it's not resolvable (misconfigured trusted-proxy
  // header), skip that leg instead of keying it on the shared "unknown"
  // sentinel, which would collapse every caller across the deployment into
  // one bucket and let them throttle each other.
  const ipKey =
    clientIp === "unknown"
      ? null
      : `api:${hashKey(scope, "ip", clientIp)}`;

  await prisma.$transaction(async (tx) => {
    for (const period of ["minute", "day"] as const) {
      const start = periodStart(period, now);
      const allowed = await incrementBucket(
        tx,
        userKey,
        `api-${scope}-${period}`,
        start,
        1,
        limits[period]
      );
      const ipAllowed = ipKey
        ? await incrementBucket(
            tx,
            ipKey,
            `api-${scope}-${period}`,
            start,
            1,
            limits[period] * 3
          )
        : true;
      if (!allowed || !ipAllowed) {
        throw new ApiSecurityError(
          429,
          "API_RATE_LIMITED",
          "Too many requests.",
          retryAfter(period, now)
        );
      }
    }
  });
}

export async function reserveDailyUploadBytes(
  userId: string,
  bytes: number
) {
  const now = new Date();
  const limit = positiveInteger(
    process.env.API_UPLOAD_BYTES_PER_USER_PER_DAY,
    250 * 1024 * 1024
  );
  const allowed = await prisma.$transaction((tx) =>
    incrementBucket(
      tx,
      `upload:${hashKey("upload", userId)}`,
      "api-upload-bytes-day",
      periodStart("day", now),
      bytes,
      limit
    )
  );
  if (!allowed) {
    throw new ApiSecurityError(
      429,
      "UPLOAD_STORAGE_QUOTA_EXCEEDED",
      "Daily attachment storage quota exceeded.",
      retryAfter("day", now)
    );
  }
}

export async function readLimitedJson<T>(
  request: Request,
  maxBytes: number,
  schema: z.ZodType<T>
): Promise<T> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new ApiSecurityError(
      413,
      "REQUEST_BODY_TOO_LARGE",
      "Request body is too large."
    );
  }
  if (!request.body) {
    throw new ApiSecurityError(400, "INVALID_JSON", "Invalid JSON request.");
  }

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) {
        await reader.cancel();
        throw new ApiSecurityError(
          413,
          "REQUEST_BODY_TOO_LARGE",
          "Request body is too large."
        );
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } finally {
    reader.releaseLock();
  }

  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiSecurityError(400, "INVALID_JSON", "Invalid JSON request.");
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ApiSecurityError(
      400,
      "INVALID_REQUEST",
      "Invalid request payload."
    );
  }
  return parsed.data;
}

export const STORAGE_LIMITS = {
  conversationsPerUser: () =>
    positiveInteger(process.env.API_MAX_CONVERSATIONS_PER_USER, 500),
  messagesPerConversation: () =>
    positiveInteger(process.env.API_MAX_MESSAGES_PER_CONVERSATION, 10_000),
  messagesPerUser: () =>
    positiveInteger(process.env.API_MAX_MESSAGES_PER_USER, 100_000),
  messageBytesPerUser: () =>
    positiveInteger(
      process.env.API_MAX_MESSAGE_BYTES_PER_USER,
      50 * 1024 * 1024
    ),
};

export async function assertConversationCapacity(
  tx: Prisma.TransactionClient,
  userId: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"conversation:" + userId}))`;
  const count = await tx.conversation.count({ where: { userId } });
  if (count >= STORAGE_LIMITS.conversationsPerUser()) {
    throw new ApiSecurityError(
      409,
      "CONVERSATION_STORAGE_QUOTA_EXCEEDED",
      "Conversation storage quota exceeded."
    );
  }
}

export async function assertMessageCapacity(
  tx: Prisma.TransactionClient,
  userId: string,
  conversationId: string,
  newMessageCount: number,
  newContentBytes: number
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"messages:" + userId}))`;
  const [conversationCount, totals] = await Promise.all([
    tx.message.count({ where: { conversationId } }),
    tx.$queryRaw<Array<{ count: bigint; bytes: bigint }>>`
      SELECT
        COUNT(m.id)::bigint AS "count",
        COALESCE(SUM(octet_length(m.content)), 0)::bigint AS "bytes"
      FROM "Message" m
      INNER JOIN "Conversation" c ON c.id = m."conversationId"
      WHERE c."userId" = ${userId}
    `,
  ]);
  const userCount = Number(totals[0]?.count || 0);
  const userBytes = Number(totals[0]?.bytes || 0);

  if (
    conversationCount + newMessageCount >
      STORAGE_LIMITS.messagesPerConversation() ||
    userCount + newMessageCount > STORAGE_LIMITS.messagesPerUser() ||
    userBytes + newContentBytes > STORAGE_LIMITS.messageBytesPerUser()
  ) {
    throw new ApiSecurityError(
      409,
      "MESSAGE_STORAGE_QUOTA_EXCEEDED",
      "Message storage quota exceeded."
    );
  }
}

export function apiSecurityResponse(error: unknown) {
  if (!(error instanceof ApiSecurityError)) return null;
  const headers = new Headers({ "Content-Type": "application/json" });
  if (error.retryAfter) headers.set("Retry-After", String(error.retryAfter));
  return new Response(
    JSON.stringify({ error: error.message, code: error.code }),
    { status: error.status, headers }
  );
}
