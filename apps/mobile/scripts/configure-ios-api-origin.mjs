import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export function iosApiOrigin(value = "https://tomverse.app") {
  assert.ok(["https://tomverse.app", "https://staging.tomverse.app"].includes(value), "iOS builds require the production or isolated staging API origin.");
  return value;
}

export function configureIosApiOrigin(root, environment = process.env) {
  const path = resolve(root, "apps/mobile/ios/App/App/capacitor.config.json");
  const config = JSON.parse(readFileSync(path, "utf8"));
  const origin = iosApiOrigin(environment.VITE_TOMVERSE_API_ORIGIN);
  if (environment.VITE_NATIVE_BILLING_ENABLED === "true") {
    assert.match(environment.VITE_REVENUECAT_APPLE_API_KEY ?? "", /^appl_[A-Za-z0-9]{8,}$/, "An enabled iOS billing build requires its Apple public SDK key.");
  }
  config.plugins = { ...config.plugins, MobileAuth: { ...config.plugins?.MobileAuth, apiOrigin: origin } };
  writeFileSync(path, JSON.stringify(config, null, 2));
  return origin;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  console.log(`Prepared native iOS authentication for ${configureIosApiOrigin(fileURLToPath(new URL("../../..", import.meta.url)))}`);
}
