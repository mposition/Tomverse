import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_PROCESSING_STALE_AFTER_MS,
  REFUND_REQUEST_METADATA_KEY,
  decideReconciliation,
  findRefundForRequest,
  refundIdempotencyKey,
} from "../lib/refundSagaCore.ts";

/**
 * A refund crosses Stripe and PostgreSQL, which cannot share a transaction.
 * These are the decisions that determine what a half-finished attempt means,
 * kept free of both systems so they can be checked directly.
 */

const NOW = new Date("2026-08-01T12:00:00.000Z");
const ago = (ms) => new Date(NOW.getTime() - ms);

test("an idempotency key is scoped to the request, so a retry cannot refund twice", () => {
  assert.equal(
    refundIdempotencyKey("req_1"),
    refundIdempotencyKey("req_1"),
    "the same request must always present the same key"
  );
  assert.notEqual(refundIdempotencyKey("req_1"), refundIdempotencyKey("req_2"));
  assert.ok(refundIdempotencyKey("req_1").includes("req_1"));
});

test("a request still inside the window is left alone", () => {
  // The claim is held by a request that is simply still running. Reconciling it
  // would race the attempt that owns it.
  const decision = decideReconciliation({
    status: "processing",
    processingStartedAt: ago(DEFAULT_PROCESSING_STALE_AFTER_MS - 1_000),
    providerRefund: null,
    now: NOW,
  });
  assert.deepEqual(decision, { action: "wait", reason: "still_recent" });
});

test("a stale claim with a refund at the provider is completed, not released", () => {
  // The money moved and the crash lost the record. Releasing this would offer
  // the request for approval again and refund the customer twice.
  const refund = {
    id: "re_1",
    status: "succeeded",
    amountCents: 2000,
    currency: "USD",
    chargeId: "ch_1",
  };
  const decision = decideReconciliation({
    status: "processing",
    processingStartedAt: ago(DEFAULT_PROCESSING_STALE_AFTER_MS + 1_000),
    providerRefund: refund,
    now: NOW,
  });
  assert.deepEqual(decision, { action: "complete", refund });
});

test("a stale claim with no refund at the provider is released", () => {
  const decision = decideReconciliation({
    status: "processing",
    processingStartedAt: ago(DEFAULT_PROCESSING_STALE_AFTER_MS + 1_000),
    providerRefund: null,
    now: NOW,
  });
  assert.deepEqual(decision, {
    action: "release",
    reason: "no_refund_at_provider",
  });
});

test("only processing rows are reconciled", () => {
  for (const status of ["pending", "approved", "rejected"]) {
    assert.deepEqual(
      decideReconciliation({
        status,
        processingStartedAt: ago(DEFAULT_PROCESSING_STALE_AFTER_MS + 1_000),
        providerRefund: { id: "re_1", status: "succeeded", amountCents: 1, currency: "USD", chargeId: "ch_1" },
        now: NOW,
      }),
      { action: "skip", reason: "not_processing" }
    );
  }
});

test("a processing row with no timestamp is not judged abandoned", () => {
  // It cannot be aged, so it cannot be shown to be stale. Left for a human.
  assert.deepEqual(
    decideReconciliation({
      status: "processing",
      processingStartedAt: null,
      providerRefund: null,
      now: NOW,
    }),
    { action: "skip", reason: "no_started_at" }
  );
});

test("a refund is matched by request metadata, never by amount", () => {
  const refunds = [
    // Same charge, same amount, different request. Matching on anything but
    // the request id would record this one against the wrong refund.
    { id: "re_other", amount: 2000, currency: "usd", charge: "ch_1", metadata: { [REFUND_REQUEST_METADATA_KEY]: "req_other" } },
    { id: "re_mine", amount: 2000, currency: "usd", charge: "ch_1", status: "succeeded", metadata: { [REFUND_REQUEST_METADATA_KEY]: "req_mine" } },
  ];
  assert.deepEqual(findRefundForRequest("req_mine", refunds), {
    id: "re_mine",
    status: "succeeded",
    amountCents: 2000,
    currency: "USD",
    chargeId: "ch_1",
  });
});

test("a refund from before this metadata existed does not match", () => {
  // The old code wrote `tomverseRefundRequest: "true"`, which identifies
  // Tomverse but not the request. Claiming one of those would attach an
  // unrelated refund to this request.
  const refunds = [
    { id: "re_legacy", amount: 2000, charge: "ch_1", metadata: { tomverseRefundRequest: "true" } },
  ];
  assert.equal(findRefundForRequest("req_mine", refunds), null);
});

test("an expanded charge object is read as its id", () => {
  const refunds = [
    {
      id: "re_1",
      amount: 500,
      currency: "usd",
      charge: { id: "ch_expanded" },
      metadata: { [REFUND_REQUEST_METADATA_KEY]: "req_1" },
    },
  ];
  assert.equal(findRefundForRequest("req_1", refunds)?.chargeId, "ch_expanded");
});

// --- the lookup that outlives the idempotency key -------------------------
//
// The request-scoped key makes a retry safe for 24 hours. Past that window
// Stripe treats the retry as a new request, so the only thing standing between
// a long outage and a second refund is finding the first one by metadata --
// which means the search has to be complete.

test("the provider lookup walks every page, not just the first", async () => {
  const { findRefundForRequestAtProvider } = await import(
    "../lib/refundProviderLookup.ts"
  );
  // 100 unrelated refunds, then ours on the second page. A single-page lookup
  // answers "no refund exists" here -- the answer that refunds twice.
  const page1 = Array.from({ length: 100 }, (_, i) => ({
    id: `re_other_${i}`,
    metadata: { tomverseRefundRequestId: `req_other_${i}` },
  }));
  const page2 = [
    { id: "re_mine", status: "succeeded", amount: 2000, currency: "usd", charge: "ch_1", metadata: { tomverseRefundRequestId: "req_mine" } },
  ];
  let calls = 0;
  const stripe = {
    refunds: {
      list: async ({ starting_after: after }) => {
        calls += 1;
        return after
          ? { data: page2, has_more: false }
          : { data: page1, has_more: true };
      },
    },
  };
  const found = await findRefundForRequestAtProvider(stripe, "req_mine", "ch_1");
  assert.equal(found?.id, "re_mine");
  assert.equal(calls, 2, "the second page must actually be requested");
});

test("the provider lookup stops as soon as it matches", async () => {
  const { findRefundForRequestAtProvider } = await import(
    "../lib/refundProviderLookup.ts"
  );
  let calls = 0;
  const stripe = {
    refunds: {
      list: async () => {
        calls += 1;
        return {
          data: [{ id: "re_mine", charge: "ch_1", metadata: { tomverseRefundRequestId: "req_mine" } }],
          has_more: true,
        };
      },
    },
  };
  assert.equal((await findRefundForRequestAtProvider(stripe, "req_mine", "ch_1"))?.id, "re_mine");
  assert.equal(calls, 1);
});

test("an unbounded charge refuses rather than reporting no refund", async () => {
  const { findRefundForRequestAtProvider } = await import(
    "../lib/refundProviderLookup.ts"
  );
  // Running out of pages is not evidence that no refund exists. Returning null
  // here would be a guess in the direction that costs money twice.
  const stripe = {
    refunds: {
      list: async () => ({
        data: [{ id: "re_x", metadata: { tomverseRefundRequestId: "someone_else" } }],
        has_more: true,
      }),
    },
  };
  await assert.rejects(
    () => findRefundForRequestAtProvider(stripe, "req_mine", "ch_1"),
    /Could not determine whether a refund already exists/
  );
});

test("no match on any page returns null", async () => {
  const { findRefundForRequestAtProvider } = await import(
    "../lib/refundProviderLookup.ts"
  );
  const stripe = {
    refunds: {
      list: async () => ({
        data: [{ id: "re_x", metadata: { tomverseRefundRequestId: "someone_else" } }],
        has_more: false,
      }),
    },
  };
  assert.equal(await findRefundForRequestAtProvider(stripe, "req_mine", "ch_1"), null);
});
