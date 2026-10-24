import assert from "node:assert/strict";
import test from "node:test";
import { createNativeLocationReader } from "../apps/mobile/src/location.ts";
import { withAndroidLocationPermission, withIosLocationPermission } from "../apps/mobile/scripts/configure-location-permissions.mjs";

const position = { coords: { latitude: 1, longitude: 2, accuracy: 3 }, timestamp: Date.now() };

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
  assert.ok(ios.indexOf("NSLocationWhenInUseUsageDescription") > ios.indexOf("<dict></dict>"));
  assert.equal(withIosLocationPermission(ios), ios);
});
