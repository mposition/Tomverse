import "server-only";

/**
 * What the mobile auth routes share: how a bearer becomes an identity, and how
 * a refusal is worded.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D2, D13 and D15, approved 2026-08-31.
 *
 * ## The route verifies again, and the vendor says so too
 *
 * D2 is double verification: proxy verifies to decide whether the
 * mutation-origin check is replaced, and the route verifies the same
 * `Authorization` token independently to decide anything at all. The internal
 * identity headers proxy sets are a convenience and are **not** read here --
 * Next's own Proxy documentation makes the same point, that a refactor moving a
 * handler can silently remove proxy coverage, so authentication belongs inside
 * the handler.
 *
 * ## No fallback, ever
 *
 * A present-but-invalid bearer is 401. It never falls through to the cookie
 * session: that would turn "attach a broken bearer" into "a cookie request with
 * the CSRF check removed", which is 5.1.4's fourth prohibition.
 */

import { NextResponse } from "next/server";

import {
  bearerTokenFromHeader,
  mobileAuthReady,
  verifyMobileAccessTokenString,
} from "@/lib/mobileAccessToken";
import { consumeApiRateLimit } from "@/lib/apiSecurity";
import { getAnonymousClientKey } from "@/lib/clientIp";
import {
  MOBILE_AUTH_ERROR_CODES,
  MOBILE_AUTH_PRE_AUTH_RATE_LIMIT,
} from "@/lib/mobileAuthContract";
import { authorizeMobileSession } from "@/lib/mobileSessionAuthorization";

/**
 * Admission control, before anything else the handler does.
 *
 * `exchange`, `refresh` and `logout` are mutation-origin exceptions, so once
 * the environment is deployed anyone can reach them. Every call used to write
 * an audit row and a structured log line with nothing bounding the rate, and a
 * refusal is the cheapest possible request to make -- a refresh token that does
 * not parse costs the caller nothing and cost us a row.
 *
 * Keyed on the client rather than on a subject, because at this point there is
 * no subject: that is the whole reason the per-device limit cannot cover it.
 * `getAnonymousClientKey` is the same key the guest paths use, and it degrades
 * to a coarse fingerprint rather than to one shared bucket when the trusted
 * proxy header is unresolvable.
 *
 * Throws `ApiSecurityError`, which every one of these routes already turns into
 * a 429 with a `Retry-After`.
 */
export const enforceMobileAuthAdmission = (request: Request) =>
  consumeApiRateLimit(
    request,
    getAnonymousClientKey(request),
    "mobile-preauth",
    MOBILE_AUTH_PRE_AUTH_RATE_LIMIT
  );

export type MobileRouteIdentity = {
  userId: string;
  deviceId: string;
  familyId: string;
};

/**
 * One body for every refusal a client is told about.
 *
 * Expired is its own code because the client's action genuinely differs -- it
 * refreshes rather than signing in again. Everything else shares one code by
 * design (D15): the action is the same, and separating them would report which
 * check an attacker tripped.
 */
export const mobileAuthRefusal = (
  code: (typeof MOBILE_AUTH_ERROR_CODES)[keyof typeof MOBILE_AUTH_ERROR_CODES],
  status = 401
) =>
  NextResponse.json(
    { ok: false, code, reauthenticate: code === MOBILE_AUTH_ERROR_CODES.refreshRejected },
    { status }
  );

/**
 * The account behind an `Authorization: Bearer` header, or a response to send.
 *
 * Two questions, both asked: is the token genuine (signature, type, dates), and
 * does the session behind it still exist (family, device, account). A token can
 * pass the first and fail the second for another ten minutes, which is exactly
 * the window D12's bound is about.
 */
export const requireMobileBearer = async (
  request: Request
): Promise<{ ok: true; identity: MobileRouteIdentity } | { ok: false; response: Response }> => {
  if (!mobileAuthReady()) {
    // Fail closed and say nothing about which variable is missing. The reason
    // is a deployment fact, and an unauthenticated caller is not owed it.
    return { ok: false, response: mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.tokenInvalid) };
  }

  const token = bearerTokenFromHeader(request.headers.get("authorization"));
  if (!token) {
    return { ok: false, response: mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.tokenInvalid) };
  }

  const verdict = verifyMobileAccessTokenString(token);
  if (!verdict.ok) {
    return {
      ok: false,
      response: mobileAuthRefusal(
        verdict.failure === "expired"
          ? MOBILE_AUTH_ERROR_CODES.tokenExpired
          : MOBILE_AUTH_ERROR_CODES.tokenInvalid
      ),
    };
  }

  const authorized = await authorizeMobileSession(verdict.identity);
  if (!authorized.ok) {
    // A revoked session is not an expired token, and saying "expired" would
    // send the client into a refresh that is also going to fail. It has to
    // sign in again.
    return {
      ok: false,
      response: mobileAuthRefusal(MOBILE_AUTH_ERROR_CODES.refreshRejected),
    };
  }

  return {
    ok: true,
    identity: {
      userId: authorized.userId,
      deviceId: authorized.deviceId,
      familyId: authorized.familyId,
    },
  };
};
