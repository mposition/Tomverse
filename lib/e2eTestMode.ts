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

/**
 * True only in full fixture mode, when the assistant knowledge flag is requested.
 *
 * The flag it stands in for lives in `AppSetting`, and `isE2EDatabaseDisabled()`
 * means there is no row to read -- so `isAssistantKnowledgeEnabled()` answered
 * `false` for every Playwright run and the knowledge panel never rendered. That
 * was invisible while the panel discovered its own availability from an endpoint
 * the specs could mock; it stopped being invisible when the availability became
 * a server-rendered prop and seven specs began asserting against a panel that
 * was not there.
 *
 * Gated on `isE2EFixtureMode()` rather than the variable alone, and deliberately
 * stricter than the two flags beside it: those each need loopback, this needs
 * loopback *and* both of them already active. A server with a real database and
 * real sessions has no business reading a feature flag out of the environment,
 * so the only configuration that can reach this is the one that is already
 * entirely fabricated.
 */
export const isE2EAssistantKnowledgeEnabled = () =>
  process.env.E2E_ASSISTANT_KNOWLEDGE_ENABLED === "true" && isE2EFixtureMode();
