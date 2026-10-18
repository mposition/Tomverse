import assert from "node:assert/strict";
import test from "node:test";

import { createAmuxV19MaxClaimIdentityFromQueue } from
  "../lib/amux/ideaLocalMaxClaimIdentityFromQueue.mjs";

const claimId = "52f62b7e-50e1-4f59-8939-995c43d230a8";
const requestId = "e90ccdc1-1a3a-4450-b8e2-e37f31e574a3";
const reservationId = "9a7b23e5-106b-4ce0-9586-747070acc38c";
const ideaId = "51c2e3a3-518d-441c-a276-c6644c733dd4";
const now = Date.parse("2026-10-18T00:00:00.000Z");
const selection = {
  kind: "discovered",
  candidate: { reservationId, ideaId, modelId: "claude-opus-5-5",
    expiresAt: "2026-10-18T01:00:00.000Z",
    nextInvocationOrdinal: 0 },
  price: { kind: "ready", priceVersionId: "price-v19-1",
    modelId: "claude-opus-5-5", reasoningEffort: "high" },
};

test("Max queue selection becomes a fresh content-free claim identity", () => {
  const ids = [claimId, requestId];
  const result = createAmuxV19MaxClaimIdentityFromQueue(selection, {
    now, newId: () => ids.shift(),
  });
  assert.deepEqual(result, { kind: "ready", identity: {
    claimId, requestId, reservationId, ideaId,
    invocationOrdinal: 0, priceVersionId: "price-v19-1",
    modelId: "claude-opus-5-5", reasoningEffort: "high",
  } });
  assert.equal(Object.hasOwn(result.identity, "expiresAt"), false);
});

test("Max claim identity rejects stale or mismatched queue selections", () => {
  const invalid = [
    { kind: "idle" },
    { price: { ...selection.price, modelId: "claude-sonnet-5" } },
    { candidate: { ...selection.candidate,
      expiresAt: "2026-10-17T23:59:59.000Z" } },
    { candidate: { ...selection.candidate, ideaId: "not-a-uuid" } },
    { candidate: { ...selection.candidate,
      nextInvocationOrdinal: 2_147_483_648 } },
  ];
  for (const change of invalid) {
    assert.deepEqual(createAmuxV19MaxClaimIdentityFromQueue({
      ...selection, ...change,
    }, { now, newId: () => claimId }), { kind: "refused" });
  }
  assert.deepEqual(createAmuxV19MaxClaimIdentityFromQueue(selection, {
    now, newId: () => claimId,
  }), { kind: "refused" }, "a duplicate request ID is never a claim");
});
