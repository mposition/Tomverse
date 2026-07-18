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
      use: { ...devices["Desktop Chrome"], viewport: { width: 1920, height: 1080 } },
    },
    {
      name: "desktop-compact",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1366, height: 768 } },
    },
    {
      name: "mobile-safari",
      use: { ...devices["iPhone 13"], viewport: { width: 390, height: 844 } },
    },
    {
      name: "mobile-chromium",
      use: {
        ...devices["Pixel 5"],
        viewport: { width: 412, height: 915 },
      },
    },
  ],
});
