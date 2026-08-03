import "server-only";

import {
  createHash,
  createHmac,
  randomUUID,
  timingSafeEqual,
} from "node:crypto";
import { getAnonymousClientKey, getTrustedClientIp } from "@/lib/clientIp";
import { ChatAccessError } from "@/lib/chatSecurity";

type SiteverifyResponse = {
  success?: boolean;
  hostname?: string;
  action?: string;
};

// Guests were being asked to solve a fresh Turnstile challenge on every
// message (each panel independently), which Cloudflare's risk engine started
// escalating to a visible checkbox on nearly every send. Once a guest passes
// Turnstile once, this short-lived signed cookie lets subsequent requests
// skip re-verification for a while instead of re-running Turnstile every time.
//
// SEC-004. The grant used to be a single cookie signed over nothing but its own
// expiry, which made it both transferable and universal:
//
//   * transferable, because the signature did not name a client. One scripted
//     solve produced a 30-minute bearer token that worked from any address, so
//     a pool of bots could share one solved challenge.
//   * universal, because the signature did not name an action. Passing the
//     cheapest challenge (`guest_chat`) also bought thirty minutes of
//     `guest_ai_review` -- an 8-credit AI cross-review -- and of
//     `guest_attachment`, the worker-isolated file parse. The client already
//     mints a separate action-bound token per surface; only the server-side
//     grant collapsed them.
//
// Both are now in the signature, and the cookie is named per earning action so
// verifying for one surface does not evict the grant for another. Grants issued
// by the previous release are simply not recognised (different cookie name), so
// the worst case at deploy is that guests mid-session verify once more.
const GUEST_TURNSTILE_GRANT_COOKIE_PREFIX = "tomverse_guest_verified_";
const GUEST_TURNSTILE_GRANT_TTL_SECONDS = 60 * 30;

/** Every action the grant mechanism can be asked about. */
export const GUEST_TURNSTILE_ACTIONS = [
  "guest_chat",
  "guest_conversation_title",
  "guest_quick_summary",
  "guest_ai_review",
  "guest_attachment",
  "support_request",
] as const;

export type GuestTurnstileAction = (typeof GUEST_TURNSTILE_ACTIONS)[number];

/**
 * Which actions a grant earned for a given action also satisfies.
 *
 * Almost everything covers only itself. The exception is
 * `guest_conversation_title`: it is a background convenience fired once per
 * conversation straight after a successful guest answer, the client sends no
 * token for it at all, and it must never be the reason a challenge appears.
 * Covering it from a `guest_chat` grant keeps that property. It is also the
 * cheapest of the guest endpoints, so folding it in concedes nothing an
 * attacker could not already do by sending the chat message itself.
 */
const GRANT_COVERAGE: Record<
  GuestTurnstileAction,
  readonly GuestTurnstileAction[]
> = {
  guest_chat: ["guest_chat", "guest_conversation_title"],
  guest_conversation_title: ["guest_conversation_title"],
  guest_quick_summary: ["guest_quick_summary"],
  guest_ai_review: ["guest_ai_review"],
  guest_attachment: ["guest_attachment"],
  support_request: ["support_request"],
};

const isGuestTurnstileAction = (
  value: string
): value is GuestTurnstileAction =>
  (GUEST_TURNSTILE_ACTIONS as readonly string[]).includes(value);

/** Earning actions whose grant satisfies `action`. */
const grantingActionsFor = (action: GuestTurnstileAction) =>
  GUEST_TURNSTILE_ACTIONS.filter((candidate) =>
    GRANT_COVERAGE[candidate].includes(action)
  );

const getGrantSecret = () => {
  const secret = process.env.NEXTAUTH_SECRET;
  if (!secret) {
    throw new ChatAccessError(
      503,
      "SECURITY_NOT_CONFIGURED",
      "Guest verification is not configured."
    );
  }
  return secret;
};

/**
 * Ties the grant to the client it was issued to.
 *
 * `getAnonymousClientKey` is the trusted Cloudflare address in production, and
 * a coarse fingerprint when that header is unresolvable. Neither is a strong
 * identity, and it is not meant to be: the point is that a grant lifted from
 * one client and replayed from a fleet of others no longer works. A guest whose
 * address genuinely changes mid-session pays exactly one more challenge, which
 * is usually invisible (`appearance: "interaction-only"`).
 */
const grantBinding = (request: Request) =>
  createHash("sha256")
    .update(getAnonymousClientKey(request))
    .digest("base64url");

const signGuestTurnstileGrant = (
  action: GuestTurnstileAction,
  binding: string,
  expiresAt: number
) =>
  createHmac("sha256", getGrantSecret())
    .update(`guest_turnstile_grant:v2:${action}:${binding}:${expiresAt}`)
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

export const buildGuestTurnstileGrantCookie = (
  request: Request,
  action: GuestTurnstileAction
) => {
  const expiresAt =
    Math.floor(Date.now() / 1000) + GUEST_TURNSTILE_GRANT_TTL_SECONDS;
  const signature = signGuestTurnstileGrant(
    action,
    grantBinding(request),
    expiresAt
  );
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${GUEST_TURNSTILE_GRANT_COOKIE_PREFIX}${action}=${expiresAt}.${signature}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${GUEST_TURNSTILE_GRANT_TTL_SECONDS}; Priority=High${secure}`;
};

/**
 * Whether any cookie that *could* carry a grant for `action` exists at all,
 * valid or not. Diagnostic only -- it distinguishes a guest who was never
 * verified (no cookie) from one whose grant was issued but no longer verifies
 * (expired, or bound to a different client), which is the signature of the
 * "verified, then asked again" incident class.
 */
const hasGrantCookieForAction = (
  request: Request,
  action: GuestTurnstileAction
) =>
  grantingActionsFor(action).some(
    (granting) =>
      readCookie(
        request,
        `${GUEST_TURNSTILE_GRANT_COOKIE_PREFIX}${granting}`
      ) !== null
  );

const hasGrantForExactAction = (
  request: Request,
  action: GuestTurnstileAction,
  binding: string
) => {
  const token = readCookie(
    request,
    `${GUEST_TURNSTILE_GRANT_COOKIE_PREFIX}${action}`
  );
  if (!token) return false;

  const [expiresValue, signature, ...extra] = token.split(".");
  const expiresAt = Number(expiresValue);
  if (
    extra.length > 0 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= Math.floor(Date.now() / 1000)
  ) {
    return false;
  }

  const expected = signGuestTurnstileGrant(action, binding, expiresAt);
  const actualBuffer = Buffer.from(signature || "");
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length &&
    timingSafeEqual(actualBuffer, expectedBuffer)
  );
};

export const hasValidGuestTurnstileGrant = (
  request: Request,
  action: GuestTurnstileAction
) => {
  const binding = grantBinding(request);
  return grantingActionsFor(action).some((granting) =>
    hasGrantForExactAction(request, granting, binding)
  );
};

const isLocalDevelopmentRequest = (request: Request) => {
  if (process.env.NODE_ENV === "production") return false;
  const host = request.headers.get("host");
  if (!host) return false;
  try {
    const hostname = new URL(`http://${host}`).hostname;
    return ["localhost", "127.0.0.1", "::1"].includes(hostname);
  } catch {
    return false;
  }
};

export async function verifyGuestTurnstile(
  request: Request,
  token: string | undefined,
  expectedAction = "guest_chat"
) {
  if (isLocalDevelopmentRequest(request)) return;

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    if (process.env.NODE_ENV !== "production") return;
    throw new ChatAccessError(
      503,
      "TURNSTILE_NOT_CONFIGURED",
      "Guest verification is not configured."
    );
  }
  if (!token || token.length > 2_048) {
    throw new ChatAccessError(
      403,
      "TURNSTILE_REQUIRED",
      "Guest verification is required."
    );
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8_000);
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret,
          response: token,
          remoteip: getTrustedClientIp(request),
          idempotency_key: randomUUID(),
        }),
        cache: "no-store",
        signal: controller.signal,
      }
    );
    if (!response.ok) {
      throw new ChatAccessError(
        503,
        "TURNSTILE_UNAVAILABLE",
        "Guest verification is temporarily unavailable."
      );
    }
    const result = (await response.json()) as SiteverifyResponse;
    const expectedHostname =
      process.env.TURNSTILE_EXPECTED_HOSTNAME ||
      (() => {
        try {
          return process.env.NEXTAUTH_URL
            ? new URL(process.env.NEXTAUTH_URL).hostname
            : undefined;
        } catch {
          return undefined;
        }
      })();
    if (
      !result.success ||
      result.action !== expectedAction ||
      (expectedHostname && result.hostname !== expectedHostname)
    ) {
      throw new ChatAccessError(
        403,
        "TURNSTILE_FAILED",
        "Guest verification failed."
      );
    }
  } catch (error) {
    if (error instanceof ChatAccessError) throw error;
    throw new ChatAccessError(
      503,
      "TURNSTILE_UNAVAILABLE",
      "Guest verification is temporarily unavailable."
    );
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * One structured line per verification rejection. Booleans and enums only:
 * never the token, a cookie value, the site key, or a raw address. The
 * combination of `hasToken` and `grantCookiePresent` separates the three
 * populations that all surface as a Turnstile error --
 *   * first contact (no token, no cookie): the normal security contract;
 *   * a repeat after a successful verification (no token, cookie present but
 *     not verifying): a lost/expired/rebound grant, the incident class this
 *     log exists to catch;
 *   * a rejected token (token present): a failed or replayed challenge.
 */
const logGuestTurnstileRejection = (
  request: Request,
  expectedAction: string,
  token: string | undefined,
  error: ChatAccessError,
  context?: { traceId?: string }
) => {
  const grantCookiePresent = isGuestTurnstileAction(expectedAction)
    ? hasGrantCookieForAction(request, expectedAction)
    : false;
  console.warn(
    JSON.stringify({
      event: "guest_turnstile_rejected",
      code: error.code,
      status: error.status,
      traceId: context?.traceId,
      action: expectedAction,
      hasToken: Boolean(token),
      grantCookiePresent,
      likelyRepeatAfterGrant: !token && grantCookiePresent,
      secretConfigured: Boolean(process.env.TURNSTILE_SECRET_KEY),
      expectedHostnameConfigured: Boolean(
        process.env.TURNSTILE_EXPECTED_HOSTNAME || process.env.NEXTAUTH_URL
      ),
      publicSiteKeyConfigured: Boolean(
        process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY
      ),
      timestamp: new Date().toISOString(),
    })
  );
};

/**
 * Skips re-verification when the guest already has a valid grant from a
 * recent successful Turnstile pass; otherwise verifies as before and, on
 * success, returns a Set-Cookie value the caller should attach to its
 * response so the next request can skip Turnstile too.
 *
 * The caller must attach that cookie to whatever response the request ends
 * with -- error responses included. A guest whose token was accepted has paid
 * their challenge; if a later gate (rate limit, concurrency, credits) then
 * rejects the request, dropping the cookie makes the next attempt fail
 * verification again and the user sees TURNSTILE_REQUIRED in a loop.
 */
export async function ensureGuestVerified(
  request: Request,
  token: string | undefined,
  expectedAction: GuestTurnstileAction = "guest_chat",
  context?: { traceId?: string }
): Promise<string | undefined> {
  // SEC-004. Defence in depth against a caller passing a string that is not one
  // of the declared actions: an unknown action has no coverage entry, so it
  // must never be treated as covered by an existing grant.
  if (
    isGuestTurnstileAction(expectedAction) &&
    hasValidGuestTurnstileGrant(request, expectedAction)
  ) {
    return undefined;
  }
  try {
    await verifyGuestTurnstile(request, token, expectedAction);
  } catch (error) {
    if (error instanceof ChatAccessError) {
      logGuestTurnstileRejection(request, expectedAction, token, error, context);
    }
    throw error;
  }
  return buildGuestTurnstileGrantCookie(request, expectedAction);
}
