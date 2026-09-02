/**
 * The only way this app makes an authenticated request.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D19 and section 4 option A, approved 2026-08-31.
 *
 * ## What the JS side is allowed to hold
 *
 * An access token and its expiry, obtained from the bridge. Nothing else. The
 * refresh token lives in the platform secure store, is used by the native layer
 * only, and has no route into this context -- the bridge has no method that
 * returns one (`authBridgeContract.ts`).
 *
 * ## Why the retry is exactly one
 *
 * An access token can expire between "the bridge handed it over" and "the
 * server read it": ten minutes is the lifetime, and a request can be queued
 * behind a slow one. So a 401 is worth one more attempt with a freshly fetched
 * token.
 *
 * One, and not a loop. A loop against a revoked session is a client that
 * hammers `refresh` until something gives up, and the session is not coming
 * back -- the family is revoked and every refresh will be refused. The second
 * 401 is the answer.
 *
 * ## Where single-flight lives, and where it does not
 *
 * In the native layer, behind `getAccessToken()` (D19 ③). Option A is strict
 * single use: two concurrent refreshes with the same token means one of them
 * replays it, and a replay destroys the family. That has to be serialized in
 * one place, and the one place is the side that holds the refresh token --
 * not here, where every tab, component and retry would need its own copy of
 * the discipline.
 *
 * This file therefore does no coalescing of its own. If it did, it would be a
 * second single-flight that the native one knows nothing about.
 */

import type { MobileAccessGrant, MobileAuthBridge } from "./authBridgeContract";

export type AuthenticatedFetchOptions = {
  bridge: Pick<MobileAuthBridge, "getAccessToken">;
  /**
   * The exact origin of the Tomverse API, e.g. `https://tomverse.app`.
   *
   * Required, and required to be exact. The bundle is served from
   * `capacitor://localhost`, so a relative path would resolve against *that*
   * and reach nothing; and a caller free to pass an absolute URL is a caller
   * who can send this device's access token wherever they like.
   */
  apiOrigin: string;
  /** Injected so tests need no network and no globals. */
  fetchImpl?: typeof fetch;
};

/** The path was not one this client is allowed to send a token to. */
export class MobileApiPathError extends Error {
  constructor(path: string) {
    // The path is in the message because this is a programming error the
    // developer who wrote the call site has to see. It carries no token.
    super(`Refusing to attach a mobile access token to "${path}".`);
    this.name = "MobileApiPathError";
  }
}

/**
 * Resolves a caller's path against the API origin, or refuses.
 *
 * The refusals, and why each one is separate:
 *
 *   * **not starting with `/api/`** -- the bearer is for the API. A document
 *     route has no use for it and no reason to see it;
 *   * **scheme-relative (`//evil.example/x`)** -- resolves to another origin
 *     while looking like a path, which is the classic way this check is got
 *     wrong;
 *   * **absolute** -- `https://evil.example/api/x` is the obvious case, and
 *     `new URL` would happily take it as a base-less URL;
 *   * **backslashes** -- some URL parsers treat `\` as `/`, so a path
 *     containing one can mean two different things to two parsers;
 *   * **anything whose resolved origin is not the API's** -- the backstop,
 *     which catches whatever the four rules above did not think of, including
 *     traversal that climbs out of `/api/`.
 */
const resolveApiUrl = (path: string, apiOrigin: string): string => {
  if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//")) {
    throw new MobileApiPathError(String(path));
  }
  if (path.includes("\\")) throw new MobileApiPathError(path);

  let url: URL;
  try {
    url = new URL(path, apiOrigin);
  } catch {
    throw new MobileApiPathError(path);
  }
  if (url.origin !== new URL(apiOrigin).origin) throw new MobileApiPathError(path);
  if (!url.pathname.startsWith("/api/")) throw new MobileApiPathError(path);
  return url.toString();
};

/**
 * Whether a grant is worth presenting at all.
 *
 * A grant already past its expiry would spend a request to be told 401. The
 * bridge is asked again instead -- which on the native side may or may not
 * involve a refresh, and this file does not need to know which.
 */
const isUsable = (grant: MobileAccessGrant, now: number) =>
  typeof grant.accessToken === "string" &&
  grant.accessToken.length > 0 &&
  grant.expiresAt > now;

const withBearer = (init: RequestInit | undefined, token: string) => {
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${token}`);
  return { ...init, headers };
};

/**
 * A request carrying this device's access token.
 *
 * Never sends credentials: the app has no cookies for this origin and asking
 * for them would be asking the browser to attach an ambient credential to a
 * request that is authenticated by a bearer. The two auth models do not mix
 * (D13), and the request that carries both is the one that makes a future
 * reader wonder which one the server used.
 */
export const authenticatedFetch = async (
  path: string,
  init: RequestInit | undefined,
  options: AuthenticatedFetchOptions
): Promise<Response> => {
  const run = options.fetchImpl ?? fetch;

  // Before the bridge is even asked. A refused path must not cause a token to
  // be fetched, let alone sent.
  const input = resolveApiUrl(path, options.apiOrigin);

  const first = await options.bridge.getAccessToken();
  if (!isUsable(first, Date.now())) {
    // Not a request. There is no token to send, and sending nothing would get
    // a 401 the caller cannot tell from a revoked session.
    throw new MobileAuthUnavailableError();
  }

  const response = await run(input, {
    ...withBearer(init, first.accessToken),
    credentials: "omit",
    // A redirect on an authenticated API call is a bug, not a flow. Browsers
    // strip `Authorization` across origins, but a same-origin hop to another
    // path keeps it, and following one silently is how a token ends up
    // somewhere nobody chose. Failing is the answer that gets noticed.
    redirect: "error",
  });
  if (response.status !== 401) return response;

  const second = await options.bridge.getAccessToken();
  if (!isUsable(second, Date.now()) || second.accessToken === first.accessToken) {
    // The bridge had nothing newer to give. Retrying with the same token would
    // ask the same question and get the same answer.
    return response;
  }

  return run(input, {
    ...withBearer(init, second.accessToken),
    credentials: "omit",
    redirect: "error",
  });
};

/** The device holds no usable session. The caller signs in again. */
export class MobileAuthUnavailableError extends Error {
  constructor() {
    super("No mobile session is available.");
    this.name = "MobileAuthUnavailableError";
  }
}
