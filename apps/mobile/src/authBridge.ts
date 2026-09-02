/**
 * The Capacitor plugin handle, and what happens when there is no native layer.
 *
 * Contract: .github/audits/2026-08-31-native-mobile-auth-n2-design-approval.md
 * D19, approved 2026-08-31.
 *
 * ## The web implementation refuses, and that is the design
 *
 * Capacitor lets a plugin ship a web fallback, and the obvious one here would
 * call `/api/auth/mobile/refresh` from JavaScript. That fallback would put a
 * refresh token in the JS heap -- which is precisely what D19 exists to
 * prevent, and it would do it on the platform with the largest script-injection
 * surface. A policy sentence that says "the refresh token never reaches the
 * WebView" would become false, quietly, in the one build a developer looks at
 * most.
 *
 * So the web implementation answers "no session" and nothing else. In a browser
 * the app is not signed in. That is a real limitation of running the shell
 * outside a device, not a gap to be filled later.
 *
 * ## The native halves are unwritten
 *
 * There is no Swift and no Kotlin in this repository, and nothing here has run
 * on a device. `registerPlugin` names a plugin that does not exist yet; on a
 * device without it, every call rejects, which is the same answer as the web
 * fallback and for the same reason. `AUTH-03`'s evidence -- that no refresh
 * token is present in the WebView context -- is a physical-device check
 * (approved decision 16) and is not claimed by this file.
 */

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

/**
 * The app's authenticated request function.
 *
 * `authenticatedFetch` takes the bridge as an argument so it can be tested
 * without a plugin; this binds it to the real one, once, so product code has a
 * single entry point and no reason to reach for `MobileAuth` itself.
 *
 * Nothing imports it yet. The screen this bundle ships is a readiness report
 * that deliberately makes no authenticated request, and the product surface it
 * will eventually carry is a later phase of the delivery plan. What exists now
 * is the boundary, checked by `npm run check:native-token-boundary`, so the
 * code written against it later cannot quietly widen it.
 */
export const mobileApiFetch = (input: string, init?: RequestInit) =>
  authenticatedFetch(input, init, { bridge: MobileAuth });
