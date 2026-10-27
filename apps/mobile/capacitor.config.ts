import type { CapacitorConfig } from "@capacitor/cli";

// This identifier matches the registered Apple App ID. Domain association and
// signed-device acceptance remain separate operational steps.
const config: CapacitorConfig = {
  appId: "app.tomverse.shell",
  appName: "Tomverse",
  webDir: "dist",
  // Bridge debug logs include plugin result data, including access grants.
  loggingBehavior: "none",
  plugins: { MobileAuth: { apiOrigin: "https://tomverse.app" } },
};
export default config;
