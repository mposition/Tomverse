import assert from "node:assert/strict";
import { test } from "node:test";
import { verifyStagingKeyCanary } from "../scripts/amux-v4-key-store-canary.mjs";
const staging = { RAILWAY_ENVIRONMENT_ID: "9347d760-66f6-430b-8f2f-36fd5dbef333",
  AMUX_V4_STAGING_KEY_CANARY: "approved" };
const scoped = () => ({ masterKeyId: "amux2-" + "a".repeat(43), masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 3), digestKeyId: "synthetic-digest", digestKey: Buffer.alloc(32, 4) });

test("production, missing target and missing explicit gate never touch storage", async () => {
  for (const env of [{}, { ...staging, AMUX_V4_STAGING_KEY_CANARY: "disabled" },
    { ...staging, RAILWAY_ENVIRONMENT_ID: "production" }]) {
    let calls = 0;
    const result = await verifyStagingKeyCanary({ env, create: async () => { calls++; } });
    assert.equal(result.kind, "refused");
    assert.equal(calls, 0);
  }
});

test("one synthetic create/delete plus missing reload verifies the storage boundary", async () => {
  let loads = 0, creates = 0, deletes = 0;
  let createdKey;
  const result = await verifyStagingKeyCanary({ env: staging,
    create: async (_identity, env) => {
      creates++;
      assert.equal(env.AMUX_V4_CONTENT_MASTER_KEY_ID, "staging-canary-master");
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
  assert.equal(result.runtimeActivated, false);
  assert.equal(creates, 1); assert.equal(deletes, 1); assert.equal(loads, 2);
  assert.equal(createdKey.masterKey.equals(Buffer.alloc(32)), true);
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
