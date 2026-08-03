import assert from "node:assert/strict";
import { test } from "node:test";

import {
  IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS,
  IMAGE_ASSET_CLEANUP_REASONS,
  IMAGE_ASSET_KEY_PREFIX,
  IMAGE_GENERATION_FAILURE_PHASES,
  IMAGE_GENERATION_STATUSES,
  STALE_IMAGE_GENERATION_AFTER_MS,
  canTransitionImageGenerationStatus,
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
  assert.equal(STALE_IMAGE_GENERATION_AFTER_MS, 45 * 60 * 1_000);
  assert.equal(IMAGE_ASSET_CLEANUP_MAX_ATTEMPTS, 10);
  assert.deepEqual(
    [...IMAGE_GENERATION_STATUSES],
    ["pending", "processing", "settling", "succeeded", "failed"]
  );
  assert.ok(IMAGE_GENERATION_FAILURE_PHASES.includes("stale_job_reconciled"));
  assert.ok(IMAGE_ASSET_CLEANUP_REASONS.includes("conversation_deleted"));
});
