import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const baseURL = "http://127.0.0.1:3100";
const e2eTurnstileSiteKey =
  process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ||
  "tomverse-playwright-turnstile-site-key";
// This key is scoped to the isolated E2E server. It never protects production
// sessions, and keeps NextAuth's production secret requirement enabled.
const e2eNextAuthSecret =
  process.env.NEXTAUTH_SECRET || "tomverse-e2e-nextauth-secret-only-2026";
const networkGuard = resolve(process.cwd(), "tests/e2e/block-external-network.cjs").replaceAll("\\", "/");
const nodeOptions = [process.env.NODE_OPTIONS, `--require "${networkGuard}"`]
  .filter(Boolean)
  .join(" ");
const allowedRequestHosts = [
  ...(process.env.ALLOWED_REQUEST_HOSTS ?? "")
    .split(",")
    .map((host) => host.trim())
    .filter(Boolean),
  "127.0.0.1:3100",
  "localhost:3100",
].filter((host, index, hosts) => hosts.indexOf(host) === index);

// EXT-REAUDIT-F001. Some runners cannot reach cdn.playwright.dev, so
// `npx playwright install` fails and the Chromium projects cannot launch at
// all. Those images ship a pre-provisioned Chromium instead; pointing
// PLAYWRIGHT_CHROMIUM_EXECUTABLE at it lets the canonical projects run there.
//
// This is a capability fallback, never the default: unset -- which is the
// case in CI and on developer machines -- Playwright uses its own pinned
// build and nothing about the canonical projects changes. A run that sets it
// is NOT canonical, so its screenshots must not be treated as golden
// evidence (see docs/qa/canonical-visual-baseline.md).
const chromiumExecutablePath =
  process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || undefined;
const chromiumLaunchOptions = chromiumExecutablePath
  ? { launchOptions: { executablePath: chromiumExecutablePath } }
  : {};

// The canonical visual baseline, pinned so a golden compares like with like.
// Locale and time zone both change what gets rasterised -- a locale picks a
// different font stack for the same text (`:lang()` selects Noto Sans KR/SC
// per docs/ui-contracts/typography.md), and a time zone moves every rendered
// date -- so neither may be inherited from whatever machine happens to be
// running.
//
// Device pixel ratio is deliberately NOT set here: it belongs to the device
// preset each project already declares, and forcing Pixel 5's 2.625 down to 1
// would silently re-rasterise every mobile golden. Full policy, including the
// runner image and which platforms may judge a golden at all, is in
// docs/qa/canonical-visual-baseline.md.
const canonicalRendering = {
  locale: "en-US",
  timezoneId: "UTC",
} as const;

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : 4,
  reporter: [["list"], ["html", { open: "never" }]],
  outputDir: "test-results",
  use: {
    baseURL,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: {
    command: "npm run start:e2e",
    url: baseURL,
    env: {
      ALLOWED_REQUEST_HOSTS: allowedRequestHosts.join(","),
      DATABASE_URL:
        "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1",
      DISABLE_CSP_UPGRADE_INSECURE_REQUESTS: "true",
      DIRECT_URL:
        "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1",
      E2E_AUTH_BYPASS: "true",
      E2E_DISABLE_DATABASE: "true",
      NEXTAUTH_URL: baseURL,
      NEXTAUTH_SECRET: e2eNextAuthSecret,
      NEXT_PUBLIC_TURNSTILE_SITE_KEY: e2eTurnstileSiteKey,
      NODE_OPTIONS: nodeOptions,
      REQUIRE_CLOUDFLARE_ORIGIN_SECRET: "false",
    },
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
  projects: [
    {
      name: "desktop-chromium",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1920, height: 1080 },
        deviceScaleFactor: 1,
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
    {
      name: "desktop-compact",
      use: {
        ...devices["Desktop Chrome"],
        viewport: { width: 1366, height: 768 },
        deviceScaleFactor: 1,
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
    {
      name: "mobile-safari",
      use: {
        ...devices["iPhone 13"],
        viewport: { width: 390, height: 844 },
        ...canonicalRendering,
      },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 412, height: 915 },
        ...canonicalRendering,
        ...chromiumLaunchOptions,
      },
    },
  ],
});
