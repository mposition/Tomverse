import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

// Desktop WebKit catches browser compatibility problems before the first Mac
// build. It does not establish WKWebView permissions or native-device behavior.
export default defineConfig({
  ...base,
  outputDir: "../../test-results/native-mobile-webkit",
  // These existing cases depend on Chromium fake media devices or GPS emulation.
  // Windows WebKit lacks those APIs. They remain in the Chromium suite and in
  // the Mac/device acceptance list; do not claim desktop WebKit verifies them.
  grepInvert: /voice returns mixed-language editable text|microphone refusal leaves typed input|microphone device failure|voice server refusal|voice start refusal|native voice delegates to the existing Chat|current native composer keeps location|native Chat and Review share only/,
  projects: [{ name: "native-ui-webkit", use: { browserName: "webkit" } }],
});
