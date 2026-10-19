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
  candidate: { reservationId, ideaId, provider: "anthropic",
    modelId: "claude-opus-5-5", expiresAt: "2026-10-18T01:00:00.000Z",
    nextInvocationOrdinal: 0 },
  price: { kind: "ready", priceVersionId: "price-v19-1", provider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high" },
};

test("Max queue selection becomes a fresh content-free claim identity", () => {
  const ids = [claimId, requestId];
  const result = createAmuxV19MaxClaimIdentityFromQueue(selection, {
    now, newId: () => ids.shift(),
  });
  assert.deepEqual(result, { kind: "ready", identity: {
    claimId, requestId, reservationId, ideaId,
    invocationOrdinal: 0, priceVersionId: "price-v19-1", provider: "anthropic",
    modelId: "claude-opus-5-5", reasoningEffort: "high",
  } });
  assert.equal(Object.hasOwn(result.identity, "expiresAt"), false);
});

test("a Copilot or Cursor selection becomes a claim on its own channel", () => {
  for (const [provider, modelId] of [["github-copilot", "gpt-5-mini"],
    ["cursor", "auto"]]) {
    const ids = [claimId, requestId];
    const result = createAmuxV19MaxClaimIdentityFromQueue({ ...selection,
      candidate: { ...selection.candidate, provider, modelId },
      price: { ...selection.price, provider, modelId } },
    { now, newId: () => ids.shift() });
    assert.equal(result.kind, "ready", provider);
    assert.equal(result.identity.provider, provider);
    assert.equal(result.identity.modelId, modelId);
  }
  // The closed Codex channel and a channel mismatch never become a claim.
  for (const change of [
    { candidate: { ...selection.candidate, provider: "openai", modelId: "gpt-6-luna" },
      price: { ...selection.price, provider: "openai", modelId: "gpt-6-luna" } },
    { price: { ...selection.price, provider: "cursor" } },
  ]) {
    const ids = [claimId, requestId];
    assert.deepEqual(createAmuxV19MaxClaimIdentityFromQueue({ ...selection,
      ...change }, { now, newId: () => ids.shift() }), { kind: "refused" });
  }
});

test("Max claim identity rejects stale or mismatched queue selections", () => {
  const invalid = [
    { kind: "idle" },
    { price: { ...selection.price, kind: "unavailable" } },
    { price: { ...selection.price, modelId: "claude-sonnet-5" } },
    { candidate: { ...selection.candidate,
      expiresAt: "2026-10-17T23:59:59.000Z" } },
    { candidate: { ...selection.candidate,
      expiresAt: "2026-10-18T00:00:00.000Z" } },
    { candidate: { ...selection.candidate,
      expiresAt: "October 18, 2026 01:00 UTC" } },
    { candidate: { ...selection.candidate,
      expiresAt: "2099-02-30T01:00:00.000Z" } },
    { candidate: { ...selection.candidate,
      expiresAt: "2026-10-18T11:00:00.000+10:00" } },
    { candidate: { ...selection.candidate, ideaId: "not-a-uuid" } },
    { candidate: { ...selection.candidate,
      nextInvocationOrdinal: 2_147_483_648 } },
    { price: { ...selection.price, reasoningEffort: "low" } },
  ];
  for (const change of invalid) {
    const ids = [claimId, requestId];
    assert.deepEqual(createAmuxV19MaxClaimIdentityFromQueue({
      ...selection, ...change,
    }, { now, newId: () => ids.shift() }), { kind: "refused" });
  }
  assert.deepEqual(createAmuxV19MaxClaimIdentityFromQueue(selection, {
    now, newId: () => claimId,
  }), { kind: "refused" }, "a duplicate request ID is never a claim");
  assert.deepEqual(createAmuxV19MaxClaimIdentityFromQueue(selection, {
    now, newId: () => { throw new Error("no entropy"); },
  }), { kind: "refused" });
  for (const reused of [reservationId, ideaId]) {
    for (const ids of [[reused, requestId], [claimId, reused]]) {
      const values = [...ids];
      assert.deepEqual(createAmuxV19MaxClaimIdentityFromQueue(selection, {
        now, newId: () => values.shift(),
      }), { kind: "refused" });
    }
  }
});
