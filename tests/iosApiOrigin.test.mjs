import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { configureIosApiOrigin, iosApiOrigin } from "../apps/mobile/scripts/configure-ios-api-origin.mjs";

test("iOS preparation defaults to the existing production origin", () => {
  assert.equal(iosApiOrigin(), "https://tomverse.app");
});

for (const origin of ["http://tomverse.app", "https://tomverse.app/", "https://tomverse.app@other.invalid", "https://tomverse.app.other.invalid", "https://other.invalid/https://tomverse.app", "https://staging.tomverse.app.other.invalid", "https://other.invalid", "https://staging.tomverse.app:443", ""]) {
  test(`iOS preparation refuses an unapproved origin: ${origin}`, () => assert.throws(() => iosApiOrigin(origin)));
}

for (const origin of ["https://tomverse.app", "https://staging.tomverse.app"]) test(`native iOS authentication uses the selected API without changing Android: ${origin}`, t => {
  const root = mkdtempSync(join(tmpdir(), "tomverse-ios-origin-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const ios = join(root, "apps/mobile/ios/App/App");
  const android = join(root, "apps/mobile/android/app/src/main/assets");
  mkdirSync(ios, { recursive: true }); mkdirSync(android, { recursive: true });
  const config = { appId: "app.tomverse.shell", loggingBehavior: "none", packageClassList: ["MobileAuthPlugin"], plugins: { MobileAuth: { apiOrigin: "https://tomverse.app" }, OtherPlugin: { enabled: true } } };
  writeFileSync(join(ios, "capacitor.config.json"), JSON.stringify(config));
  writeFileSync(join(android, "capacitor.config.json"), JSON.stringify(config));
  assert.equal(configureIosApiOrigin(root, { VITE_TOMVERSE_API_ORIGIN: origin }), origin);
  const actual = JSON.parse(readFileSync(join(ios, "capacitor.config.json"), "utf8"));
  assert.equal(actual.plugins.MobileAuth.apiOrigin, origin);
  assert.equal(actual.server, undefined);
  assert.equal(actual.loggingBehavior, "none");
  assert.deepEqual(actual.packageClassList, config.packageClassList);
  assert.deepEqual(actual.plugins.OtherPlugin, config.plugins.OtherPlugin);
  assert.deepEqual(JSON.parse(readFileSync(join(android, "capacitor.config.json"), "utf8")), config);
  for (const apiKey of [undefined, "goog_not_an_apple_key", "test_not_an_apple_key"]) {
    assert.throws(() => configureIosApiOrigin(root, { VITE_TOMVERSE_API_ORIGIN: origin, VITE_NATIVE_BILLING_ENABLED: "true", VITE_REVENUECAT_APPLE_API_KEY: apiKey }), /Apple public SDK key/);
  }
  assert.equal(configureIosApiOrigin(root, { VITE_TOMVERSE_API_ORIGIN: origin, VITE_NATIVE_BILLING_ENABLED: "true", VITE_REVENUECAT_APPLE_API_KEY: "appl_syntheticpublickey" }), origin);
});
