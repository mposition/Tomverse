import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";
import {
  ADMIN_E2E_BASE_URL,
  ADMIN_E2E_HOST,
  ADMIN_E2E_PORT,
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
 * See `tests/e2e-admin/support/harness-config.ts` for why this harness adds no
 * production-reachable bypass.
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
    // `next start` sets NODE_ENV=production, and `lib/requestOrigin.ts`
    // requires a production mutation's Origin to be https. The harness serves
    // plain http on loopback, so it declares the terminated protocol the same
    // way a reverse proxy in front of a real deployment does -- the branch the
    // module already reads. Without it every UI-driven mutation would be
    // refused by the CSRF guard before any admin permission check ran, which
    // would make role tests pass for the wrong reason.
    extraHTTPHeaders: { "x-forwarded-proto": "http" },
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: `next start -H ${ADMIN_E2E_HOST} -p ${ADMIN_E2E_PORT}`,
    url: `${ADMIN_E2E_BASE_URL}/auth/signin`,
    env: adminE2eServerEnv({
      databaseUrl,
      nextAuthSecret: adminE2eNextAuthSecret(),
      networkGuardPath: networkGuard,
      nodeOptions: process.env.NODE_OPTIONS,
    }),
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
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
