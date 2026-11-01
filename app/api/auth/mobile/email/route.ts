export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isValidLoginEmail, MAX_LOGIN_EMAIL_LENGTH } from "@/lib/emailValidation";
import { verifyEmailLoginCode } from "@/lib/emailLogin";
import { mobileAuthReady } from "@/lib/mobileAccessToken";
import { enforceMobileAuthAdmission, mobileApiSecurityResponse } from "@/lib/mobileAuthRoute";
import { issueMobileSession } from "@/lib/mobileAuthService";
import { MOBILE_DEVICE_PLATFORMS } from "@/lib/mobileAuthContract";
import { prisma } from "@/lib/prisma";
import { POST as requestExistingEmailCode } from "@/app/api/auth/email-login/request/route";
import { requestMobileStoreReviewCode, verifyMobileStoreReviewCode } from "@/lib/mobileStoreReview";
import { CURRENT_CONSENT_COPY_VERSION, CONSENT_COPY_LANGUAGES } from "@/lib/emailConsentCopy";
import { signupConsentAvailable, issueSignupConsentAttempt, finalizeSignupConsentAttempt } from "@/lib/signupConsent";
import { addressProofForSignIn } from "@/lib/emailPreferenceCore";

const email = z.string().trim().toLowerCase().max(MAX_LOGIN_EMAIL_LENGTH).refine(isValidLoginEmail);
const schema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("request"), email, turnstileToken: z.string().trim().min(1).max(2048).optional() }).strict(),
  z.object({ action: z.literal("verify"), email, code: z.string().regex(/^\d{6}$/), platform: z.enum(MOBILE_DEVICE_PLATFORMS), deviceLabel: z.string().trim().min(1).max(64).optional() }).strict(),
  z.object({ action: z.literal("signup"), email, code: z.string().regex(/^\d{6}$/), platform: z.enum(MOBILE_DEVICE_PLATFORMS), deviceLabel: z.string().trim().min(1).max(64).optional(), signupConsent: z.object({ shown: z.boolean(), optIn: z.boolean(), objected: z.boolean(), copyVersion: z.string().max(64), language: z.enum(CONSENT_COPY_LANGUAGES) }).strict() }).strict(),
]);
const reply = (body: object, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const ready = () => process.env.TOMVERSE_NATIVE_CHAT_ENABLED === "true" && mobileAuthReady();
const signupEnabled = () => process.env.TOMVERSE_NATIVE_EMAIL_SIGNUP_ENABLED === "true";

/** Public capability probe: never opens a missing browser page or sends mail. */
export async function GET(request: Request) {
  if (!ready()) return reply({ ok: false, code: "MOBILE_LOGIN_UNAVAILABLE" }, 503);
  return reply({ ok: true, emailCode: true, browserSignIn: true, ...(signupEnabled() ? { emailSignup: {
    consentEnabled: await signupConsentAvailable(request.headers.get("cf-ipcountry")), copyVersion: CURRENT_CONSENT_COPY_VERSION,
  } } : {}) });
}

/** Body proof only. No ambient session is accepted on this exact native path. */
export async function POST(request: Request) {
  try {
    if (!ready()) return reply({ ok: false, code: "MOBILE_LOGIN_UNAVAILABLE" }, 503);
    const origin = request.headers.get("origin");
    // Only the native HTTP clients consume token-bearing responses. Even an
    // allowed Capacitor WebView origin must never read a rotating credential.
    if (origin !== null) {
      return reply({ ok: false, code: "MOBILE_LOGIN_REFUSED" }, 403);
    }
    await enforceMobileAuthAdmission(request);
    const body = await readLimitedJson(request, 4096, schema);
    if (body.action === "request") {
      if (await requestMobileStoreReviewCode(request, body.email)) return reply({ ok: true });
      // Reuse delivery, uniform responses, per-address/IP limits and Turnstile.
      const input = { email: body.email, ...(body.turnstileToken ? { turnstileToken: body.turnstileToken } : {}) };
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      headers.delete("cookie");
      const response = await requestExistingEmailCode(new Request(request.url, {
        method: "POST", headers, body: JSON.stringify(input),
      }));
      response.headers.set("Cache-Control", "no-store");
      return response;
    }
    let signupAttempt: Awaited<ReturnType<typeof issueSignupConsentAttempt>> | null = null;
    if (body.action === "signup") {
      if (!signupEnabled()) return reply({ ok: false, code: "EMAIL_SIGNUP_UNAVAILABLE" }, 503);
      const choice = body.signupConsent;
      const shown = await signupConsentAvailable(request.headers.get("cf-ipcountry"));
      if (choice.copyVersion !== CURRENT_CONSENT_COPY_VERSION || choice.shown !== shown || (choice.optIn && choice.objected) || (!choice.shown && (choice.optIn || choice.objected))) {
        return reply({ ok: false, code: "EMAIL_SIGNUP_OPTIONS_CHANGED" }, 409);
      }
      if (shown) {
        signupAttempt = await issueSignupConsentAttempt({ channel: "email_code", email: body.email, expressOptInRequested: choice.optIn, objected: choice.objected, language: choice.language, ipCountry: request.headers.get("cf-ipcountry") });
        if (!signupAttempt.ok) return reply({ ok: false, code: "EMAIL_SIGNUP_OPTIONS_CHANGED" }, 409);
      }
    }
    // A signup is an explicit action after mailbox verification; the held code
    // can only create one new account. Store-review credentials never enter it.
    const signupProof = body.action === "signup" ? await verifyEmailLoginCode(request, body.email, body.code, "signup") : null;
    const proof = signupProof ?? await verifyMobileStoreReviewCode(request, { ...body, appId: request.headers.get("x-tomverse-app-id") ?? undefined, buildNumber: Number(request.headers.get("x-tomverse-build")) }) ?? await verifyEmailLoginCode(request, body.email, body.code, "signin");
    if (!proof.ok) return reply({ ok: false, code: proof.reason === "account_not_found" ? "EMAIL_ACCOUNT_NOT_FOUND" : proof.reason === "locked" ? "EMAIL_CODE_LOCKED" : "EMAIL_CODE_INVALID" }, 401);
    // The web sign-in callback also enforces account state. Never bypass it
    // simply because mailbox control was proven.
    const select = { accountStatus: true, accountSuspendedUntil: true } as const;
    let account = await prisma.user.findUnique({ where: { id: proof.userId }, select });
    const now = new Date();
    if (account?.accountStatus === "suspended" && account.accountSuspendedUntil && account.accountSuspendedUntil <= now) {
      // Same expiry behavior as web sign-in; do not overwrite a newer suspension
      // or a concurrent deletion decision after reading the account.
      await prisma.user.updateMany({ where: { id: proof.userId, accountStatus: "suspended", accountSuspendedUntil: { lte: now } }, data: {
        accountStatus: "active", accountSuspendedAt: null, accountSuspendedUntil: null,
        accountSuspensionReason: null, accountSuspendedById: null, accountSuspendedByEmail: null,
      } });
      account = await prisma.user.findUnique({ where: { id: proof.userId }, select });
    }
    if (account?.accountStatus !== "active") return reply({ ok: false, code: "MOBILE_LOGIN_REFUSED" }, 403);
    if (signupProof?.ok && signupProof.isNewUser && signupAttempt?.ok) {
      const consent = await finalizeSignupConsentAttempt({ userId: signupProof.userId, createdBySignIn: true, emailLoginAttemptId: signupProof.emailLoginAttemptId, addressProof: addressProofForSignIn({ provider: "email-code", profile: null, userEmail: body.email, now: new Date() }), attemptId: signupAttempt.attemptId, nonce: signupAttempt.nonce });
      // The account already exists. Do not claim completion or replay its OTP
      // if the optional consent lane failed; a fresh code can sign it in.
      if (!consent.ok) return reply({ ok: false, code: "EMAIL_SIGNUP_INCOMPLETE" }, 503);
    }
    const issued = await issueMobileSession({ request, userId: proof.userId, platform: body.platform, deviceLabel: body.deviceLabel ?? "Mobile" });
    return reply({ ok: true, ...issued.tokens });
  } catch (error) {
    const response = mobileApiSecurityResponse(error);
    if (response) { response.headers.set("Cache-Control", "no-store"); return response; }
    // Do not log request data or a token-bearing result.
    return reply({ ok: false, code: "MOBILE_LOGIN_FAILED" }, 500);
  }
}
