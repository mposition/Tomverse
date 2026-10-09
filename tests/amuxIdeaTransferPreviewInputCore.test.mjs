import assert from "node:assert/strict";
import test from "node:test";

import {
  inspectIdeaOnlyTransferPreviewRequest,
  transferPreviewReadPermitted,
  transferPreviewWritePermitted,
} from "../lib/amux/ideaTransferPreviewInputCore.ts";

const input = {
  version: 1,
  previewId: "123e4567-e89b-42d3-a456-426614174001",
  ideaId: "123e4567-e89b-42d3-a456-426614174002",
  provider: "openai",
  modelId: "gpt-frontier",
  reasoningEffort: "high",
  approvalId: "123e4567-e89b-42d3-a456-426614174003",
  approvalVersion: 1,
};

test("an exact owner choice is admitted without enabling a live transfer", () => {
  assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify(input)), {
    ok: true, request: {
      previewId: input.previewId, ideaId: input.ideaId,
      provider: input.provider, modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      approvalId: input.approvalId, approvalVersion: input.approvalVersion,
      chunkIndex: 0,
    },
  });
  assert.equal(transferPreviewWritePermitted(undefined), false);
  assert.equal(transferPreviewReadPermitted(undefined), false);
  assert.equal(transferPreviewWritePermitted("enabled"), true);
  assert.equal(transferPreviewReadPermitted("enabled"), true);
});

test("a later output page requires an exact positive chunk identity", () => {
  const later = { ...input, version: 2, chunkIndex: 1 };
  assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify(later)), {
    ok: true, request: { previewId: input.previewId, ideaId: input.ideaId,
      provider: input.provider, modelId: input.modelId,
      reasoningEffort: input.reasoningEffort,
      approvalId: input.approvalId, approvalVersion: 1, chunkIndex: 1 },
  });
  for (const changed of [{ chunkIndex: 0 }, { chunkIndex: -1 },
    { chunkIndex: 1.5 }, { chunkIndex: 2_147_483_647 }, { extra: true }]) {
    assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(
      JSON.stringify({ ...later, ...changed })),
    { ok: false, code: "schema_rejected" });
  }
});

test("model substitutions and malformed request metadata fail closed", () => {
  for (const changed of [
    { modelId: "" }, { provider: "xai" }, { reasoningEffort: "fast" },
    { approvalVersion: 0 }, { approvalId: "not-an-approval" },
    { previewId: input.ideaId, extra: true },
  ]) {
    assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify({ ...input, ...changed })),
      { ok: false, code: "schema_rejected" });
  }
  assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest("{"),
    { ok: false, code: "schema_rejected" });
  assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify({ ...input,
    padding: "x".repeat(1024) })), { ok: false, code: "too_large" });
});
