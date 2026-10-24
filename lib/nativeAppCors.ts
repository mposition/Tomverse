// N1a. Cross-origin access for the locally bundled Capacitor shell, and
// nothing else.
// Native Chat authentication lives in nativeBearerGate/chatRouteSession behind
// a default-off enrollment switch; this file grants no authorization.
//
// Contract: .github/audits/2026-08-30-native-mobile-readiness.md §3.1, and
// `AUTH-04` in docs/release-gates/tomverse-chat-v1.yaml ("CORS bypass and
// deep-link hijacking attack tests pass").
//
// ## What this is, and the one thing it is not
//
// A Capacitor app runs from its own origin -- `capacitor://localhost` on iOS,
// `https://localhost` on Android, both read from Capacitor 8.5.0's own
// configuration declarations. Every request it makes to the API is therefore
// cross-origin, so the browser will not let the app *read* a response unless
// the server says it may.
//
// That is the whole of what this file decides: whether the response is
// readable. It is emphatically **not** whether the request is allowed. Those
// are different questions, and conflating them is how a CORS change becomes a
// security incident:
//
//   - the host allowlist and the Cloudflare origin-secret check still run,
//     ahead of this;
//   - the mutation-origin (CSRF) check still protects cookie requests. Only a
//     verified bearer on an explicitly enrolled route replaces that check;
//   - every route still does its own authentication, ownership, plan, credit
//     and moderation checks.
//
// A shell can read a server refusal instead of an opaque network error.
// Successful mutations require the separate proxy and route authentication,
// live-session verification and route-specific authorization checks.
//
// ## Why the origins are literals
//
// Not an environment variable, not a pattern, not the request's own `Origin`
// reflected back. An allowlist that can be widened by configuration is one
// deploy away from being widened by accident, and origin reflection is not an
// allowlist at all -- it is "yes" wearing one.

/**
 * The two origins a locally bundled Capacitor app can have.
 *
 * Read from the vendor's own configuration declarations rather than from
 * documentation about them (`@capacitor/cli` 8.5.0, `dist/declarations.d.ts`):
 *
 *   `server.iosScheme`      default `capacitor`  -> capacitor://localhost
 *   `server.androidScheme`  default `https`      -> https://localhost
 *
 * `apps/mobile/capacitor.config.ts` deliberately overrides neither, and
 * `npm run check:capacitor-local-bundle` fails the build if a `server` block
 * grows a `url`, `cleartext` or `allowNavigation`. If either scheme is ever
 * changed, this list is the other half of that change.
 *
 * A port is not permitted on either. `https://localhost:3000` is a different
 * origin from `https://localhost` and is a plausible thing for a developer's
 * machine to be serving, so it is not on this list.
 */
export const NATIVE_APP_ORIGINS = [
  "capacitor://localhost",
  "https://localhost",
] as const;

/** Headers a native client may send on a cross-origin request. */
const ALLOWED_REQUEST_HEADERS = [
  // Listing a header lets its preflight succeed; it does not authenticate it.
  // Proxy and enrolled route handlers independently verify bearer credentials.
  // Mere header presence never bypasses the mutation-origin check.
  "Authorization",
  "Content-Type",
  // The app's own correlation identifiers. Both are client-supplied and are
  // treated as such: `docs/policy/trace-feedback-automation.md` classifies a
  // trace the client sent as `client_supplied`, which is not a credential.
  "X-Request-ID",
  "X-Tomverse-Trace-Id",
  "X-Tomverse-Conversation-Unlocks",
  "X-Tomverse-Time-Zone",
] as const;

/**
 * Methods advertised in a preflight response.
 *
 * The mutating ones are advertised independently of authorization. Omitting them would make
 * the browser fail the preflight, and the app would see a generic CORS error
 * with no status and no body -- indistinguishable from the server being down.
 * Advertising them lets the *server's* refusal arrive intact, with its status,
 * its `code` and its `traceId`.
 *
 * One place decides whether a mutation is allowed, and it is not this list.
 */
const ALLOWED_METHODS = [
  "GET",
  "HEAD",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "OPTIONS",
] as const;

/**
 * How long a browser may cache a preflight result.
 *
 * Ten minutes: long enough that a chat session does not re-preflight every
 * request, short enough that narrowing this allowlist takes effect within one
 * coffee break rather than one browser restart.
 */
const PREFLIGHT_MAX_AGE_SECONDS = 600;

/**
 * Whether `value` is exactly one of the native app origins.
 *
 * Scheme and host are case-insensitive per RFC 3986, so the comparison is
 * lower-cased -- but nothing else is normalised. No trailing slash is
 * tolerated, no port is tolerated, no suffix or prefix match is performed.
 * `https://localhost.evil.example` and `capacitor://localhost:1` are both
 * rejected, which is the point of comparing whole strings.
 */
export const isNativeAppOrigin = (value: string | null | undefined): boolean => {
  if (!value) return false;
  const normalized = value.trim().toLowerCase();
  return (NATIVE_APP_ORIGINS as readonly string[]).includes(normalized);
};

/** A CORS preflight is an `OPTIONS` carrying `Access-Control-Request-Method`. */
export const isPreflightRequest = (input: {
  method: string;
  accessControlRequestMethod: string | null | undefined;
}): boolean =>
  input.method.toUpperCase() === "OPTIONS" &&
  typeof input.accessControlRequestMethod === "string" &&
  input.accessControlRequestMethod.trim().length > 0;

export type NativeCorsHeaders = Record<string, string>;

/**
 * The CORS headers for a cross-origin response, or `null` when there are none.
 *
 * `null` is the answer for every origin that is not on the list, including a
 * hostile one: nothing is echoed, so a page on `https://attacker.example`
 * receives a response its own browser will not let it read.
 *
 * `Access-Control-Allow-Credentials` is deliberately absent. What that buys is
 * narrower than it first looks, and stating it precisely matters because N2
 * will be designed on top of whatever this comment claims.
 *
 * **What it does mean.** The response is not shared with a credentialed
 * cross-origin request. A `fetch` with `credentials: "include"` fails the CORS
 * check and its initiator reads nothing, so a cross-origin caller cannot use
 * the browser's ambient credentials to read this API.
 *
 * **What it does not mean.** It is not a guarantee that no cookie was sent. A
 * simple request reaches the server according to the browser's own cookie
 * rules -- SameSite among them -- and is blocked at the point the initiator
 * tries to *read* the response, not before it arrives
 * (https://fetch.spec.whatwg.org/#cors-protocol-and-credentials). An
 * `Authorization` header a client attaches explicitly is a separate matter
 * again: it is not an ambient credential and this flag has nothing to say
 * about it.
 *
 * So the safety of allowing `https://localhost` -- an origin any process on a
 * user's machine can serve -- does not rest on requests from it being
 * anonymous. It rests on three things, none of which live in this file:
 *
 *   1. no credentialed CORS sharing, which is what this absence provides;
 *   2. the server authenticating and authorising every request on its own,
 *      including CSRF for cookie requests and explicit enrollment plus double
 *      verification for native bearer requests;
 *   3. the native transport carrying no cookie and instead presenting a bearer
 *      token the proxy and route verify, with live family/device/account checks.
 *
 * A bearer token is attached explicitly rather than sent ambiently, which is
 * why the bearer path does not need CSRF protection while the cookie path does
 * (docs/policy/tomverse-chat-mobile-authentication.md, "Why not extend the
 * cookie session"). That is an argument about how the credential travels, not
 * about this header.
 */
export const nativeAppCorsHeaders = (
  origin: string | null | undefined
): NativeCorsHeaders | null => {
  if (!isNativeAppOrigin(origin)) return null;
  return {
    // The matched literal, not the request's own string: an origin that
    // differed only by case or surrounding whitespace is answered with the
    // canonical form rather than with its own input echoed back.
    "Access-Control-Allow-Origin": (origin as string).trim().toLowerCase(),
    "Access-Control-Expose-Headers": "Content-Disposition, Content-Length",
  };
};

/**
 * The full header set for a preflight response.
 *
 * `null` when the origin is not allowed -- the caller should then let the
 * request continue as an ordinary one, which is how a preflight from a
 * hostile origin ends up answered by a route that never advertises CORS.
 */
export const nativeAppPreflightHeaders = (
  origin: string | null | undefined
): NativeCorsHeaders | null => {
  const base = nativeAppCorsHeaders(origin);
  if (!base) return null;
  return {
    ...base,
    "Access-Control-Allow-Methods": ALLOWED_METHODS.join(", "),
    "Access-Control-Allow-Headers": ALLOWED_REQUEST_HEADERS.join(", "),
    "Access-Control-Max-Age": String(PREFLIGHT_MAX_AGE_SECONDS),
  };
};

/**
 * `Vary` with `Origin` folded in, preserving whatever was already there.
 *
 * Required on every API response, not only the ones that carry
 * `Access-Control-Allow-Origin`. A shared cache that stored one response
 * without this could serve a native-origin response -- headers included -- to
 * a different origin's request, which would hand out an allowance the server
 * never granted to that caller.
 */
export const varyWithOrigin = (existing: string | null | undefined): string => {
  const entries = (existing || "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.some((entry) => entry.toLowerCase() === "origin")) {
    return entries.join(", ");
  }
  return [...entries, "Origin"].join(", ");
};
