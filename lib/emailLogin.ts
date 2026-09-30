import "server-only";

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { ApiSecurityError, consumeApiRateLimit, releaseApiRateLimit } from "@/lib/apiSecurity";
import { verifyGuestTurnstile } from "@/lib/turnstile";
import { ChatAccessError } from "@/lib/chatSecurity";
import { logSecurityAuditEvent } from "@/lib/securityAudit";
import { buildEmailLoginCodeEmail } from "@/lib/emailLoginEmails";
import { isLanguage } from "@/lib/language";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  createCredentialDeliveryRows,
  sendCredentialEmailNow,
} from "@/lib/credentialEmailLane";
import { AUTH_LOGIN_CODE_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";

const CODE_TTL_MINUTES = clamp(Number(process.env.EMAIL_LOGIN_CODE_TTL_MINUTES) || 10, 1, 10);
const LOCKOUT_THRESHOLD = clamp(Number(process.env.EMAIL_LOGIN_LOCKOUT_THRESHOLD) || 5, 3, 20);
const LOCKOUT_WINDOW_MS =
  clamp(Number(process.env.EMAIL_LOGIN_LOCKOUT_WINDOW_MINUTES) || 30, 5, 240) * 60_000;
const TURNSTILE_CHALLENGE_THRESHOLD = clamp(
  Number(process.env.EMAIL_LOGIN_TURNSTILE_THRESHOLD) || 3,
  1,
  50
);
// Requests per email per day. Successful sign-ins release their unit back
// (see releaseApiRateLimit calls below), so this mainly bounds abandoned or
// abusive requests rather than genuine repeated logins.
const DAILY_REQUEST_LIMIT = clamp(
  Number(process.env.EMAIL_LOGIN_DAILY_REQUEST_LIMIT) || 12,
  3,
  50
);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export class EmailLoginError extends Error {
  constructor(
    public readonly code:
      | "TURNSTILE_REQUIRED"
      | "TURNSTILE_FAILED"
      | "TURNSTILE_UNAVAILABLE"
      | "RATE_LIMITED_MINUTE"
      | "RATE_LIMITED_DAY",
    message: string,
    public readonly retryAfter?: number
  ) {
    super(message);
  }
}

const secret = () => {
  const value = process.env.NEXTAUTH_SECRET;
  if (!value) throw new Error("NEXTAUTH_SECRET is not configured.");
  return value;
};

const hmacHex = (namespace: string, value: string) =>
  createHmac("sha256", secret()).update(`email-login:${namespace}:${value}`).digest("hex");

const bucketKeyHash = (namespace: string, value: string) =>
  createHash("sha256").update(`email-login-bucket:${namespace}:${value}:${secret()}`).digest("hex");

export function normalizeEmailLoginAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

// Soft counter (never blocks): used only to decide when to start requiring a
// Turnstile challenge. Always increments and returns the new count.
const incrementSoftCounter = async (key: string, period: string, start: Date) => {
  const rows = await prisma.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, ${period}, ${start}, 1, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + 1,
      "updatedAt" = NOW()
    RETURNING "count"
  `;
  return rows[0]?.count ?? 1;
};

// Failure-lockout counter: atomically increments only while under the
// threshold (same race-free pattern as consumeLockVerificationAttempt in
// lib/conversationLock.ts). Returns false once the threshold is already
// reached, without incrementing further. Deliberately NOT reset by issuing a
// new code -- only clearLockoutBucket (on a successful verify) or the fixed
// window rolling over ever clears it.
const incrementLockoutBucket = async (
  tx: Prisma.TransactionClient,
  key: string,
  start: Date
) => {
  const rows = await tx.$queryRaw<Array<{ count: number }>>`
    INSERT INTO "ChatUsageBucket" ("key", "period", "periodStart", "count", "updatedAt")
    VALUES (${key}, 'email-otp-lock', ${start}, 1, NOW())
    ON CONFLICT ("key", "period", "periodStart")
    DO UPDATE SET
      "count" = "ChatUsageBucket"."count" + 1,
      "updatedAt" = NOW()
    WHERE "ChatUsageBucket"."count" < ${LOCKOUT_THRESHOLD}
    RETURNING "count"
  `;
  return rows.length > 0;
};

const clearLockoutBucket = async (key: string, start: Date) => {
  await prisma.$executeRaw`
    DELETE FROM "ChatUsageBucket"
    WHERE "period" = 'email-otp-lock' AND "periodStart" = ${start} AND "key" = ${key}
  `;
};

const lockoutWindowStart = (now: Date) =>
  new Date(Math.floor(now.getTime() / LOCKOUT_WINDOW_MS) * LOCKOUT_WINDOW_MS);

// Called once mailbox control for `email` has actually been proven (code or
// link consumed successfully), so this day's daily-request quota isn't
// spent by a login the owner completed -- only by requests that were never
// followed through.
const releaseEmailRequestQuota = (email: string) =>
  releaseApiRateLimit(`email-otp:${email}`, "email-otp-request", "day");

/**
 * The language this message renders in.
 *
 * `Accept-Language` rather than `UserSettings.language`, because at request
 * time there may be no account to have a setting -- the response is deliberately
 * identical whether or not the address is registered, so looking one up here
 * would make this the one place that knows.
 */
const requestLanguage = (request: Request) => {
  const header = request.headers.get("accept-language") || "";
  const first = header.split(",")[0]?.trim().split("-")[0]?.toLowerCase() || "";
  return isLanguage(first) ? first : "en";
};

export type EmailLoginRequestResult =
  | { ok: true; delivered: true }
  /**
   * Stored, attempted, and not delivered.
   *
   * Reported rather than swallowed. The uniform-response rule exists so that
   * this endpoint cannot be used to test whether an address has an account, and
   * a provider outage says nothing about that -- it fails identically for a
   * registered address and an unregistered one. Answering `ok` here and leaving
   * someone in front of "check your email" is the worse outcome: nothing is
   * coming, and the screen has told them to wait for it.
   */
  | {
      ok: true;
      delivered: false;
      reason: "send_failed" | "credential_expired" | "suppressed";
    };

export async function requestEmailLoginCode(
  request: Request,
  rawEmail: string,
  turnstileToken: string | undefined
): Promise<EmailLoginRequestResult> {
  const email = normalizeEmailLoginAddress(rawEmail);

  const anonymousKey = getAnonymousClientKey(request);
  try {
    // 2 per minute, not 1: once challengeCount exceeds
    // TURNSTILE_CHALLENGE_THRESHOLD below, the caller's token-less probe and
    // its token-bearing retry are two calls to this same action within the
    // same minute. A limit of 1 would let the probe consume the only unit
    // and make every subsequent legitimate request fail with
    // API_RATE_LIMITED.
    await consumeApiRateLimit(request, `email-otp:${email}`, "email-otp-request", {
      minute: 2,
      day: DAILY_REQUEST_LIMIT,
    });
    await consumeApiRateLimit(request, `ip:${anonymousKey}`, "email-otp-request-ip", {
      minute: 5,
      day: 60,
    });
  } catch (error) {
    if (error instanceof ApiSecurityError && error.code === "API_RATE_LIMITED") {
      // consumeApiRateLimit doesn't itself distinguish which of the minute
      // or day bucket tripped, only how long until it clears. A day-bucket
      // retryAfter can occasionally be small too (near UTC midnight), so
      // this is a heuristic, not a guarantee -- the retryAfter value shown
      // to the user is correct either way, only the wording might say
      // "too many requests" instead of "daily limit" in that rare window.
      const code = (error.retryAfter ?? 0) <= 90 ? "RATE_LIMITED_MINUTE" : "RATE_LIMITED_DAY";
      throw new EmailLoginError(code, error.message, error.retryAfter);
    }
    throw error;
  }

  const now = new Date();
  const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const challengeCount = await incrementSoftCounter(
    bucketKeyHash("challenge", anonymousKey),
    "email-otp-challenge-day",
    dayStart
  );

  if (challengeCount > TURNSTILE_CHALLENGE_THRESHOLD) {
    try {
      await verifyGuestTurnstile(request, turnstileToken, "email_login_request");
    } catch (error) {
      if (error instanceof ChatAccessError) {
        if (error.code === "TURNSTILE_REQUIRED") {
          throw new EmailLoginError("TURNSTILE_REQUIRED", "Verification is required.");
        }
        if (error.code === "TURNSTILE_UNAVAILABLE" || error.code === "TURNSTILE_NOT_CONFIGURED") {
          throw new EmailLoginError(
            "TURNSTILE_UNAVAILABLE",
            "Verification is temporarily unavailable."
          );
        }
      }
      throw new EmailLoginError("TURNSTILE_FAILED", "Verification failed.");
    }
  }

  // Uniform response regardless of account existence: always generate, store,
  // and send -- never branch on whether prisma.user.findUnique would match.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const linkToken = randomBytes(32).toString("base64url");
  const codeHash = hmacHex("code", `${email}:${code}`);
  const linkTokenHash = hmacHex("link", linkToken);
  const expiresAt = new Date(now.getTime() + CODE_TTL_MINUTES * 60_000);

  const language = requestLanguage(request);
  const verifyUrl = `${getPublicAppOrigin(request)}/auth/email/verify?token=${linkToken}`;
  const message = buildEmailLoginCodeEmail({ code, verifyUrl, language });

  // Registered from the template with its variables still in place, never from
  // the rendered message: hashing a real login code would mint a fresh
  // TemplateVersion on every sign-in.
  const template = await ensureTemplateVersion({
    templateKey: AUTH_LOGIN_CODE_TEMPLATE,
    language,
  });
  const policyVersionId = await ensureBootstrapPolicyVersion();

  // One transaction, three rows (docs/policy/email-notifications.md §9.4a-3).
  // An attempt without a delivery row
  // would report a code nobody recorded trying to send; a delivery row without
  // an attempt would point at a credential that was never minted.
  const { attemptId, deliveryId, idempotencyKey } = await prisma.$transaction(
    async (tx) => {
      await tx.emailLoginAttempt.updateMany({
        where: { email, consumedAt: null, invalidatedAt: null },
        data: { invalidatedAt: now },
      });
      const attempt = await tx.emailLoginAttempt.create({
        data: { email, codeHash, linkTokenHash, expiresAt },
        select: { id: true },
      });
      const rows = await createCredentialDeliveryRows(tx, {
        attemptId: attempt.id,
        emailAddress: email,
        language,
        policyVersionId,
        templateVersionId: template.templateVersionId,
        templateId: template.templateId,
      });
      return { attemptId: attempt.id, ...rows };
    }
  );

  const result = await sendCredentialEmailNow({
    deliveryId,
    attemptId,
    to: email,
    ...message,
    idempotencyKey,
  });

  logSecurityAuditEvent("auth.email_code.request", {
    request,
    resourceId: email,
    outcome: result.sent ? "success" : "failure",
  });

  if (result.sent) return { ok: true, delivered: true };

  await reportOperationalIncident({
    code: "EMAIL_LOGIN_CODE_SEND_FAILED",
    title: "Failed to send email login code",
    error:
      result.reason === "credential_expired"
        ? "The login code expired before it could be sent"
        : result.reason === "suppressed"
          ? `Login code withheld: the address is suppressed (${result.skipReason})`
          : `Login code send failed: ${result.errorKind}`,
    severity: "warning",
    context: { component: "email-login", deliveryId },
  });

  return { ok: true, delivered: false, reason: result.reason };
}

/**
 * What the flow that proved the address meant to do with it
 * (docs/policy/email-product-news-redesign-draft.md section 5.2a).
 *
 * `signin` never creates an account: a proven address with no account becomes
 * a one-time sign-up hold on the same row, and the sign-in answers
 * `account_not_found`. `signup` creates one when the address has none, and may
 * spend such a hold. The intent is a product signal, not a security boundary --
 * a forged `signup` gets an account made without the consent devices, which
 * the in-product notice later asks about.
 */
export type EmailLoginIntent = "signin" | "signup";

export const parseEmailLoginIntent = (value: unknown): EmailLoginIntent =>
  value === "signup" ? "signup" : "signin";

export type EmailLoginVerifyResult =
  | {
      ok: true;
      userId: string;
      email: string;
      isNewUser: boolean;
      /** The login row this sign-in spent; a sign-up's consent binds to it. */
      emailLoginAttemptId: string;
    }
  | { ok: false; reason: "invalid_or_expired" | "locked" | "account_not_found" };

/**
 * The database's clock, in the naive-UTC form the timestamp columns store.
 *
 * A sign-up's consent attempt is stamped with `LOCALTIMESTAMP(3)`
 * (lib/signupConsent.ts), and finalize compares it with the moment this row was
 * spent for that sign-up. Stamping the row with this process's clock would
 * compare two clocks, and an instance running behind would refuse the very
 * sign-up it just completed.
 */
const databaseNow = async (): Promise<Date> => {
  const [row] = await prisma.$queryRaw<{ now: Date }[]>`SELECT LOCALTIMESTAMP(3) AS "now"`;
  if (!row) throw new Error("The database did not report its clock.");
  return row.now;
};

/** A row whose code or link matched, before anything is written. */
type MatchedAttempt = { id: string; expiresAt: Date; consumedAt: Date | null };

type MatchResult =
  | {
      ok: true;
      attempt: MatchedAttempt;
      /** Clears what a successful proof clears: the lockout and the request quota. */
      settle: () => Promise<void>;
    }
  | { ok: false; reason: "invalid_or_expired" | "locked" };

/** A consumed row whose one sign-up has not happened yet and has not expired. */
const liveHoldWhere = (now: Date) => ({
  consumedAt: { not: null },
  signupHoldUntil: { gt: now },
  signupHoldUsedAt: null,
});

/**
 * Spends a matched row in one compare-and-set UPDATE: an unconsumed row by
 * consuming it -- and, with `holdUntil`, turning it into a sign-up hold in the
 * same statement -- or a held row by using its hold. Two requests with the
 * same code cannot both succeed, and a sign-in that found no account can never
 * leave the code consumed without its hold.
 */
async function spendAttempt(
  attempt: MatchedAttempt,
  now: Date,
  options: { holdUntil?: Date } = {}
): Promise<boolean> {
  if (attempt.consumedAt === null) {
    const consumed = await prisma.emailLoginAttempt.updateMany({
      where: { id: attempt.id, consumedAt: null },
      data: {
        consumedAt: now,
        ...(options.holdUntil ? { signupHoldUntil: options.holdUntil } : {}),
      },
    });
    return consumed.count === 1;
  }
  if (options.holdUntil) return false;
  const used = await prisma.emailLoginAttempt.updateMany({
    where: { id: attempt.id, ...liveHoldWhere(now) },
    data: { signupHoldUsedAt: now },
  });
  return used.count === 1;
}

// Proves control of `email` via the 6-digit code -- rate limiting, persistent
// lockout, hash comparison -- and writes nothing to the row: the caller decides
// how it is spent, once it knows whether the address has an account.
//
// `allowHold` lets a sign-up match a code that a sign-in already proved and
// held (docs/policy/email-product-news-redesign-draft.md section 5.2a). Nothing
// else passes it, so a held code never signs in and never re-enables email
// login.
async function matchCodeForEmail(
  request: Request,
  email: string,
  code: string,
  options: { allowHold?: boolean } = {}
): Promise<MatchResult> {
  await consumeApiRateLimit(request, `email-otp-verify:${email}`, "email-otp-verify", {
    minute: 10,
    day: 40,
  });
  await consumeApiRateLimit(
    request,
    `ip:${getAnonymousClientKey(request)}`,
    "email-otp-verify-ip",
    { minute: 30, day: 200 }
  );

  const now = new Date();
  const windowStart = lockoutWindowStart(now);
  const lockoutKey = bucketKeyHash("lock", email);

  const allowed = await prisma.$transaction((tx) => incrementLockoutBucket(tx, lockoutKey, windowStart));
  if (!allowed) {
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      resourceId: email,
      outcome: "rate_limited",
      reason: "EMAIL_CODE_LOCKED",
    });
    return { ok: false, reason: "locked" };
  }

  const select = { id: true, codeHash: true, expiresAt: true, consumedAt: true } as const;
  const live = await prisma.emailLoginAttempt.findFirst({
    where: { email, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
    select,
  });
  const held = options.allowHold
    ? await prisma.emailLoginAttempt.findFirst({
        where: { email, invalidatedAt: null, ...liveHoldWhere(now) },
        orderBy: { createdAt: "desc" },
        select,
      })
    : null;

  const submittedHash = Buffer.from(hmacHex("code", `${email}:${code}`), "hex");
  const matches = (candidate: { codeHash: string } | null) => {
    if (!candidate) return false;
    const storedHash = Buffer.from(candidate.codeHash, "hex");
    return storedHash.length === submittedHash.length && timingSafeEqual(storedHash, submittedHash);
  };
  const attempt = matches(live) ? live : matches(held) ? held : null;

  if (!attempt) {
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      resourceId: email,
      outcome: "failure",
      reason: "EMAIL_CODE_INVALID",
    });
    return { ok: false, reason: "invalid_or_expired" };
  }

  return {
    ok: true,
    attempt: { id: attempt.id, expiresAt: attempt.expiresAt, consumedAt: attempt.consumedAt },
    settle: async () => {
      await clearLockoutBucket(lockoutKey, windowStart);
      await releaseEmailRequestQuota(email);
    },
  };
}

/**
 * The account half of a matched code or link
 * (docs/policy/email-product-news-redesign-draft.md section 5.2a):
 *
 * - an existing account signs in -- never through a held row, which exists
 *   only for a sign-up;
 * - a sign-up with no account creates one;
 * - a sign-in with no account consumes the row into a one-time sign-up hold
 *   in one UPDATE and answers `account_not_found`.
 *
 * Accounts that have explicitly disabled the email login method (see DELETE
 * /api/user/login-methods) must not be signable-in via a fresh code/link even
 * if one was somehow generated for their address -- otherwise "remove email
 * login" wouldn't actually remove it as a working credential. Their row is
 * consumed, as it always was, and the answer is `invalid_or_expired`.
 */
async function completeVerifiedEmail(
  request: Request,
  email: string,
  matched: Extract<MatchResult, { ok: true }>,
  intent: EmailLoginIntent
): Promise<EmailLoginVerifyResult> {
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true, emailLoginEnabled: true },
  });
  const viaHold = matched.attempt.consumedAt !== null;
  const now = await databaseNow();

  if (!existing && intent !== "signup") {
    const holdUntil = matched.attempt.expiresAt > now ? matched.attempt.expiresAt : now;
    if (!(await spendAttempt(matched.attempt, now, { holdUntil }))) {
      return { ok: false, reason: "invalid_or_expired" };
    }
    await matched.settle();
    // Proven, and no account: the only person told is the one who just proved
    // the address. The row is consumed for sign-in and held for one sign-up.
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      resourceId: email,
      outcome: "denied",
      reason: "EMAIL_ACCOUNT_NOT_FOUND",
    });
    return { ok: false, reason: "account_not_found" };
  }

  // A hold completes a sign-up and nothing else. If an account has appeared
  // at the address since, it is signed into by a fresh code, not by this row.
  if (existing && viaHold) return { ok: false, reason: "invalid_or_expired" };

  if (!(await spendAttempt(matched.attempt, now))) {
    return { ok: false, reason: "invalid_or_expired" };
  }
  await matched.settle();

  let userId: string;
  let isNewUser: boolean;
  if (existing) {
    if (!existing.emailLoginEnabled) {
      logSecurityAuditEvent("auth.email_code.verify", {
        request,
        resourceId: email,
        outcome: "denied",
        reason: "EMAIL_LOGIN_DISABLED",
      });
      return { ok: false, reason: "invalid_or_expired" };
    }
    if (!existing.emailVerified) {
      await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: new Date() } });
    }
    userId = existing.id;
    isNewUser = false;
  } else {
    const created = await prisma.user.create({
      data: { email, emailVerified: new Date() },
      select: { id: true },
    });
    logSecurityAuditEvent("auth.create_user", { userId: created.id });
    userId = created.id;
    isNewUser = true;
  }

  logSecurityAuditEvent("auth.email_code.verify", {
    request,
    userId,
    resourceId: email,
    outcome: "success",
    isNewUser,
  });
  return { ok: true, userId, email, isNewUser, emailLoginAttemptId: matched.attempt.id };
}

export async function verifyEmailLoginCode(
  request: Request,
  rawEmail: string,
  code: string,
  intent: EmailLoginIntent = "signin"
): Promise<EmailLoginVerifyResult> {
  const email = normalizeEmailLoginAddress(rawEmail);
  const matched = await matchCodeForEmail(request, email, code, {
    allowHold: intent === "signup",
  });
  if (!matched.ok) return matched;
  return completeVerifiedEmail(request, email, matched, intent);
}

// Used by the authenticated "(re-)enable email login for my own account"
// flow (POST /api/user/login-methods/email/verify): the caller already knows
// the userId from its own session and only needs proof of mailbox control,
// not account lookup/creation or an emailLoginEnabled gate (flipping that
// flag back on is the entire point of this call). A held row is never
// matched here.
export async function verifyEmailLoginCodeForOwnAccount(
  request: Request,
  rawEmail: string,
  code: string
): Promise<{ ok: true } | { ok: false; reason: "invalid_or_expired" | "locked" }> {
  const email = normalizeEmailLoginAddress(rawEmail);
  const matched = await matchCodeForEmail(request, email, code);
  if (!matched.ok) return matched;
  if (!(await spendAttempt(matched.attempt, new Date()))) {
    return { ok: false, reason: "invalid_or_expired" };
  }
  await matched.settle();
  return { ok: true };
}

export async function verifyEmailLoginLink(
  request: Request,
  rawLinkToken: string,
  intent: EmailLoginIntent = "signin"
): Promise<EmailLoginVerifyResult> {
  await consumeApiRateLimit(
    request,
    `ip:${getAnonymousClientKey(request)}`,
    "email-otp-verify-link-ip",
    { minute: 30, day: 200 }
  );

  const linkTokenHash = hmacHex("link", rawLinkToken);
  const now = new Date();
  const select = { id: true, email: true, expiresAt: true, consumedAt: true } as const;
  const attempt =
    (await prisma.emailLoginAttempt.findFirst({
      where: { linkTokenHash, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
      select,
    })) ??
    (intent === "signup"
      ? await prisma.emailLoginAttempt.findFirst({
          where: { linkTokenHash, invalidatedAt: null, ...liveHoldWhere(now) },
          select,
        })
      : null);
  if (!attempt) {
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      outcome: "failure",
      reason: "EMAIL_CODE_INVALID",
    });
    return { ok: false, reason: "invalid_or_expired" };
  }

  return completeVerifiedEmail(
    request,
    attempt.email,
    {
      ok: true,
      attempt: { id: attempt.id, expiresAt: attempt.expiresAt, consumedAt: attempt.consumedAt },
      // A link never counted toward the code lockout, so there is none to clear.
      settle: () => releaseEmailRequestQuota(attempt.email),
    },
    intent
  );
}

/**
 * The address a held link was sent to, for the verify page's sign-up step.
 *
 * The page has only the link token, and the consent choice it is about to
 * store is bound to an address. Answering needs the token and a live hold, so
 * only the person who opened the link -- and was just told there is no
 * account -- learns the address the link was already sent to.
 */
export async function heldSignupAddressForLink(rawLinkToken: string): Promise<string | null> {
  const held = await prisma.emailLoginAttempt.findFirst({
    where: {
      linkTokenHash: hmacHex("link", rawLinkToken),
      invalidatedAt: null,
      ...liveHoldWhere(new Date()),
    },
    select: { email: true },
  });
  return held?.email ?? null;
}
