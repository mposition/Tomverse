import { defineConfig } from "@playwright/test";
import base from "./playwright.native.config";

// Synthetic bridges exercise Apple-specific client behavior without a store,
// server credentials or a payment. StoreKit still needs signed-device acceptance.
export default defineConfig({
  ...base,
  testDir: "./tests/ios-billing",
  testMatch: "ios-billing.spec.ts",
  outputDir: "./test-results/ios-billing",
  projects: [
    { name: "ios-billing-webkit", use: { browserName: "webkit" } },
    { name: "ios-billing-chromium", use: { browserName: "chromium" } },
  ],
  webServer: {
    ...base.webServer,
    env: {
      VITE_NATIVE_BILLING_ENABLED: "true",
      VITE_REVENUECAT_APPLE_API_KEY: "appl_ios_fixture_public_key",
      VITE_TOMVERSE_API_ORIGIN: "https://api.native-chat.test",
    },
  },
});
