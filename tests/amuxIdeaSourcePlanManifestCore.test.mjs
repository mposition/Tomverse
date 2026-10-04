import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_SOURCE_PLAN_UNIT_MAX_BYTES,
  buildAmuxSourcePlanManifest,
  verifyAmuxSourcePlanManifest,
} from "../lib/amux/ideaSourcePlanManifestCore.ts";

const ideaId = "11111111-1111-4111-8111-111111111111";
const revisionId = "22222222-2222-4222-8222-222222222222";
const nextRevisionId = "33333333-3333-4333-8333-333333333333";
const key = { digestKeyId: "synthetic", digestKey: Buffer.alloc(32, 9) };
const unit = (text, sourceKind = "operator_idea", sourceReceiptDigest = "a".repeat(64)) => ({
  sourceKind, sourceReceiptDigest, bytes: Buffer.from(text, "utf8"),
});
const plan = (overrides = {}) => ({
  ideaId, actorUserId: "synthetic-owner", revisionId, revisionNumber: 1,
  startChunkIndex: 0, predecessorId: null,
  orderedUnits: [unit("first"), unit("second", "approved_excerpt", "b".repeat(64))],
  ...overrides,
});
const ready = (input) => {
  const result = buildAmuxSourcePlanManifest(input, key);
  assert.equal(result.decision, "ready");
  return result.manifest;
};

test("ordered exact bytes produce a stable keyed manifest without copying source text", () => {
  const input = plan();
  const first = ready(input);
  assert.deepEqual(first, ready(plan()));
  assert.equal(first.sourceUnitCount, 2);
  assert.equal(first.manifestDigestKeyId, key.digestKeyId);
  assert.deepEqual(first.unitDigests.map((digest) => digest.length), [64, 64]);
  assert.doesNotMatch(JSON.stringify(first), /first|second|operator_idea|approved_excerpt/);
  assert.equal(verifyAmuxSourcePlanManifest(input, first, key), true);
});

test("unit bytes, order, proof, idea, actor and revision identity are all bound", () => {
  const original = ready(plan());
  const changed = [
    plan({ orderedUnits: [unit("FIRST"), unit("second", "approved_excerpt", "b".repeat(64))] }),
    plan({ orderedUnits: [unit("second", "approved_excerpt", "b".repeat(64)), unit("first")] }),
    plan({ orderedUnits: [unit("first", "operator_idea", "c".repeat(64)),
      unit("second", "approved_excerpt", "b".repeat(64))] }),
    plan({ ideaId: "44444444-4444-4444-8444-444444444444" }),
    plan({ actorUserId: "another-owner" }),
    plan({ revisionId: nextRevisionId, revisionNumber: 2, startChunkIndex: 1,
      predecessorId: revisionId }),
  ];
  for (const candidate of changed) {
    assert.equal(verifyAmuxSourcePlanManifest(candidate, original, key), false);
  }
});

test("tampered or wrong-key stored digest cannot verify", () => {
  const input = plan();
  const original = ready(input);
  assert.equal(verifyAmuxSourcePlanManifest(input,
    { ...original, unitDigests: ["f".repeat(64), original.unitDigests[1]] }, key), false);
  assert.equal(verifyAmuxSourcePlanManifest(input,
    { ...original, manifestDigest: "f".repeat(64) }, key), false);
  assert.equal(verifyAmuxSourcePlanManifest(input, original,
    { digestKeyId: "other", digestKey: Buffer.alloc(32, 9) }), false);
  assert.equal(verifyAmuxSourcePlanManifest(input, original,
    { digestKeyId: "synthetic", digestKey: Buffer.alloc(32, 10) }), false);
});

test("malformed identities, units and key configuration hold without raw echo", () => {
  assert.deepEqual(buildAmuxSourcePlanManifest(plan({ ideaId: "bad" }), key),
    { decision: "hold", reason: "invalid_identity" });
  assert.deepEqual(buildAmuxSourcePlanManifest(plan({ revisionNumber: 2,
    startChunkIndex: 0, predecessorId: revisionId }), key),
    { decision: "hold", reason: "invalid_identity" });
  assert.deepEqual(buildAmuxSourcePlanManifest(plan(),
    { digestKeyId: "synthetic", digestKey: Buffer.alloc(3) }),
  { decision: "hold", reason: "invalid_key" });
  for (const orderedUnits of [[], [unit("")], [unit("x".repeat(AMUX_SOURCE_PLAN_UNIT_MAX_BYTES + 1))],
    [unit("x", "unknown")], [unit("x", "operator_idea", "not-a-digest")],
    [unit("x"), , unit("z")]]) {
    assert.deepEqual(buildAmuxSourcePlanManifest(plan({ orderedUnits }), key),
      { decision: "hold", reason: "invalid_units" });
  }
});

test("accessor-bearing unit arrays and records are refused", () => {
  const accessorArray = [unit("one")];
  Object.defineProperty(accessorArray, 0, { get: () => unit("secret") });
  assert.deepEqual(buildAmuxSourcePlanManifest(plan({ orderedUnits: accessorArray }), key),
    { decision: "hold", reason: "invalid_units" });
  const accessorUnit = {};
  Object.defineProperties(accessorUnit, {
    sourceKind: { value: "operator_idea", enumerable: true },
    sourceReceiptDigest: { value: "a".repeat(64), enumerable: true },
    bytes: { get: () => Buffer.from("secret"), enumerable: true },
  });
  assert.deepEqual(buildAmuxSourcePlanManifest(plan({ orderedUnits: [accessorUnit] }), key),
    { decision: "hold", reason: "invalid_units" });
});

test("Buffer valueOf and length overrides cannot change the hashed bytes or cap", () => {
  const visible = unit("owner-visible");
  visible.bytes.valueOf = () => Buffer.from("unapproved bytes".repeat(1_000));
  assert.deepEqual(buildAmuxSourcePlanManifest(plan({ orderedUnits: [visible] }), key),
    { decision: "hold", reason: "invalid_units" });

  const hiddenLength = unit("x".repeat(AMUX_SOURCE_PLAN_UNIT_MAX_BYTES + 1));
  Object.defineProperty(hiddenLength.bytes, "length", { value: 1 });
  assert.deepEqual(buildAmuxSourcePlanManifest(plan({ orderedUnits: [hiddenLength] }), key),
    { decision: "hold", reason: "invalid_units" });
});

test("digest key accessors and Buffer overrides fail closed while full key records work", () => {
  let getterCalls = 0;
  const accessorKey = {
    digestKeyId: "synthetic",
    get digestKey() { getterCalls += 1; return Buffer.alloc(32, 9); },
  };
  assert.deepEqual(buildAmuxSourcePlanManifest(plan(), accessorKey),
    { decision: "hold", reason: "invalid_key" });
  assert.equal(getterCalls, 0);
  assert.equal(verifyAmuxSourcePlanManifest(plan(), ready(plan()), accessorKey), false);
  assert.equal(getterCalls, 0);

  const badBytes = Buffer.alloc(32, 9);
  badBytes.valueOf = () => Buffer.alloc(3, 9);
  assert.deepEqual(buildAmuxSourcePlanManifest(plan(),
    { digestKeyId: "synthetic", digestKey: badBytes }),
    { decision: "hold", reason: "invalid_key" });
  assert.equal(buildAmuxSourcePlanManifest(plan(),
    { ...key, masterKeyId: "unused-extra-field" }).decision, "ready");
});

test("shared backing buffers are not accepted as owner-confirmed exact bytes", () => {
  if (typeof SharedArrayBuffer === "undefined") return;
  const shared = Buffer.from(new Uint8Array(new SharedArrayBuffer(16)));
  // Buffer.from(Uint8Array) may copy, so create an actual shared-backed Buffer.
  const sharedBacked = Buffer.from(new SharedArrayBuffer(16));
  assert.notEqual(shared.buffer, sharedBacked.buffer);
  assert.deepEqual(buildAmuxSourcePlanManifest(plan({ orderedUnits: [{
    sourceKind: "operator_idea", sourceReceiptDigest: "a".repeat(64), bytes: sharedBacked,
  }] }), key), { decision: "hold", reason: "invalid_units" });
});
