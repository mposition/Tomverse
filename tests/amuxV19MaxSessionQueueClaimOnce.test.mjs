import assert from "node:assert/strict";
import test from "node:test";

import { claimAmuxV19MaxQueueSelectionOnce } from
  "../lib/amux/ideaLocalMaxSessionQueueClaimOnce.mjs";

const reservationId = "9a7b23e5-106b-4ce0-9586-747070acc38c";
const ideaId = "51c2e3a3-518d-441c-a276-c6644c733dd4";
const selection = { kind: "discovered",
  candidate: { reservationId, ideaId, modelId: "claude-opus-5-5",
    expiresAt: "2099-10-18T01:00:00.000Z", nextInvocationOrdinal: 0 },
  price: { kind: "ready", priceVersionId: "price-v19-1",
    modelId: "claude-opus-5-5", reasoningEffort: "high" } };

test("fresh queue selection becomes exactly one guarded claim", async () => {
  let calls = 0;
  const input = { origin: "https://synthetic-amux.example.test/",
    stateDirectory: "/unused" };
  const result = await claimAmuxV19MaxQueueSelectionOnce(selection, input,
    async (arg) => {
      calls++;
      assert.equal(arg.origin, input.origin);
      assert.equal(arg.stateDirectory, input.stateDirectory);
      assert.equal(arg.identity.reservationId, reservationId);
      assert.equal(arg.identity.ideaId, ideaId);
      assert.equal(arg.identity.modelId, selection.price.modelId);
      assert.equal(arg.identity.priceVersionId,
        selection.price.priceVersionId);
      assert.notEqual(arg.identity.claimId, arg.identity.requestId);
      return { kind: "claimed", claimId: arg.identity.claimId,
        requestId: arg.identity.requestId,
        reservationId: arg.identity.reservationId,
        reservedMicroUsd: "1000000", recovered: false,
        retryWrite: false };
    });
  assert.equal(calls, 1);
  assert.equal(result.kind, "claimed");
  assert.equal(result.identity.reservationId, reservationId);
  assert.equal(result.reservedMicroUsd, "1000000");
  assert.equal(result.retryWrite, false);
});

test("idle, stale and mismatched selections never write a claim", async () => {
  let calls = 0;
  const claimOnce = async () => { calls++; throw Error("unexpected claim"); };
  for (const invalid of [{ kind: "idle" },
    { ...selection, candidate: { ...selection.candidate,
      expiresAt: "2020-01-01T00:00:00.000Z" } },
    { ...selection, price: { ...selection.price,
      modelId: "claude-sonnet-5" } }]) {
    const result = await claimAmuxV19MaxQueueSelectionOnce(invalid, {},
      claimOnce);
    assert.notEqual(result.kind, "claimed");
  }
  assert.equal(calls, 0);
});

test("uncertain or mismatched claim is never reported as safe to retry",
  async () => {
    for (const claimOnce of [
      async () => { throw Error("claim response lost"); },
      async () => ({ kind: "outcome_unknown", retryWrite: false }),
      async ({ identity }) => ({ kind: "claimed",
        claimId: identity.claimId, requestId: identity.requestId,
        reservationId: ideaId, reservedMicroUsd: "1000000",
        recovered: false, retryWrite: false }),
    ]) {
      const result = await claimAmuxV19MaxQueueSelectionOnce(selection, {},
        claimOnce);
      assert.deepEqual(result, { kind: "outcome_unknown",
        retryWrite: false });
    }
  });
