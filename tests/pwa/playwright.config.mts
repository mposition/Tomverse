import { defineConfig } from "@playwright/test";
import { fileURLToPath } from "node:url";
export default defineConfig({
  testDir: ".", testMatch: "*.spec.ts", workers: 1,
  use: { baseURL: "http://127.0.0.1:5187", serviceWorkers: "allow" },
  webServer: { command: "node node_modules/vite/bin/vite.js --config tests/pwa/vite.config.mts", cwd: fileURLToPath(new URL("../..", import.meta.url)), url: "http://127.0.0.1:5187", reuseExistingServer: false },
});
