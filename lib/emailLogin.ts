import "server-only";

import { createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { getAnonymousClientKey } from "@/lib/clientIp";
import { getPublicAppOrigin } from "@/lib/publicUrl";
import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { verifyGuestTurnstile } from "@/lib/turnstile";
import { ChatAccessError } from "@/lib/chatSecurity";
import { logSecurityAuditEvent } from "@/lib/securityAudit";
import { sendEmailLoginCodeEmail } from "@/lib/emailLoginEmails";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";

const CODE_TTL_MINUTES = clamp(Number(process.env.EMAIL_LOGIN_CODE_TTL_MINUTES) || 10, 1, 10);
const LOCKOUT_THRESHOLD = clamp(Number(process.env.EMAIL_LOGIN_LOCKOUT_THRESHOLD) || 5, 3, 20);
const LOCKOUT_WINDOW_MS =
  clamp(Number(process.env.EMAIL_LOGIN_LOCKOUT_WINDOW_MINUTES) || 30, 5, 240) * 60_000;
const TURNSTILE_CHALLENGE_THRESHOLD = clamp(
  Number(process.env.EMAIL_LOGIN_TURNSTILE_THRESHOLD) || 3,
  1,
  50
);

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

export class EmailLoginError extends Error {
  constructor(
    public readonly code: "TURNSTILE_REQUIRED" | "TURNSTILE_FAILED",
    message: string
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

export async function requestEmailLoginCode(
  request: Request,
  rawEmail: string,
  turnstileToken: string | undefined
): Promise<{ ok: true }> {
  const email = normalizeEmailLoginAddress(rawEmail);

  await consumeApiRateLimit(request, `email-otp:${email}`, "email-otp-request", {
    minute: 1,
    day: 8,
  });
  const anonymousKey = getAnonymousClientKey(request);
  await consumeApiRateLimit(request, `ip:${anonymousKey}`, "email-otp-request-ip", {
    minute: 5,
    day: 60,
  });

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
      if (error instanceof ChatAccessError && error.code === "TURNSTILE_REQUIRED") {
        throw new EmailLoginError("TURNSTILE_REQUIRED", "Verification is required.");
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

  await prisma.$transaction([
    prisma.emailLoginAttempt.updateMany({
      where: { email, consumedAt: null, invalidatedAt: null },
      data: { invalidatedAt: now },
    }),
    prisma.emailLoginAttempt.create({
      data: { email, codeHash, linkTokenHash, expiresAt },
    }),
  ]);

  const verifyUrl = `${getPublicAppOrigin(request)}/auth/email/verify?token=${linkToken}`;
  try {
    await sendEmailLoginCodeEmail({ to: email, code, verifyUrl, language: request.headers.get("accept-language") });
  } catch (error) {
    await reportOperationalIncident({
      code: "EMAIL_LOGIN_CODE_SEND_FAILED",
      title: "Failed to send email login code",
      error,
      severity: "warning",
      context: { component: "email-login" },
    });
  }

  logSecurityAuditEvent("auth.email_code.request", {
    request,
    resourceId: email,
    outcome: "success",
  });

  return { ok: true };
}

export type EmailLoginVerifyResult =
  | { ok: true; userId: string; email: string; isNewUser: boolean }
  | { ok: false; reason: "invalid_or_expired" | "locked" };

type ResolveUserResult =
  | { ok: true; userId: string; isNewUser: boolean }
  | { ok: false };

// Existing accounts that have explicitly disabled the email login method
// (see DELETE /api/user/login-methods) must not be signable-in via a fresh
// code/link even if one was somehow generated for their address -- otherwise
// "remove email login" wouldn't actually remove it as a working credential.
async function resolveUserForVerifiedEmail(email: string): Promise<ResolveUserResult> {
  const existing = await prisma.user.findUnique({
    where: { email },
    select: { id: true, emailVerified: true, emailLoginEnabled: true },
  });
  if (existing) {
    if (!existing.emailLoginEnabled) {
      return { ok: false };
    }
    if (!existing.emailVerified) {
      await prisma.user.update({ where: { id: existing.id }, data: { emailVerified: new Date() } });
    }
    return { ok: true, userId: existing.id, isNewUser: false };
  }
  const created = await prisma.user.create({
    data: { email, emailVerified: new Date() },
    select: { id: true },
  });
  logSecurityAuditEvent("auth.create_user", { userId: created.id });
  return { ok: true, userId: created.id, isNewUser: true };
}

type CodeConsumeResult =
  | { ok: true }
  | { ok: false; reason: "invalid_or_expired" | "locked" };

// Just proves control of `email` via the 6-digit code -- rate limiting,
// persistent lockout, hash comparison, single-use consumption. Does NOT look
// up or create a User and does NOT care whether email login is currently
// enabled for that address: callers that are signing someone in (where the
// email may or may not already own an account) layer resolveUserForVerifiedEmail
// on top; callers that are re-enabling email login for an already-authenticated
// user (who by definition owns the account, and is proving mailbox control
// specifically to flip emailLoginEnabled back on) call this directly instead.
async function consumeCodeForEmail(
  request: Request,
  email: string,
  code: string
): Promise<CodeConsumeResult> {
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

  const attempt = await prisma.emailLoginAttempt.findFirst({
    where: { email, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });

  const submittedHash = Buffer.from(hmacHex("code", `${email}:${code}`), "hex");
  const matches =
    attempt &&
    (() => {
      const storedHash = Buffer.from(attempt.codeHash, "hex");
      return storedHash.length === submittedHash.length && timingSafeEqual(storedHash, submittedHash);
    })();

  if (!attempt || !matches) {
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      resourceId: email,
      outcome: "failure",
      reason: "EMAIL_CODE_INVALID",
    });
    return { ok: false, reason: "invalid_or_expired" };
  }

  const consumed = await prisma.emailLoginAttempt.updateMany({
    where: { id: attempt.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  await clearLockoutBucket(lockoutKey, windowStart);
  return { ok: true };
}

export async function verifyEmailLoginCode(
  request: Request,
  rawEmail: string,
  code: string
): Promise<EmailLoginVerifyResult> {
  const email = normalizeEmailLoginAddress(rawEmail);
  const consumeResult = await consumeCodeForEmail(request, email, code);
  if (!consumeResult.ok) return consumeResult;

  const resolved = await resolveUserForVerifiedEmail(email);
  if (!resolved.ok) {
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      resourceId: email,
      outcome: "denied",
      reason: "EMAIL_LOGIN_DISABLED",
    });
    return { ok: false, reason: "invalid_or_expired" };
  }
  logSecurityAuditEvent("auth.email_code.verify", {
    request,
    userId: resolved.userId,
    resourceId: email,
    outcome: "success",
    isNewUser: resolved.isNewUser,
  });
  return { ok: true, userId: resolved.userId, email, isNewUser: resolved.isNewUser };
}

// Used by the authenticated "(re-)enable email login for my own account"
// flow (POST /api/user/login-methods/email/verify): the caller already knows
// the userId from its own session and only needs proof of mailbox control,
// not account lookup/creation or an emailLoginEnabled gate (flipping that
// flag back on is the entire point of this call).
export async function verifyEmailLoginCodeForOwnAccount(
  request: Request,
  rawEmail: string,
  code: string
): Promise<CodeConsumeResult> {
  const email = normalizeEmailLoginAddress(rawEmail);
  return consumeCodeForEmail(request, email, code);
}

export async function verifyEmailLoginLink(
  request: Request,
  rawLinkToken: string
): Promise<EmailLoginVerifyResult> {
  await consumeApiRateLimit(
    request,
    `ip:${getAnonymousClientKey(request)}`,
    "email-otp-verify-link-ip",
    { minute: 30, day: 200 }
  );

  const linkTokenHash = hmacHex("link", rawLinkToken);
  const now = new Date();
  const attempt = await prisma.emailLoginAttempt.findFirst({
    where: { linkTokenHash, consumedAt: null, invalidatedAt: null, expiresAt: { gt: now } },
  });
  if (!attempt) {
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      outcome: "failure",
      reason: "EMAIL_CODE_INVALID",
    });
    return { ok: false, reason: "invalid_or_expired" };
  }

  const consumed = await prisma.emailLoginAttempt.updateMany({
    where: { id: attempt.id, consumedAt: null },
    data: { consumedAt: now },
  });
  if (consumed.count !== 1) {
    return { ok: false, reason: "invalid_or_expired" };
  }

  const resolved = await resolveUserForVerifiedEmail(attempt.email);
  if (!resolved.ok) {
    logSecurityAuditEvent("auth.email_code.verify", {
      request,
      resourceId: attempt.email,
      outcome: "denied",
      reason: "EMAIL_LOGIN_DISABLED",
    });
    return { ok: false, reason: "invalid_or_expired" };
  }
  logSecurityAuditEvent("auth.email_code.verify", {
    request,
    userId: resolved.userId,
    resourceId: attempt.email,
    outcome: "success",
    isNewUser: resolved.isNewUser,
  });
  return { ok: true, userId: resolved.userId, email: attempt.email, isNewUser: resolved.isNewUser };
}
