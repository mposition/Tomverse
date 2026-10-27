import { defineConfig, devices } from "@playwright/test";
import base from "./playwright.ios.config";

const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) throw new Error("iOS design tests require one native test server.");

// WebKit device emulation verifies responsive UI, not native iOS permissions.
export default defineConfig({
  ...base,
  testDir: "../../tests/ios-design",
  outputDir: "../../test-results/ios-design",
  timeout: 45_000,
  use: { ...base.use, baseURL: "http://127.0.0.1:15188" },
  webServer: { ...webServer, command: "npm run dev -- --host 127.0.0.1 --port 15188 --strictPort", url: "http://127.0.0.1:15188" },
  projects: [
    { name: "ios-iphone", use: { ...devices["iPhone 13"], browserName: "webkit" } },
    { name: "ios-ipad-7", use: { ...devices["iPad (gen 7)"], browserName: "webkit" } },
    { name: "ios-ipad-7-landscape", use: { ...devices["iPad (gen 7) landscape"], browserName: "webkit" } },
  ],
});
