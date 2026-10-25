import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/native-e2e", fullyParallel: false, workers: 1, retries: 0,
  use: { baseURL: "http://127.0.0.1:3191", viewport: { width: 390, height: 844 }, locale: "en-US", trace: "retain-on-failure" },
  webServer: {
    command: "npm run dev --workspace @tomverse/mobile -- --host 127.0.0.1 --port 3191 --strictPort",
    url: "http://127.0.0.1:3191", reuseExistingServer: false,
    env: { VITE_NATIVE_CHAT_ENABLED: "true", VITE_NATIVE_BILLING_ENABLED: "true",
      VITE_REVENUECAT_GOOGLE_API_KEY: "goog_native_fixture_public_key", VITE_TOMVERSE_API_ORIGIN: "https://api.native-chat.test" },
  },
});
