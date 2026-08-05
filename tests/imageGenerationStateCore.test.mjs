import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS,
  IMAGE_ORIGINAL_MAX_READ_BYTES,
  IMAGE_THUMBNAIL_MAX_RETRIES,
  IMAGE_ASSET_CLEANUP_REASONS,
  IMAGE_ASSET_KEY_PREFIX,
  IMAGE_GENERATION_FAILURE_PHASES,
  IMAGE_GENERATION_STATUSES,
  STALE_IMAGE_GENERATION_AFTER_MS,
  STALE_IMAGE_SETTLING_AFTER_MS,
  canTransitionImageGenerationStatus,
  currentImageAttempt,
  deriveImageGroupStatus,
  deriveImageGroupStatusFromTargets,
  imageAssetR2Key,
  imageConversationR2Prefix,
} from "../lib/imageGenerationStateCore.ts";

test("status machine: forward path is the only legal path", () => {
  assert.ok(canTransitionImageGenerationStatus("pending", "processing"));
  assert.ok(canTransitionImageGenerationStatus("processing", "settling"));
  assert.ok(canTransitionImageGenerationStatus("settling", "succeeded"));
  assert.ok(canTransitionImageGenerationStatus("settling", "failed"));
  // The reconciliation sweep claims a stale pending row directly.
  assert.ok(canTransitionImageGenerationStatus("pending", "settling"));
});

test("status machine: terminal states accept nothing, no backward moves", () => {
  for (const to of IMAGE_GENERATION_STATUSES) {
    assert.equal(canTransitionImageGenerationStatus("succeeded", to), false);
    assert.equal(canTransitionImageGenerationStatus("failed", to), false);
  }
  assert.equal(canTransitionImageGenerationStatus("settling", "processing"), false);
  assert.equal(canTransitionImageGenerationStatus("processing", "pending"), false);
  // Skipping the settling claim is not allowed: it is the exactly-once gate.
  assert.equal(canTransitionImageGenerationStatus("processing", "succeeded"), false);
  assert.equal(canTransitionImageGenerationStatus("pending", "failed"), false);
});

test("R2 keys use the opaque user id namespace and enumerate by conversation prefix", () => {
  const input = {
    userId: "user_cuid",
    conversationId: "conv_cuid",
    generationId: "gen_cuid",
  };
  const original = imageAssetR2Key({ ...input, role: "original" });
  const thumbnail = imageAssetR2Key({ ...input, role: "thumbnail" });
  assert.equal(original, "images/user_cuid/conv_cuid/gen_cuid/original.png");
  assert.equal(thumbnail, "images/user_cuid/conv_cuid/gen_cuid/thumb.webp");
  const prefix = imageConversationR2Prefix("user_cuid", "conv_cuid");
  assert.ok(original.startsWith(prefix));
  assert.ok(thumbnail.startsWith(prefix));
  assert.ok(prefix.startsWith(IMAGE_ASSET_KEY_PREFIX));
  // The namespace must never embed an email or an email hash.
  assert.ok(!original.includes("@"));
});

test("policy constants hold their approved values", () => {
  // 12 minutes since the beta observation of redeploy-killed executors:
  // worst legitimate run is under 8 minutes (bounded provider retries plus
  // storage), and this window sets the automatic-refund latency.
  assert.equal(STALE_IMAGE_GENERATION_AFTER_MS, 12 * 60 * 1_000);
  assert.equal(IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS, 10);
  assert.deepEqual(
    [...IMAGE_GENERATION_STATUSES],
    ["pending", "processing", "settling", "succeeded", "failed"]
  );
  assert.ok(IMAGE_GENERATION_FAILURE_PHASES.includes("stale_job_reconciled"));
  assert.ok(IMAGE_ASSET_CLEANUP_REASONS.includes("conversation_deleted"));
});

test("group status derives from current attempts only (policy section 11)", () => {
  assert.equal(deriveImageGroupStatus(["succeeded", "succeeded"]), "succeeded");
  assert.equal(deriveImageGroupStatus(["failed", "failed"]), "failed");
  assert.equal(
    deriveImageGroupStatus(["succeeded", "failed"]),
    "partial_success"
  );
  assert.equal(deriveImageGroupStatus(["succeeded", "pending"]), "in_progress");
  assert.equal(
    deriveImageGroupStatus(["succeeded", "settling"]),
    "in_progress"
  );
  // A retried failure means the target's CURRENT attempt is live again: the
  // group goes back to in-progress while succeeded results stay terminal.
  assert.equal(
    deriveImageGroupStatus(["succeeded", "processing"]),
    "in_progress"
  );
  // No targets is an invariant violation; the derivation stays conservative.
  assert.equal(deriveImageGroupStatus([]), "in_progress");
});

const attempt = (id, attemptNumber, status) => ({ id, attemptNumber, status });

test("the current attempt of a target is the one its pointer names", () => {
  const target = {
    currentGenerationId: "gen-2",
    generations: [attempt("gen-1", 1, "failed"), attempt("gen-2", 2, "processing")],
  };
  assert.equal(currentImageAttempt(target).id, "gen-2");
});

test("without a pointer the highest attempt number wins, whatever the array order", () => {
  // The fallback exists for the window between a row being written and its
  // pointer being read, and for a v1 row backfilled without one. Trusting
  // array position instead would make the answer depend on the query's
  // orderBy -- a rule nobody states and every caller could get differently.
  assert.equal(
    currentImageAttempt({
      currentGenerationId: null,
      generations: [attempt("gen-2", 2, "pending"), attempt("gen-1", 1, "failed")],
    }).id,
    "gen-2"
  );
  // A pointer naming a row that is not in this target's attempts is not a
  // licence to report nothing: fall back rather than drop the target out of
  // the derivation, which would silently shrink the group.
  assert.equal(
    currentImageAttempt({
      currentGenerationId: "gen-from-another-target",
      generations: [attempt("gen-1", 1, "succeeded")],
    }).id,
    "gen-1"
  );
  assert.equal(
    currentImageAttempt({ currentGenerationId: "gen-1", generations: [] }),
    null
  );
});

test("a retried failure does not drag the group backwards", () => {
  // The failure this pins: handing every attempt to the derivation would let
  // the superseded `failed` row report partial_success while the retry is
  // still running -- the user would see a finished comparison that is not.
  const targets = [
    {
      currentGenerationId: "a-1",
      generations: [attempt("a-1", 1, "succeeded")],
    },
    {
      currentGenerationId: "b-2",
      generations: [attempt("b-1", 1, "failed"), attempt("b-2", 2, "processing")],
    },
  ];
  assert.equal(deriveImageGroupStatusFromTargets(targets), "in_progress");

  targets[1].generations[1].status = "succeeded";
  assert.equal(deriveImageGroupStatusFromTargets(targets), "succeeded");

  targets[1].generations[1].status = "failed";
  assert.equal(deriveImageGroupStatusFromTargets(targets), "partial_success");
});

test("settling has its own, longer stale window", () => {
  // Reclaiming a pending/processing row costs nothing -- it has written no
  // ledger. Reclaiming a settling row races a credit write, so it waits out
  // any transaction that could still be open. Collapsing the two windows into
  // one constant is how that distinction gets lost.
  assert.ok(STALE_IMAGE_SETTLING_AFTER_MS > STALE_IMAGE_GENERATION_AFTER_MS);
  assert.equal(STALE_IMAGE_SETTLING_AFTER_MS, 15 * 60 * 1_000);
});

test("a failed settlement is its own failure phase, not a provider failure", () => {
  // The two send an operator to different places: provider_failed means the
  // image never arrived, settlement_failed means it arrived and the ledger
  // write for it was lost. Both refund; only one is the provider's problem.
  assert.ok(IMAGE_GENERATION_FAILURE_PHASES.includes("settlement_failed"));
  assert.ok(IMAGE_GENERATION_FAILURE_PHASES.includes("provider_failed"));
  assert.notEqual("settlement_failed", "provider_failed");
});

test("settling is still terminal-adjacent, not a state anything transitions out of", () => {
  // The trap this whole window exists for: nothing in the transition table
  // moves a row out of settling except the settlement itself. That is by
  // design -- it is the exactly-once claim -- which is exactly why a rollback
  // needed an explicit reclaim rather than another edge here.
  assert.deepEqual(
    [...IMAGE_GENERATION_STATUSES].filter((status) =>
      canTransitionImageGenerationStatus(status, "settling")
    ),
    ["pending", "processing"]
  );
  assert.deepEqual(
    [...IMAGE_GENERATION_STATUSES].filter((status) =>
      canTransitionImageGenerationStatus("settling", status)
    ),
    ["succeeded", "failed"]
  );
});

test("the thumbnail retry is bounded, and lower than a cleanup's", () => {
  // A cleanup retries a delete that will eventually succeed. A thumbnail
  // failure is usually the derivation refusing the bytes -- deterministic --
  // and each attempt re-downloads the original to learn the same answer, so
  // it gives up sooner and surfaces instead.
  assert.ok(IMAGE_THUMBNAIL_MAX_RETRIES > 1);
  assert.ok(IMAGE_THUMBNAIL_MAX_RETRIES < IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS);
  assert.ok(IMAGE_ORIGINAL_MAX_READ_BYTES >= 8 * 1024 * 1024);
});

test("the original and the thumbnail never share an R2 key", () => {
  // The failed-thumbnail row records the key the thumbnail will occupy, so
  // the repair can fill that row in rather than adding a second one. That is
  // only safe while the two roles are distinct keys under the same prefix --
  // otherwise the failure row would collide with the original it derives
  // from, which r2Key's unique constraint makes a hard error.
  const input = {
    userId: "user-1",
    conversationId: "conv-1",
    generationId: "gen-1",
  };
  const original = imageAssetR2Key({ ...input, role: "original" });
  const thumbnail = imageAssetR2Key({ ...input, role: "thumbnail" });
  assert.notEqual(original, thumbnail);
  assert.ok(original.startsWith(imageConversationR2Prefix("user-1", "conv-1")));
  assert.ok(thumbnail.startsWith(imageConversationR2Prefix("user-1", "conv-1")));
});
