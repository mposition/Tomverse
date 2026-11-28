import assert from "node:assert/strict";
import { test } from "node:test";
import {
  CONVERSATION_DELETE_BATCH_SIZE,
  chunkConversationIds,
  deleteConversationsInBatches,
} from "../lib/conversationDeletionBatches.ts";

const ids = (count) => Array.from({ length: count }, (_, index) => `c${index}`);

test("ids are cut into batches of fifty, deduplicated, and nothing is lost", () => {
  assert.equal(CONVERSATION_DELETE_BATCH_SIZE, 50);
  const batches = chunkConversationIds([...ids(120), "c0", "c1"]);
  assert.deepEqual(batches.map((batch) => batch.length), [50, 50, 20]);
  assert.deepEqual(batches.flat(), ids(120));
  assert.deepEqual(chunkConversationIds([]), []);
});

test("every batch commits: the outcome adds up exactly and reports no failure", async () => {
  const seen = [];
  const outcome = await deleteConversationsInBatches(ids(120), async (batch) => {
    seen.push(batch.length);
    // One id was already deleted from another tab: count is what actually went.
    return { count: seen.length === 2 ? batch.length - 1 : batch.length };
  });
  assert.deepEqual(seen, [50, 50, 20]);
  assert.deepEqual(outcome, { deleted: 119, processed: 120, remaining: 0, failure: null });
});

test("a failing batch stops the run and the outcome says how far it got", async () => {
  const boom = new Error("deadlock detected");
  let calls = 0;
  const outcome = await deleteConversationsInBatches(ids(120), async (batch) => {
    calls += 1;
    if (calls === 2) throw boom;
    return { count: batch.length };
  });
  // The first batch is final, the failed one rolled back alone, the third was never tried.
  assert.equal(calls, 2);
  assert.deepEqual(outcome, { deleted: 50, processed: 50, remaining: 70, failure: boom });
});

test("a first-batch failure leaves everything remaining and nothing deleted", async () => {
  const boom = new Error("timeout");
  const outcome = await deleteConversationsInBatches(ids(3), async () => {
    throw boom;
  });
  assert.deepEqual(outcome, { deleted: 0, processed: 0, remaining: 3, failure: boom });
});

test("no conversations means no transaction", async () => {
  let calls = 0;
  const outcome = await deleteConversationsInBatches([], async () => {
    calls += 1;
    return { count: 0 };
  });
  assert.equal(calls, 0);
  assert.deepEqual(outcome, { deleted: 0, processed: 0, remaining: 0, failure: null });
});
