import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import {
  TEMPORARY_CHAT_SWEEP_GRACE_MS,
  TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS,
  TEMPORARY_CHAT_TTL_MS,
} from "../../lib/temporaryChatAccess.ts";
import { STALE_IMAGE_GENERATION_AFTER_MS } from "../../lib/imageGenerationStateCore.ts";

const mod = (path) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;

const START = new Date("2026-11-27T00:00:00.000Z");
const expiresAt = new Date(START.getTime() + TEMPORARY_CHAT_TTL_MS);
let candidates;
let liveAttempt;
let liveResearch;
let liveImage;
let imageWhere;
let researchWhere;
let deleted;

mock.module(mod("lib/chatResponseAttemptPersistence.ts"), { namedExports: { lockChatRecoveryConversation: async () => {} } });
mock.module(mod("lib/conversationDeletion.ts"), { namedExports: {
  deleteOwnedConversations: async (_tx, input) => {
    deleted.push(input.conversationIds[0]);
    return { count: 1, conversationIds: input.conversationIds };
  },
} });
const tx = {
  chatResponseAttempt: { findFirst: async () => liveAttempt },
  researchPreviewRun: { findFirst: async ({ where }) => { researchWhere = where; return liveResearch; } },
  imageGeneration: { findFirst: async ({ where }) => { imageWhere = where; return liveImage; } },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  conversation: { findMany: async ({ where }) => (where.id?.notIn ? [] : candidates) },
  $transaction: async (run) => run(tx),
} } });

const { sweepExpiredTemporaryConversations } = await import("../../lib/temporaryConversationSweep.ts");
const afterGrace = new Date(expiresAt.getTime() + TEMPORARY_CHAT_SWEEP_GRACE_MS + 60_000);
const reset = () => {
  candidates = [{ id: "temp-1", userId: "owner", temporaryExpiresAt: expiresAt }];
  liveAttempt = null;
  liveResearch = null;
  liveImage = null;
  imageWhere = null;
  researchWhere = null;
  deleted = [];
};

test("an executing Research run defers the delete and nothing is removed", async () => {
  reset();
  liveResearch = { id: "run-1" };
  const result = await sweepExpiredTemporaryConversations(afterGrace);
  assert.deepEqual(result, { examined: 1, deleted: 0, deferred: 1, failed: 0 });
  assert.deepEqual(deleted, []);
  assert.equal(researchWhere.conversationId, "temp-1");
  // Waiting for the person, and finished, are not "executing".
  for (const status of ["draft", "awaiting_input", "paused", "completed", "failed", "cancelled", "attention"]) {
    assert.ok(!researchWhere.status.in.includes(status), status);
  }
});

test("an image generation in flight defers the delete, but only while it is within its worst-case run time", async () => {
  reset();
  liveImage = { id: "gen-1" };
  assert.deepEqual(await sweepExpiredTemporaryConversations(afterGrace), { examined: 1, deleted: 0, deferred: 1, failed: 0 });
  assert.deepEqual(imageWhere.status.in, ["pending", "processing", "settling"]);
  // A row older than the stale window has lost its worker and is the reconciler's: it does not hold the delete.
  assert.equal(imageWhere.updatedAt.gt.getTime(), afterGrace.getTime() - STALE_IMAGE_GENERATION_AFTER_MS);
});

test("once the work has ended the next sweep deletes the conversation", async () => {
  reset();
  assert.deepEqual(await sweepExpiredTemporaryConversations(afterGrace), { examined: 1, deleted: 1, deferred: 0, failed: 0 });
  assert.deepEqual(deleted, ["temp-1"]);
});

test("the wait is bounded: past the cap a run that still looks live is deleted with its conversation", async () => {
  reset();
  liveResearch = { id: "stuck-run" };
  liveImage = { id: "stuck-image" };
  const tooLate = new Date(expiresAt.getTime() + TEMPORARY_CHAT_SWEEP_MAX_DEFER_MS + 1);
  assert.deepEqual(await sweepExpiredTemporaryConversations(tooLate), { examined: 1, deleted: 1, deferred: 0, failed: 0 });
  assert.deepEqual(deleted, ["temp-1"]);
});

test("a live chat attempt still defers first, as before", async () => {
  reset();
  liveAttempt = { assistantMessageId: "a-1" };
  assert.deepEqual(await sweepExpiredTemporaryConversations(afterGrace), { examined: 1, deleted: 0, deferred: 1, failed: 0 });
  assert.equal(researchWhere, null);
});
