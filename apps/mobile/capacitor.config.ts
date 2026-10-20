import type { CapacitorConfig } from "@capacitor/cli";

// The existing development identifier is retained until the owner chooses the
// production app identifiers. No association or store identity is claimed.
const config: CapacitorConfig = {
  appId: "app.tomverse.shell",
  appName: "Tomverse",
  webDir: "dist",
  plugins: { MobileAuth: { apiOrigin: "https://tomverse.app" } },
};
export default config;
