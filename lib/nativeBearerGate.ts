/**
 * The proxy-side half of N1b: whether a request's bearer token may stand in for
 * the mutation-origin check, and the header hygiene that has to happen first.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * sections 5.1, 5.2, 5.4 and 5.5, approved 2026-08-31.
 *
 * ## What this decides, and what it emphatically does not
 *
 * A `yes` means the request is a cryptographically verified mobile bearer
 * request, so it does not depend on an ambient credential and CSRF has no
 * purchase on it. That is the *only* thing it means. Ownership, account state,
 * family revocation and credit are all decided again by the route, against the
 * same token (D2). The identity headers written below are a convenience for
 * logging and correlation and are not an authorization input -- the route reads
 * the `Authorization` header itself.
 *
 * ## Why the route list is a parameter
 *
 * `N1B_BEARER_ROUTES` ships empty by approval (decision 13), so on the deployed
 * configuration every verdict here is `not_applicable` and nothing about the
 * request changes. That is the intended state: native mutations keep meeting
 * the mutation-origin check and keep being refused until routes are converted
 * one at a time, each with evidence that its identity and ownership checks read
 * the bearer rather than the cookie session (D18).
 *
 * An empty list would also make this module untestable, which is how an empty
 * list becomes an untested one. So the list is injected, the tests register a
 * route of their own, and what ships is still empty.
 *
 * Pure: the verifier is a port. No crypto, no environment, no Prisma.
 */

/**
 * The namespace proxy owns and a client may never write into.
 *
 * `x-tomverse-pathname` and `x-tomverse-search` are deliberately outside it:
 * they are routing conveniences a route already treats as raw input, and
 * folding them into the auth namespace would blur what "the client cannot set
 * this" is protecting.
 */
export const INTERNAL_AUTH_HEADER_PREFIX = "x-tomverse-auth-";

export const MOBILE_IDENTITY_HEADERS = {
  subject: `${INTERNAL_AUTH_HEADER_PREFIX}subject`,
  device: `${INTERNAL_AUTH_HEADER_PREFIX}device`,
  family: `${INTERNAL_AUTH_HEADER_PREFIX}family`,
} as const;

/**
 * Removes every header in the internal auth namespace, and says which.
 *
 * Unconditional, and before any verification -- section 5.4 is explicit that
 * overwriting on success is not enough. A verdict of `reject` or
 * `not_applicable` writes nothing, so a client-supplied header would simply
 * survive; the deletion is what makes "the client cannot set this" true in
 * every branch rather than only the happy one.
 *
 * Returns the header *names* it removed. Never the values: a forged identity
 * header is attacker-controlled text, and the useful fact for an operator is
 * that somebody tried, not what they wrote.
 */
export const stripInternalAuthHeaders = (headers: Headers): string[] => {
  const removed: string[] = [];
  for (const name of [...headers.keys()]) {
    if (name.toLowerCase().startsWith(INTERNAL_AUTH_HEADER_PREFIX)) {
      removed.push(name.toLowerCase());
      headers.delete(name);
    }
  }
  return removed;
};

export type NativeBearerIdentity = {
  subject: string;
  device: string;
  family: string;
};

export type NativeBearerVerdict =
  /** The route is not registered for N1b. Nothing was verified and nothing changes. */
  | { kind: "not_applicable" }
  /** No bearer header. The request continues down the existing cookie path. */
  | { kind: "no" }
  /** A bearer was presented and is not usable. 401, and never a cookie fallback. */
  | { kind: "reject"; failure: string }
  /** Verified. The mutation-origin check is replaced for this request. */
  | { kind: "yes"; identity: NativeBearerIdentity };

export type NativeBearerVerifier = (token: string) =>
  | { ok: true; identity: { subject: string; device: string; family: string } }
  | { ok: false; failure: string };

/**
 * Section 5.2, from the outside in.
 *
 * The order matters here for a different reason than it does inside the token
 * verifier. There, later steps read attacker-written claims. Here, the early
 * exits are what keep the cost of N1b proportional: an unregistered route and a
 * request with no `Authorization` header never reach the verifier at all, so
 * document requests and every route that has not been converted pay nothing.
 */
export const nativeBearerVerdict = (input: {
  pathname: string;
  authorization: string | null;
  /** Exact paths, as approved. A prefix would enrol routes nobody registered. */
  registeredRoutes: readonly string[];
  verify: NativeBearerVerifier;
}): NativeBearerVerdict => {
  if (!input.registeredRoutes.includes(input.pathname)) {
    // Not "passed". Not verified at all -- the request goes on to meet
    // whatever it would have met without N1b, mutation-origin check included.
    return { kind: "not_applicable" };
  }

  const header = input.authorization;
  if (header === null || header.trim() === "") return { kind: "no" };

  const match = /^Bearer[ ]+([^\s]+)$/i.exec(header.trim());
  if (!match?.[1]) {
    // A header that is present and is not a bearer token. Refused rather than
    // ignored: falling through here would make "send a broken Authorization
    // header" a way to get the cookie path with the CSRF check still running,
    // and then the *next* edit makes it a way to get it without.
    return { kind: "reject", failure: "malformed_authorization" };
  }

  const verdict = input.verify(match[1]);
  if (!verdict.ok) return { kind: "reject", failure: verdict.failure };
  return { kind: "yes", identity: verdict.identity };
};

/** Writes the verified identity into the namespace stripped above. */
export const applyMobileIdentityHeaders = (
  headers: Headers,
  identity: NativeBearerIdentity
) => {
  headers.set(MOBILE_IDENTITY_HEADERS.subject, identity.subject);
  headers.set(MOBILE_IDENTITY_HEADERS.device, identity.device);
  headers.set(MOBILE_IDENTITY_HEADERS.family, identity.family);
};
