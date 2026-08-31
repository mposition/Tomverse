/**
 * Capacitor configuration for the locally bundled Tomverse shell.
 *
 * The one thing this file must never grow is `server.url`. The delivery plan
 * (docs/policy/tomverse-chat-delivery-plan.md §2, §7) and the mobile
 * authentication policy (docs/policy/tomverse-chat-mobile-authentication.md,
 * "Deliberately excluded") both state that no production app points at a
 * hosted URL: it is a store-review risk, and it produces an origin the bearer
 * token policy cannot reason about. Capacitor's own configuration reference
 * says the same about `server.url`, `server.cleartext` and
 * `server.allowNavigation` -- each is documented as "not intended for use in
 * production".
 *
 * `npm run check:capacitor-local-bundle` fails the build if any of the three
 * appears here, so the rule is enforced rather than remembered.
 *
 * The default schemes are left alone deliberately, because they decide the
 * origin the API has to allowlist:
 *
 *   iOS      server.iosScheme      default `capacitor`  -> capacitor://localhost
 *   Android  server.androidScheme  default `https`      -> https://localhost
 *
 * Neither is an origin `lib/requestOrigin.ts` accepts today. That gap is
 * recorded in the readiness report, not worked around here.
 */
import type { CapacitorConfig } from "@capacitor/cli";

const config: CapacitorConfig = {
  // PROVISIONAL. This is the spike's identifier, not the product's.
  //
  // It is named here because `cap add` needs one, and it must be replaced
  // before anything depends on it. The deep-link association files are what
  // depend on it: `assetlinks.json` names the final `applicationId` together
  // with the SHA-256 fingerprint of the signing certificate, and
  // `apple-app-site-association` names `TEAMID.BUNDLEID`. Publishing either
  // with a placeholder is worse than publishing neither -- a failed
  // verification is cached, so the app does not silently fall back, it stays
  // unverified.
  //
  // Choosing the identifier also decides things this spike has not: the Apple
  // Team ID, and whether Android signs through Play App Signing or an upload
  // key (which changes the fingerprint the file must carry).
  appId: "app.tomverse.shell",
  appName: "Tomverse",
  // Vite's build output. `cap sync` copies this directory into the native
  // projects, which is what "locally bundled" means: the binary ships the web
  // assets rather than fetching them.
  webDir: "dist",
};

export default config;
