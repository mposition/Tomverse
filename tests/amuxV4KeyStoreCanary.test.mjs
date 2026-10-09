import assert from "node:assert/strict";
import { test } from "node:test";
import { approvedAmuxV4KeyCanaryTarget, verifyAmuxV4KeyStoreCanary,
  verifyStagingKeyCanary } from "../scripts/amux-v4-key-store-canary.mjs";
const staging = { RAILWAY_ENVIRONMENT_ID: "9347d760-66f6-430b-8f2f-36fd5dbef333",
  AMUX_V4_STAGING_KEY_CANARY: "approved" };
const productionId = "1e5f6f12-4281-4879-ae75-8ab0d2a57b44";
const production = { RAILWAY_ENVIRONMENT_ID: productionId,
  RAILWAY_ENVIRONMENT_NAME: "production",
  AMUX_V4_PRODUCTION_KEY_CANARY: "approved",
  AMUX_V4_PRODUCTION_KEY_CANARY_ENVIRONMENT_ID: productionId };
const scoped = () => ({ masterKeyId: "amux2-" + "a".repeat(43), masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3), digestKeyId: "synthetic-digest", digestKey: Buffer.alloc(32, 4) });

test("production, missing target and missing explicit gate never touch storage", async () => {
  for (const env of [{}, { ...staging, AMUX_V4_STAGING_KEY_CANARY: "disabled" },
    { ...production, AMUX_V4_PRODUCTION_KEY_CANARY: "disabled" },
    { ...production, RAILWAY_ENVIRONMENT_NAME: "staging" },
    { ...production, AMUX_V4_PRODUCTION_KEY_CANARY_ENVIRONMENT_ID:
      "2e5f6f12-4281-4879-ae75-8ab0d2a57b44" },
    { ...staging, RAILWAY_ENVIRONMENT_ID: productionId }]) {
    let calls = 0;
    const result = await verifyAmuxV4KeyStoreCanary({ env,
      create: async () => { calls++; } });
    assert.equal(result.kind, "refused");
    assert.equal(calls, 0);
  }
});

test("staging compatibility and production approval bind to exact environments", () => {
  assert.equal(approvedAmuxV4KeyCanaryTarget(staging), "staging");
  assert.equal(approvedAmuxV4KeyCanaryTarget(production), "production");
  assert.equal(verifyStagingKeyCanary, verifyAmuxV4KeyStoreCanary);
});

test("deleted unit refuses both reload and opening the retained backup with its wrapping master", async () => {
  let loads = 0, creates = 0, deletes = 0;
  let createdKey;
  const result = await verifyStagingKeyCanary({ env: staging,
    create: async (_identity, env) => {
      creates++;
      assert.equal(env.AMUX_V4_CONTENT_MASTER_KEY_ID, "amux-v4-canary-master");
      createdKey = scoped(); return createdKey;
    },
    load: async () => {
      loads++;
      if (loads === 1) return scoped();
      throw Object.assign(new Error("missing"), { code: "missing" });
    },
    remove: async () => { deletes++; },
  });
  assert.equal(result.kind, "verified");
  assert.equal(result.mayHaveOrphanKey, false);
  assert.equal(result.oldEnvelopeKeyReloadRefused, true);
  assert.equal(result.oldEnvelopeOpenRefused, true);
  assert.equal(result.oldEnvelopeWrappingMasterOpenRefused, true);
  assert.equal(result.runtimeActivated, false);
  assert.equal(creates, 1); assert.equal(deletes, 1); assert.equal(loads, 2);
  assert.equal(createdKey.masterKey.equals(Buffer.alloc(32)), true);
});

test("approved production canary touches only its newly-created synthetic unit key", async () => {
  let identity;
  let loads = 0;
  const touched = [];
  const result = await verifyAmuxV4KeyStoreCanary({ env: production,
    create: async (value, env) => {
      identity = value;
      touched.push(["create", value]);
      assert.equal(env.AMUX_V4_CONTENT_MASTER_KEY_ID, "amux-v4-canary-master");
      assert.equal(env.AMUX_V4_CONTENT_DIGEST_KEY_ID, "amux-v4-canary-digest");
      return scoped();
    },
    load: async (value) => {
      touched.push(["load", value]);
      if (++loads === 1) return scoped();
      throw Object.assign(new Error("missing"), { code: "missing" });
    },
    remove: async (value) => { touched.push(["remove", value]); },
  });
  assert.equal(result.kind, "verified");
  assert.match(identity.ideaId,
    /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
  assert.deepEqual(identity, { ideaId: identity.ideaId,
    purpose: "idea_raw", subjectId: identity.ideaId });
  assert.equal(touched.length, 4);
  assert.equal(touched.every(([, value]) => value === identity), true);
  assert.equal(result.runtimeActivated, false);
  assert.doesNotMatch(JSON.stringify(result),
    /production|bucket|object|cipher|credential|access|secret/i);
});

test("uncertain create/delete is never retried or reported verified", async () => {
  let creates = 0, deletes = 0;
  let result = await verifyStagingKeyCanary({ env: staging,
    create: async () => { creates++; throw new Error("secret-transport"); } });
  assert.equal(result.kind, "outcome_unknown");
  assert.equal(result.mayHaveOrphanKey, true);
  assert.equal(creates, 1);
  result = await verifyStagingKeyCanary({ env: staging, create: async () => scoped(),
    load: async () => scoped(), remove: async () => { deletes++; throw new Error("secret"); } });
  assert.equal(result.kind, "outcome_unknown"); assert.equal(deletes, 1);
  assert.equal(result.mayHaveOrphanKey, true);
  assert.doesNotMatch(JSON.stringify(result), /secret/);
});

test("load unavailable after delete is not proof of a missing key", async () => {
  let loads = 0;
  const result = await verifyStagingKeyCanary({ env: staging, create: async () => scoped(),
    remove: async () => {}, load: async () => {
      if (++loads === 1) return scoped();
      throw Object.assign(new Error("unavailable"), { code: "unavailable" });
    } });
  assert.equal(result.kind, "outcome_unknown");
  assert.equal(result.mayHaveOrphanKey, false);
});

test("read-back mismatch reports the possible orphan without retrying a write", async () => {
  let deletes = 0, loads = 0;
  const progress = [];
  const result = await verifyStagingKeyCanary({ env: staging, create: async () => scoped(),
    load: async () => { loads++; const key = scoped(); key.masterKey.fill(6); return key; },
    remove: async () => { deletes++; }, onProgress: value => progress.push(value) });
  assert.equal(result.kind, "outcome_unknown");
  assert.equal(result.mayHaveOrphanKey, true);
  assert.equal(progress[0].canaryId, result.canaryId);
  assert.equal(loads, 1); assert.equal(deletes, 0);
});
