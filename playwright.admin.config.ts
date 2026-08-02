import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import {
  ADMIN_E2E_APP_PORT,
  ADMIN_E2E_BASE_URL,
  ADMIN_E2E_HOST,
  adminE2eNextAuthSecret,
  adminE2eServerEnv,
  resolveAdminE2EDatabaseUrl,
} from "./tests/e2e-admin/support/harness-config";

/**
 * The Admin Console E2E suite.
 *
 * It runs apart from `playwright.config.ts` because it needs the opposite
 * environment: a real database and a real NextAuth session instead of
 * `E2E_DISABLE_DATABASE` and the `__tomverse_e2e_auth` bypass. Keeping the two
 * configurations separate is what lets the user-facing suite keep its
 * database-free server while the admin suite drives the genuine admin routes.
 *
 * Start it with `npm run test:e2e:admin`, which validates the database URL and
 * pushes the Prisma schema before Playwright boots the server.
 *
 * The server is `next start` on a loopback http port with a TLS terminator in
 * front, because a production server names its session cookie
 * `__Secure-next-auth.session-token` and neither Chromium's cookie injection
 * nor Playwright's request context will carry that cookie over http. See
 * `tests/e2e-admin/support/harness-config.ts`, which also explains why this
 * harness adds no production-reachable bypass.
 */

const databaseUrl = resolveAdminE2EDatabaseUrl();
const networkGuard = resolve(
  process.cwd(),
  "tests/e2e/block-external-network.cjs"
).replaceAll("\\", "/");

// Same capability fallback the user-facing config documents: some runners
// cannot download Playwright's pinned Chromium and ship a pre-provisioned one
// instead. Unset, nothing changes.
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const chromiumLaunchOptions = chromiumExecutablePath
  ? { launchOptions: { executablePath: chromiumExecutablePath } }
  : {};

const canonicalRendering = {
  locale: "en-US",
  timezoneId: "UTC",
} as const;

export default defineConfig({
  testDir: "./tests/e2e-admin",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  // One worker, always: every test truncates and re-seeds the single fixture
  // database, so concurrent workers would reset each other's state.
  workers: 1,
  reporter: [["list"], ["html", { open: "never", outputFolder: "playwright-report-admin" }]],
  outputDir: "test-results-admin",
  globalTeardown: "./tests/e2e-admin/support/global-teardown.ts",
  use: {
    baseURL: ADMIN_E2E_BASE_URL,
    // The certificate the terminator mints for 127.0.0.1 is self-signed and
    // regenerated per run, so nothing can vouch for it. Scoped to this suite's
    // own loopback origin, which is the only host it can reach.
    ignoreHTTPSErrors: true,
    // `next start` sets NODE_ENV=production, and `lib/requestOrigin.ts`
    // requires a production mutation's Origin to be https. TLS terminates at
    // 127.0.0.1:3101 and `next start` is reached over loopback http behind it,
    // so this states the terminated protocol exactly as a reverse proxy in
    // front of a real deployment does -- and it is now true rather than a
    // concession. Without it every UI-driven mutation would be refused by the
    // CSRF guard before any admin permission check ran, which would make role
    // tests pass for the wrong reason.
    extraHTTPHeaders: { "x-forwarded-proto": "https" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  // Two processes, because `next start` cannot serve TLS and the suite needs
  // https to hold a `__Secure-` session cookie at all. Playwright starts both
  // and waits for both; the terminator's own readiness probe only succeeds once
  // the application behind it answers, so the order they come up in does not
  // matter.
  webServer: [
    {
      name: "admin-e2e-app",
      command: `next start -H ${ADMIN_E2E_HOST} -p ${ADMIN_E2E_APP_PORT}`,
      // Waits for the port to accept connections rather than for a page.
      // `ALLOWED_REQUEST_HOSTS` names the public origin only, so an http probe
      // sent straight at the internal port is refused by the host allowlist --
      // correctly. The end-to-end readiness check is the terminator's, below.
      port: ADMIN_E2E_APP_PORT,
      env: adminE2eServerEnv({
        databaseUrl,
        nextAuthSecret: adminE2eNextAuthSecret(),
        networkGuardPath: networkGuard,
        nodeOptions: process.env.NODE_OPTIONS,
      }),
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
    {
      name: "admin-e2e-tls",
      command: "node scripts/admin-e2e-tls-terminator.mjs",
      url: `${ADMIN_E2E_BASE_URL}/auth/signin`,
      ignoreHTTPSErrors: true,
      reuseExistingServer: !process.env.CI,
      timeout: 120_000,
    },
  ],
  projects: [
    {
      name: "admin-desktop",
      // The responsive suite asserts the drawer, which only exists below `lg`.
      testIgnore: /admin-shell-responsive\.spec\.ts/,
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: 1,
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
    {
      name: "admin-mobile",
      testMatch: /admin-shell-responsive\.spec\.ts/,
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 412, height: 915 },
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
  ],
});
