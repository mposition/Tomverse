import assert from "node:assert/strict";
import test from "node:test";
import { createNativeLocationReader } from "../apps/mobile/src/location.ts";
import { withAndroidLocationPermission, withIosLocationPermission } from "../apps/mobile/scripts/configure-location-permissions.mjs";

const position = { coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: Date.now() };

test("a device's existing always-allow grant never requests permission again, even after app reload", async () => {
  let reads = 0;
  const reader = createNativeLocationReader({
    checkPermissions: async () => ({ coarseLocation: "granted", location: "granted" }),
    requestPermissions: async () => { throw Error("must not re-prompt an existing device grant"); },
    getCurrentPosition: async () => { reads++; return position; },
  }, true);
  await reader(true); await reader(false); await reader(true);
  assert.equal(reads, 3);
});

test("native opt-in requests only coarse permission and each read asks for a fresh fix", async () => {
  const calls = [];
  const reader = createNativeLocationReader({
    checkPermissions: async () => ({ coarseLocation: "prompt", location: "prompt" }),
    requestPermissions: async (options) => { calls.push(options); return { coarseLocation: "granted", location: "denied" }; },
    getCurrentPosition: async (options) => { calls.push(options); return position; },
  }, true);
  assert.deepEqual(await reader(true), { latitude: 1, longitude: 2, accuracy: 3, timestamp: position.timestamp });
  assert.deepEqual(calls[0], { permissions: ["coarseLocation"] });
  assert.equal(calls[1].maximumAge, 0);
  assert.equal(calls[1].enableHighAccuracy, false);
  assert.equal(calls[1].timeout, 10_000);
  await assert.rejects(reader(false), /denied/);
  assert.equal(calls.length, 2);
});

test("denial never reads the native device and plugin errors are normalized", async () => {
  let reads = 0;
  const plugin = {
    checkPermissions: async () => ({ coarseLocation: "granted" }),
    requestPermissions: async () => ({ coarseLocation: "denied" }),
    getCurrentPosition: async () => { reads++; throw { code: "OS-PLUG-GLOC-0010" }; },
  };
  await assert.rejects(createNativeLocationReader(plugin, true)(false), /timeout/);
  plugin.checkPermissions = async () => ({ coarseLocation: "denied" });
  await assert.rejects(createNativeLocationReader(plugin, true)(true), /denied/);
  assert.equal(reads, 1);
});

test("web preview uses the plugin web implementation without unsupported native permission requests", async () => {
  const unsupported = async () => { throw new Error("native permission API called"); };
  assert.equal((await createNativeLocationReader({ checkPermissions: unsupported,
    requestPermissions: unsupported, getCurrentPosition: async () => position }, false)(true)).latitude, 1);
});

test("native sync adds foreground permission declarations idempotently without background authority", () => {
  const android = withAndroidLocationPermission('<manifest xmlns:android="http://schemas.android.com/apk/res/android"><application /></manifest>');
  assert.ok(android.includes("ACCESS_COARSE_LOCATION"));
  assert.ok(!android.includes("ACCESS_FINE_LOCATION"));
  assert.ok(!android.includes("ACCESS_BACKGROUND_LOCATION"));
  assert.equal(withAndroidLocationPermission(android), android);
  const ios = withIosLocationPermission("<plist><dict><key>Existing</key><dict></dict></dict></plist>");
  assert.ok(ios.includes("NSLocationWhenInUseUsageDescription"));
  assert.ok(!ios.includes("UIBackgroundModes"));
  assert.ok(ios.includes("<key>NSLocationDefaultAccuracyReduced</key>\n\t<true/>"));
  assert.ok(ios.indexOf("NSLocationWhenInUseUsageDescription") > ios.indexOf("<dict></dict>"));
  assert.equal(withIosLocationPermission(ios), ios);
});


test("native permission prompts do not consume the foreground acquisition deadline", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let grant;
  let reads = 0;
  const pendingPermission = new Promise((resolve) => { grant = resolve; });
  const reader = createNativeLocationReader({
    checkPermissions: async () => ({ coarseLocation: "prompt" }),
    requestPermissions: () => pendingPermission,
    getCurrentPosition: async () => { reads++; return position; },
  }, true);
  let outcome = "pending";
  const result = reader(true).then((value) => { outcome = "resolved"; return value; });
  await Promise.resolve();
  t.mock.timers.tick(30_000);
  await Promise.resolve();
  assert.equal(outcome, "pending"); assert.equal(reads, 0);
  grant({ coarseLocation: "granted" });
  assert.equal((await result).latitude, 1);
  assert.equal(reads, 1);
});

test("a plugin rejection after the acquisition deadline is still handled", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let rejectAcquisition;
  const reader = createNativeLocationReader({
    checkPermissions: async () => ({ coarseLocation: "granted" }),
    getCurrentPosition: () => new Promise((_, reject) => { rejectAcquisition = reject; }),
  }, true);
  const result = reader(false);
  const rejected = assert.rejects(result, /timeout/);
  await Promise.resolve();
  t.mock.timers.tick(11_000);
  await rejected;
  rejectAcquisition(new Error("late plugin failure"));
  // node:test also fails on a late unhandled rejection from the losing promise.
  await new Promise(setImmediate);
});

test("iOS location descriptions follow nested URL-type dictionaries in the root", () => {
  const source = '<plist><dict><key>CFBundleURLTypes</key><array><dict><key>CFBundleURLSchemes</key><array><string>tomverse</string></array></dict></array></dict></plist>';
  const result = withIosLocationPermission(source);
  for (const key of ["NSLocationWhenInUseUsageDescription", "NSLocationAlwaysAndWhenInUseUsageDescription", "NSLocationDefaultAccuracyReduced"]) {
    assert.ok(result.indexOf(`<key>${key}</key>`) > result.lastIndexOf("</array>"));
    assert.ok(result.indexOf(`<key>${key}</key>`) < result.lastIndexOf("</dict>"));
  }
});
