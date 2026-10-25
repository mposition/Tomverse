import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";

export default defineConfig({
  testDir: "../../tests/native-mobile",
  timeout: 30_000,
  outputDir: "../../test-results/native-mobile",
  use: { baseURL: "http://127.0.0.1:5186", viewport: { width: 390, height: 844 }, locale: "ko-KR", trace: "retain-on-failure" },
  workers: 2,
  projects: [{ name: "native-ui-chromium", use: { browserName: "chromium", launchOptions: { args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] } } }],
  webServer: {
    command: "npm run dev -- --host 127.0.0.1 --port 5186 --strictPort",
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    env: { VITE_TOMVERSE_DEMO: "true" },
    url: "http://127.0.0.1:5186",
    reuseExistingServer: false,
  },
});
