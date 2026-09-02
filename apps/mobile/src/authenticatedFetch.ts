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
  /** Injected so tests need no network and no globals. */
  fetchImpl?: typeof fetch;
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
  input: string,
  init: RequestInit | undefined,
  options: AuthenticatedFetchOptions
): Promise<Response> => {
  const run = options.fetchImpl ?? fetch;

  const first = await options.bridge.getAccessToken();
  if (!isUsable(first, Date.now())) {
    // Not a request. There is no token to send, and sending nothing would get
    // a 401 the caller cannot tell from a revoked session.
    throw new MobileAuthUnavailableError();
  }

  const response = await run(input, {
    ...withBearer(init, first.accessToken),
    credentials: "omit",
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
  });
};

/** The device holds no usable session. The caller signs in again. */
export class MobileAuthUnavailableError extends Error {
  constructor() {
    super("No mobile session is available.");
    this.name = "MobileAuthUnavailableError";
  }
}
