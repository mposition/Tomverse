import { defineConfig, devices } from "@playwright/test";
import { resolve } from "node:path";

const baseURL = "http://127.0.0.1:3100";
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
  workers: process.env.CI ? 1 : undefined,
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
      DISABLE_CSP_UPGRADE_INSECURE_REQUESTS: "true",
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
