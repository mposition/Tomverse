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
    },
  });
  assert.equal(transferPreviewWritePermitted("enabled"), false);
  assert.equal(transferPreviewReadPermitted("enabled"), false);
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

test("expired preview replacement names one different prior receipt", () => {
  const replacesPreviewId = "123e4567-e89b-42d3-a456-426614174004";
  assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify({
    ...input, replacesPreviewId,
  })), { ok: true, request: {
    previewId: input.previewId, ideaId: input.ideaId, replacesPreviewId,
    provider: input.provider, modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    approvalId: input.approvalId, approvalVersion: input.approvalVersion,
  } });
  for (const replacement of [input.previewId, "invalid", null]) {
    assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify({
      ...input, replacesPreviewId: replacement,
    })), { ok: false, code: "schema_rejected" });
  }
});

test("a second output page is explicit and cannot also replace a first preview", () => {
  assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify({
    ...input, chunkIndex: 1,
  })), { ok: true, request: {
    previewId: input.previewId, ideaId: input.ideaId, chunkIndex: 1,
    provider: input.provider, modelId: input.modelId,
    reasoningEffort: input.reasoningEffort,
    approvalId: input.approvalId, approvalVersion: input.approvalVersion,
  } });
  for (const changed of [{ chunkIndex: 0 }, { chunkIndex: 2 },
    { chunkIndex: 1, replacesPreviewId: "123e4567-e89b-42d3-a456-426614174004" }]) {
    assert.deepEqual(inspectIdeaOnlyTransferPreviewRequest(JSON.stringify({
      ...input, ...changed,
    })), { ok: false, code: "schema_rejected" });
  }
});
