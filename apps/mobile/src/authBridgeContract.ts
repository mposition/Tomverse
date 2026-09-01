/**
 * The shape of the native auth bridge, and the one thing it must never have.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D19, approved 2026-08-31.
 *
 * `exchange`, `refresh` and `logout` are called by the Capacitor **native**
 * layer. The refresh token in those responses goes straight into the platform
 * secure store and is never handed back across the bridge, so what the WebView
 * can hold is an access token and its expiry -- nothing more.
 *
 * The derived requirement is stated as an absence, and absences are hard to
 * enforce by review: **the bridge has no API that returns a refresh token.**
 * What does not exist cannot leak. So the contract lives here as a type, and
 * `tests/mobileAuthBridgeContract.test.mjs` fails if a member is added whose
 * name or documented return could carry one.
 *
 * ## What this file is not
 *
 * It is not the plugin. The Swift and Kotlin halves are unwritten, and nothing
 * here has run on a device. `AUTH-03`'s evidence -- that a refresh token is
 * absent from the WebView JS context and from every bridge response -- is a
 * physical-device check (approved decision 16) and is not claimed by this file
 * or by any test in this repository.
 */

/** Everything the WebView is allowed to learn about the session. */
export type MobileAccessGrant = {
  accessToken: string;
  /** Epoch milliseconds. The JS side schedules against this and nothing else. */
  expiresAt: number;
};

/**
 * The whole bridge surface.
 *
 * `getAccessToken` is the only way JS obtains a credential, and it is the
 * native layer's decision whether serving it required a refresh. Section 4's
 * single-flight lives behind this method, in one place, rather than in however
 * many tabs and components happen to ask at once.
 */
export type MobileAuthBridge = {
  /** A usable access token, refreshing behind the bridge if that is needed. */
  getAccessToken(): Promise<MobileAccessGrant>;
  /** Whether the device holds a session at all. Never says what it holds. */
  hasSession(): Promise<{ signedIn: boolean }>;
  /** Ends the session. The native layer clears its own stored credential. */
  signOut(): Promise<void>;
};

/**
 * Member names the bridge may expose.
 *
 * A list rather than a comment because the rule is about what is *absent*, and
 * a reviewer cannot see an absence. Adding a member means adding it here, which
 * is the moment to ask what it returns.
 */
export const MOBILE_AUTH_BRIDGE_METHODS = [
  "getAccessToken",
  "hasSession",
  "signOut",
] as const;
