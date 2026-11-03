import assert from "node:assert/strict";
import test from "node:test";
import { createChatLocationSession } from "../packages/chat-core/src/location.ts";
import { createNativeLocationConsent } from "../apps/mobile/src/locationConsent.ts";

const tick = () => new Promise(setImmediate);
const storage = () => {
  const values = new Map();
  return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), values };
};
function fixture(saved = storage(), native = true) {
  const reads = []; const requests = [];
  let permission = "prompt";
  const plugin = {
    checkPermissions: async () => ({ coarseLocation: permission }),
    requestPermissions: async options => { requests.push(options); permission = "granted"; return { coarseLocation: permission }; },
  };
  const session = createChatLocationSession(async requested => {
    reads.push(requested);
    if (permission !== "granted") throw new Error("denied");
    return { latitude: -27.469, longitude: 153.025, accuracy: 500, timestamp: Date.now() };
  });
  const consent = createNativeLocationConsent(session, plugin, native, saved);
  return { ...consent, plugin, reads, requests, saved, setPermission: value => { permission = value; } };
}

test("first-run permission is coarse, deduplicated and activates only after sign-in", async () => {
  const app = fixture();
  assert.equal(app.needsPrompt(), true);
  const first = app.accept(); const second = app.accept();
  assert.equal(first, second); await first;
  assert.deepEqual(app.requests, [{ permissions: ["coarseLocation"] }]);
  assert.equal(app.needsPrompt(), false); assert.deepEqual(app.reads, []);
  app.location.setIdentity("account-a"); await tick();
  assert.equal(app.location.isEnabled("account-a"), true);
  assert.deepEqual(app.reads, [false]);
  const saved = [...app.saved.values.values()].join("");
  assert.ok(!saved.includes("latitude")); assert.ok(!saved.includes("153.025"));
});

test("declining first-run consent suppresses automatic location reads and survives restart", async () => {
  const app = fixture(); app.skip();
  const restarted = fixture(app.saved); restarted.setPermission("granted");
  assert.equal(restarted.needsPrompt(), false);
  restarted.location.setIdentity("account-a"); await tick();
  let decisions = 0;
  assert.equal(await restarted.location.readForTurn("account-a", undefined, { turnId: "nearby", requiresLocation: async () => { decisions++; return true; } }), null);
  assert.equal(decisions, 0); assert.deepEqual(restarted.reads, []);
});

test("OS denial leaves the switch off and does not show the first-run prompt again", async () => {
  const app = fixture();
  app.plugin.requestPermissions = async () => ({ coarseLocation: "denied" });
  await assert.rejects(app.accept(), /denied/);
  app.location.setIdentity("account-a"); await tick();
  assert.equal(app.location.isEnabled("account-a"), false); assert.deepEqual(app.reads, []);
  assert.equal(fixture(app.saved).needsPrompt(), false);
});

test("manual off remains off after restart even with OS permission still granted", async () => {
  const app = fixture(); await app.accept();
  app.location.setIdentity("account-a"); await tick(); app.location.disable();
  const restarted = fixture(app.saved); restarted.setPermission("granted");
  restarted.location.setIdentity("account-a"); await tick();
  assert.equal(restarted.location.isEnabled("account-a"), false);
  assert.deepEqual(restarted.reads, []);
  assert.equal(await restarted.location.readForTurn("account-a", undefined, { turnId: "nearby", requiresLocation: async () => true }), null);
});

test("consent restores its account without a new prompt and never carries into another account", async () => {
  const app = fixture(); await app.accept(); app.location.setIdentity("account-a"); await tick();
  const restarted = fixture(app.saved); restarted.setPermission("granted");
  restarted.location.setIdentity("account-a"); await tick();
  assert.equal(restarted.location.isEnabled("account-a"), true); assert.deepEqual(restarted.requests, []);
  restarted.location.setIdentity(null); restarted.location.setIdentity("account-b"); await tick();
  assert.equal(restarted.location.isEnabled("account-b"), false); assert.deepEqual(restarted.reads, [false]);
  await restarted.location.enable("account-b");
  assert.equal(restarted.location.isEnabled("account-b"), true);
});

test("permission completing after an account switch cannot authorize the next account", async () => {
  const app = fixture(); app.location.setIdentity("account-a");
  let grant;
  app.plugin.requestPermissions = () => new Promise(resolve => { grant = resolve; });
  const accepting = app.accept(); await tick();
  app.location.setIdentity(null); app.location.setIdentity("account-b");
  app.setPermission("granted"); grant({ coarseLocation: "granted" }); await accepting;
  assert.equal(app.location.isEnabled("account-b"), false); assert.deepEqual(app.reads, []);
});

test("revoked OS permission and browser previews never auto-acquire location", async () => {
  const app = fixture(); await app.accept(); app.location.setIdentity("account-a"); await tick();
  const restarted = fixture(app.saved); restarted.setPermission("denied");
  restarted.location.setIdentity("account-a"); await tick();
  assert.deepEqual(restarted.requests, []); assert.deepEqual(restarted.reads, []);
  const web = fixture(storage(), false); web.location.setIdentity("account-a");
  assert.equal(web.needsPrompt(), false); await web.accept(); assert.deepEqual(web.requests, []);
});
