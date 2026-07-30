/**
 * Single source of truth for the Playwright-only test short-circuits.
 *
 * These flags let the E2E server run without a database and with a fabricated
 * session. Gating them on the flag alone was too weak: a stray environment
 * variable copied from `playwright.config.ts`, or a compromised CI variable,
 * would enable them against real traffic.
 *
 * `NODE_ENV` is not a usable guard here - the Playwright server runs
 * `next start`, which sets `NODE_ENV=production` - so the flags are additionally
 * gated on the app being served from a loopback origin. A real deployment always
 * has a public `NEXTAUTH_URL`, so the short-circuits cannot activate there even
 * if the flag is set, while the E2E server (127.0.0.1:3100) and `next dev`
 * (localhost) both qualify.
 *
 * `/api/ready` independently reports not-ready when either flag is set with
 * `NODE_ENV=production` (see lib/securityEnvironment.ts), so a misconfigured
 * deploy also fails its health gate rather than serving traffic.
 */

const LOOPBACK_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "::1",
  "[::1]",
  "0.0.0.0",
]);

/**
 * True when the app is configured to serve from a loopback address, i.e. a local
 * development or automated-test server rather than a real deployment.
 */
const isLoopbackDeployment = () => {
  const configuredUrl = process.env.NEXTAUTH_URL?.trim();
  if (!configuredUrl) return false;
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(configuredUrl).hostname.toLowerCase());
  } catch {
    // An unparseable NEXTAUTH_URL is not proof of a local server: fail closed.
    return false;
  }
};

/** True only on a loopback server, when the Playwright auth bypass is requested. */
export const isE2EAuthBypassEnabled = () =>
  process.env.E2E_AUTH_BYPASS === "true" && isLoopbackDeployment();

/** True only on a loopback server, when the Playwright database stub is requested. */
export const isE2EDatabaseDisabled = () =>
  process.env.E2E_DISABLE_DATABASE === "true" && isLoopbackDeployment();

/** True only on a loopback server, when both Playwright short-circuits are active. */
export const isE2EFixtureMode = () =>
  isE2EAuthBypassEnabled() && isE2EDatabaseDisabled();
