// N1a. Cross-origin access for the locally bundled Capacitor shell, and
// nothing else.
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
//   - the mutation-origin (CSRF) check in `lib/requestOrigin.ts` still runs,
//     and still rejects every non-GET request from these origins, because
//     nothing here makes a request same-origin;
//   - every route still does its own authentication, ownership, plan, credit
//     and moderation checks.
//
// So after this change a native shell can *read* a `403
// INVALID_REQUEST_ORIGIN` instead of receiving an opaque network error. It
// still cannot mutate anything. Lifting that is N1b, and N1b needs a verified
// bearer identity, which does not exist yet -- see the note on
// `Access-Control-Allow-Headers` below.
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
  // Listed so that a preflight for a bearer request succeeds rather than
  // failing at the browser. Listing it grants nothing: no code path verifies
  // an `Authorization` header today, and the mutation-origin check does not
  // consult it. A header that is merely *present* must never change a security
  // decision -- `proxy.ts` says the same about prefetch headers, for the same
  // reason ("gating those on request headers would let any caller opt out of
  // the entire edge security layer").
  "Authorization",
  "Content-Type",
  // The app's own correlation identifiers. Both are client-supplied and are
  // treated as such: `docs/policy/trace-feedback-automation.md` classifies a
  // trace the client sent as `client_supplied`, which is not a credential.
  "X-Request-ID",
  "X-Tomverse-Trace-Id",
] as const;

/**
 * Methods advertised in a preflight response.
 *
 * The mutating ones are here on purpose even though every one of them is
 * currently rejected by the mutation-origin check. Omitting them would make
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
 * `Access-Control-Allow-Credentials` is deliberately absent, which is what
 * makes widening the allowlist to `https://localhost` safe. Any process on a
 * user's machine can serve that origin, so if credentials were allowed it
 * could read the signed-in user's data. Without it the browser sends no
 * cookie and no `Authorization` it did not obtain itself, so such a request
 * arrives unauthenticated and sees only what an anonymous caller sees.
 *
 * The bearer path this exists for does not need credentialed CORS: a bearer
 * token is attached by the client explicitly, which is also why bearer
 * requests do not need CSRF protection while cookie requests do
 * (docs/policy/tomverse-chat-mobile-authentication.md, "Why not extend the
 * cookie session").
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
