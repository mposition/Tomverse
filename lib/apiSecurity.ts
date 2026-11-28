import "server-only";

import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { getTrustedClientIp } from "@/lib/clientIp";
import {
  DATABASE_RETRY_AFTER_SECONDS,
  DATABASE_TEMPORARILY_UNAVAILABLE_CODE,
  isRetryableDatabaseError,
} from "@/lib/databaseError";

type ApiPeriod = "minute" | "day";

/*
  The per-IP leg of consumeApiRateLimit, on top of the per-subject bucket.

  The subject bucket is the accountable limit; the IP leg is only an aggregate
  abuse ceiling, and follows the principle of the chat concurrency plan
  (docs/policy/chat-concurrency-and-identity.md section 2, 3.2):

    * Anonymous subjects (guest cookie, anonymous client key, pre-auth routes)
      keep the original 3x ceiling for the minute and the day bucket. A guest
      can mint a new subject by clearing a cookie, so the IP leg is the only
      thing that bounds them.
    * A signed-in subject gets a per-minute ceiling of 8x (the chat IP
      concurrency multiple) and no per-day IP bucket: people behind one NAT are
      separate accounts with separate allowances, and a shared 3x bucket made
      colleagues throttle each other.

  Classification is positive: only the shape of a real user id (Prisma cuid) or
  the `user:` chat usage key counts as signed in. A raw IP, `guest:...`,
  `anonymous:...` or any unknown value keeps the stricter ceiling, so a caller
  nobody classified fails closed.

  Kept in this file on purpose: it is part of the Prompt Refiner runtime source
  closure, whose file list is pinned in a migration; a helper module would add
  files to it.
*/
export const ANONYMOUS_IP_LIMIT_MULTIPLIER = 3;
export const SIGNED_IN_IP_MINUTE_LIMIT_MULTIPLIER = 8;
const USER_ID_PATTERN = /^c[a-z0-9]{24}$/;
const USER_USAGE_KEY_PATTERN = /^user:[0-9a-f]{64}$/;

export const isSignedInRateLimitSubject = (subject: string): boolean =>
  USER_ID_PATTERN.test(subject) || USER_USAGE_KEY_PATTERN.test(subject);

/** The limit of the per-IP bucket for one period, or null when this subject has none. */
export const ipBucketLimit = (
  subject: string,
  period: ApiPeriod,
  subjectLimit: number
): number | null => {
  if (!isSignedInRateLimitSubject(subject)) {
    return subjectLimit * ANONYMOUS_IP_LIMIT_MULTIPLIER;
  }
  return period === "minute"
    ? subjectLimit * SIGNED_IN_IP_MINUTE_LIMIT_MULTIPLIER
    : null;
};

/** Pause before the single in-process retry of a transient database error. */
const RATE_LIMIT_DATABASE_RETRY_DELAY_MS = 200;

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
  limits: { minute: number; day: number },
  options: {
    /**
     * Skip the per-IP leg. Only for a subject key that is not the caller's
     * address: a valid unsubscribe token is keyed on what it acts on, and many
     * recipients behind one corporate NAT, or one mail provider's one-click
     * fetcher, must not throttle each other.
     */
    skipIpBucket?: boolean;
  } = {}
) {
  const now = new Date();
  const userKey = `api:${hashKey(scope, "user", userId)}`;
  const clientIp = options.skipIpBucket ? "unknown" : getTrustedClientIp(request);
  // A resolvable IP is checked as a secondary, coarser bucket on top of the
  // per-user one. When it's not resolvable (misconfigured trusted-proxy
  // header), skip that leg instead of keying it on the shared "unknown"
  // sentinel, which would collapse every caller across the deployment into
  // one bucket and let them throttle each other.
  const ipKey =
    clientIp === "unknown"
      ? null
      : `api:${hashKey(scope, "ip", clientIp)}`;

  const consume = () =>
    prisma.$transaction(async (tx) => {
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
        // The IP leg is an aggregate abuse ceiling, not the accountable limit:
        // signed-in subjects get a wide per-minute ceiling and no per-day IP
        // bucket (see ipBucketLimit above); anonymous subjects keep 3x.
        const ipLimit = ipKey ? ipBucketLimit(userId, period, limits[period]) : null;
        const ipAllowed =
          ipKey && ipLimit !== null
            ? await incrementBucket(
                tx,
                ipKey,
                `api-${scope}-${period}`,
                start,
                1,
                ipLimit
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

  /*
    One transient database error is absorbed, a second one is answered as
    503 + Retry-After instead of each route's generic 500.

    The increments are one interactive transaction, so a failed attempt rolls
    every bucket back and the retry cannot count a request twice. The single
    residue is a COMMIT that succeeded while its acknowledgement was lost: that
    leaves one extra unit in a per-minute rate bucket (never a credit, never a
    reservation), which is the price of not refusing the request.

    A 429 is the limiter working, not a database failure, and is rethrown as is.
  */
  try {
    await consume();
  } catch (error) {
    if (error instanceof ApiSecurityError || !isRetryableDatabaseError(error)) {
      throw error;
    }
    await new Promise((resolve) => setTimeout(resolve, RATE_LIMIT_DATABASE_RETRY_DELAY_MS));
    try {
      await consume();
    } catch (retryError) {
      if (
        retryError instanceof ApiSecurityError ||
        !isRetryableDatabaseError(retryError)
      ) {
        throw retryError;
      }
      throw new ApiSecurityError(
        503,
        DATABASE_TEMPORARILY_UNAVAILABLE_CODE,
        "The service is temporarily unavailable. Please try again shortly.",
        DATABASE_RETRY_AFTER_SECONDS
      );
    }
  }
}

// Gives back one unit of a per-user rate-limit bucket consumed earlier by
// consumeApiRateLimit, floored at zero. Intended for cases where the action
// that consumed the quota turned out to be legitimate (e.g. a login code
// request that was actually used to sign in), so repeated genuine use isn't
// penalized the same as abandoned/abusive requests. Only releases the
// per-user bucket, not the coarser per-IP one.
export async function releaseApiRateLimit(
  userId: string,
  scope: string,
  period: ApiPeriod
) {
  const start = periodStart(period, new Date());
  const key = `api:${hashKey(scope, "user", userId)}`;
  await prisma.$executeRaw`
    UPDATE "ChatUsageBucket"
    SET "count" = GREATEST("count" - 1, 0), "updatedAt" = NOW()
    WHERE "key" = ${key} AND "period" = ${`api-${scope}-${period}`} AND "periodStart" = ${start}
  `;
}

export async function reserveDailyUploadBytes(
  userId: string,
  bytes: number,
  // Guests upload against a far smaller daily budget than an account does,
  // and pass their own subject key as the bucket owner. The default stays
  // exactly what it was for every existing caller.
  limitOverride?: number
) {
  const now = new Date();
  const limit =
    limitOverride && Number.isSafeInteger(limitOverride) && limitOverride > 0
      ? limitOverride
      : positiveInteger(
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

export async function readLimitedText(
  request: Request,
  maxBytes: number
): Promise<string> {
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

  return text;
}

export async function readLimitedJson<T>(
  request: Request,
  maxBytes: number,
  schema: z.ZodType<T>
): Promise<T> {
  const text = await readLimitedText(request, maxBytes);
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

/**
 * The conversations a person can see in their list, as a filter (the owner's id
 * is added by the caller). A Studio tool run and a temporary Chat are not
 * listed, so they are not counted: a quota that counted rows the list hides
 * would report "full" to a person looking at a list with room in it.
 *
 * The same condition as the list route's `NOT: STUDIO_RUN_CONVERSATION,
 * temporaryExpiresAt: null` (lib/conversationProduct.ts). Written out here
 * because this file is in the Prompt Refiner runtime source closure and cannot
 * take a new import; tests/server-contract/conversation-capacity-listed.test.mjs
 * pins the two to the same value.
 */
export const LISTED_CONVERSATION_WHERE = {
  NOT: { kind: "image", messages: { some: {} } },
  temporaryExpiresAt: null,
} as const;

export async function assertConversationCapacity(
  tx: Prisma.TransactionClient,
  userId: string
) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${"conversation:" + userId}))`;
  // The conversations the person can see in their list, not every row they own:
  // Studio tool runs and temporary Chats are hidden and swept or one-off, and
  // counting them made a full-looking quota that the person could not clear.
  const count = await tx.conversation.count({
    where: { userId, ...LISTED_CONVERSATION_WHERE },
  });
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
