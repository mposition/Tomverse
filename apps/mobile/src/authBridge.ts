import { registerPlugin } from "@capacitor/core";

import { authenticatedFetch } from "./authenticatedFetch";
import type { MobileAuthBridge } from "./authBridgeContract";

/**
 * The refusing implementation, used in a browser and by any platform that has
 * not registered a native one.
 *
 * It has no `getAccessToken` that could ever succeed, which means there is no
 * code path in this bundle that obtains a token without a native layer. A
 * developer who wants a signed-in browser has to write one, and writing one is
 * the moment this comment is for.
 */
const unavailableBridge: MobileAuthBridge = {
  getDeviceSecurity: async () => ({ available: false, enabled: false, locked: false }),
  setDeviceLock: () => Promise.reject(new Error("Device security requires the native app.")),
  unlockDevice: () => Promise.reject(new Error("Device security requires the native app.")),
  signIn: () => Promise.reject(new Error("Sign-in requires the native app.")),
  requestEmailCode: () => Promise.reject(new Error("Sign-in requires the native app.")),
  verifyEmailCode: () => Promise.reject(new Error("Sign-in requires the native app.")),
  getAccessToken: () =>
    Promise.reject(
      new Error(
        "Mobile authentication requires the native layer; there is no web fallback by design."
      )
    ),
  hasSession: () => Promise.resolve({ signedIn: false }),
  signOut: () => Promise.resolve(),
};

export const MobileAuth = registerPlugin<MobileAuthBridge>("MobileAuth", {
  web: () => Promise.resolve(unavailableBridge),
});

/** All product requests use the native access grant through this boundary. */
export const TOMVERSE_API_ORIGIN =
  import.meta.env?.VITE_TOMVERSE_API_ORIGIN ?? "https://tomverse.app";

export const mobileApiFetch = (path: string, init?: RequestInit) =>
  authenticatedFetch(path, init, {
    bridge: MobileAuth,
    apiOrigin: TOMVERSE_API_ORIGIN,
  });
