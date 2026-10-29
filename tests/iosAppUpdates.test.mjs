import assert from "node:assert/strict";
import test from "node:test";
import { appStoreUpdateState, createAppStoreUpdates } from "../apps/mobile/src/appStoreUpdates.ts";

const listing = { trackId: 6827148073, bundleId: "app.tomverse.shell", version: "1.0.19", minimumOsVersion: "17.4" };
const info = (item = listing, installedVersion = "1.0.18", systemVersion = "18.7.10") => ({
  installedVersion, systemVersion, lookup: { results: item ? [item] : [] },
});

test("App Store versions compare numerically and have distinct dismissal identities", () => {
  const state = appStoreUpdateState(info());
  assert.equal(state.state, "available");
  assert.notEqual(state.versionCode, appStoreUpdateState(info({ ...listing, version: "1.0.20" })).versionCode);
  assert.equal(appStoreUpdateState(info({ ...listing, version: "1.10" }, "1.9.99")).state, "available");
  assert.equal(appStoreUpdateState(info({ ...listing, version: "2.0" }, "1.9999.9999")).state, "available");
});

for (const [name, value] of [
  ["unpublished app", info(null)],
  ["same version", info(listing, "1.0.19")],
  ["newer TestFlight version", info(listing, "1.0.20")],
  ["equivalent zero components", info({ ...listing, version: "1.0" }, "1.0.0")],
  ["unsupported iPadOS", info({ ...listing, minimumOsVersion: "19.0" })],
  ["another app ID", info({ ...listing, trackId: 1 })],
  ["another bundle", info({ ...listing, bundleId: "another.app" })],
  ["invalid version", info({ ...listing, version: "1.0.19-beta" })],
  ["missing minimum OS", info({ ...listing, minimumOsVersion: undefined })],
  ["malformed installed version", info(listing, "")],
  ["malformed system version", info(listing, "1", "unknown")],
  ["malformed lookup", { ...info(), lookup: null }],
]) test(`${name} leaves normal iOS use available without an update banner`, () => {
  assert.deepEqual(appStoreUpdateState(value), { state: "none", versionCode: 0 });
});

test("foreground checks share one in-flight lookup and refresh after five minutes", async () => {
  let clock = 0; let checks = 0; let opens = 0;
  const updates = createAppStoreUpdates({ check: async () => { checks++; return info(); }, start: async () => { opens++; return { accepted: true }; } }, () => clock);
  const states = await Promise.all([updates.check(), updates.check(), updates.check()]);
  assert.equal(checks, 1); assert.equal(opens, 0);
  assert.equal(states[0].state, "available");
  clock = 300_000; await updates.check(); assert.equal(checks, 2);
  const handle = await updates.addListener("stateChanged", () => assert.fail("App Store has no in-app download progress"));
  await handle.remove();
  await updates.complete(); assert.equal(opens, 0);
  await updates.start(); assert.equal(opens, 1);
  assert.equal((await updates.check()).state, "none");
});

test("network failures stay quiet and retry only at the next cache interval", async () => {
  let clock = 0; let checks = 0;
  const updates = createAppStoreUpdates({ check: async () => { checks++; throw Error("Offline"); }, start: async () => ({ accepted: false }) }, () => clock);
  assert.equal((await updates.check()).state, "none");
  await updates.check(); assert.equal(checks, 1);
  clock = 300_000; await updates.check(); assert.equal(checks, 2);
});

test("a failed App Store handoff remains retryable without claiming installation", async () => {
  let opens = 0;
  const updates = createAppStoreUpdates({ check: async () => info(), start: async () => { opens++; throw Error("App Store unavailable"); } });
  await updates.check(); await assert.rejects(updates.start());
  assert.equal((await updates.check()).state, "available");
  await assert.rejects(updates.start()); assert.equal(opens, 2);
});
