import { defineConfig } from "@playwright/test";
import base from "./playwright.native.config";

const webServer = base.webServer;
if (!webServer || Array.isArray(webServer)) {
  throw new Error("iOS billing tests require a single native test server.");
}

// Synthetic bridges exercise Apple-specific client behavior without a store,
// server credentials or a payment. StoreKit still needs signed-device acceptance.
export default defineConfig({
  ...base,
  use: { ...base.use, baseURL: "http://127.0.0.1:13192" },
  testDir: "./tests/ios-billing",
  testMatch: "ios-billing.spec.ts",
  outputDir: "./test-results/ios-billing",
  projects: [
    { name: "ios-billing-webkit", use: { browserName: "webkit" } },
    { name: "ios-billing-chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    ...webServer,
    command: "npm run dev --workspace @tomverse/mobile -- --host 127.0.0.1 --port 13192 --strictPort",
    url: "http://127.0.0.1:13192",
    env: {
      VITE_NATIVE_BILLING_ENABLED: "true",
      VITE_REVENUECAT_APPLE_API_KEY: "appl_ios_fixture_public_key",
      VITE_TOMVERSE_API_ORIGIN: "https://api.native-chat.test",
    },
  },
});
