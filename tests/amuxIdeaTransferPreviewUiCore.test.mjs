import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { AMUX_V4_ANALYSIS_PROMPT_VERSION } from
  "../lib/amux/ideaAnalysisPromptCore.ts";

import {
  readPreparedIdeaTransferPreview, readPreviewReceipt, reservePreviewReceipt,
} from "../lib/amux/ideaTransferPreviewUiCore.ts";

const model = { approvalId: "123e4567-e89b-42d3-a456-426614174003",
  approvalVersion: 1, provider: "openai", modelId: "gpt-frontier",
  allowedEfforts: ["high"] };
const ideaId = "123e4567-e89b-42d3-a456-426614174002";
const previewId = "123e4567-e89b-42d3-a456-426614174001";
const reply = { state: "prepared", previewId, expiresAt: "2099-10-02T12:00:00.000Z",
  payloadDigest: "a".repeat(64), payloadDigestKeyId: "synthetic-key",
  transferAuthorized: false,
  payload: { version: 1, previewId, ideaId, templateVersion: AMUX_V4_ANALYSIS_PROMPT_VERSION,
    prompt: "synthetic exact prompt", selection: {
      provider: model.provider, modelId: model.modelId, reasoningEffort: "high",
      approvalId: model.approvalId, approvalVersion: model.approvalVersion,
    } } };

test("only the exact selected model and prompt preview is shown", () => {
  assert.deepEqual(readPreparedIdeaTransferPreview(201, reply, previewId, ideaId, model, "high"), {
    previewId, expiresAt: reply.expiresAt, prompt: "synthetic exact prompt",
    provider: "openai", modelId: "gpt-frontier", reasoningEffort: "high",
    payloadDigest: "a".repeat(64), payloadDigestKeyId: "synthetic-key",
  });
  for (const changed of [
    { transferAuthorized: true }, { previewId: ideaId },
    { payloadDigest: "not-a-digest" },
    { payload: { ...reply.payload, ideaId: previewId } },
    { expiresAt: "2020-01-01T00:00:00.000Z" },
    { payload: { ...reply.payload, prompt: "" } },
    { payload: { ...reply.payload, selection: { ...reply.payload.selection, approvalVersion: 2 } } },
  ]) assert.equal(readPreparedIdeaTransferPreview(201, { ...reply, ...changed }, previewId, ideaId, model, "high"), null);
  assert.equal(readPreparedIdeaTransferPreview(503, reply, previewId, ideaId, model, "high"), null);
});

test("current server template is accepted on creation and exact-ID read-back", () => {
  for (const status of [201, 200]) {
    const prepared = readPreparedIdeaTransferPreview(status, reply, previewId,
      ideaId, model, "high");
    assert.ok(prepared, `current server template must be visible for HTTP ${status}`);
    assert.equal(prepared.prompt, reply.payload.prompt);
    assert.equal(prepared.payloadDigest, reply.payloadDigest);
  }
});

test("legacy and unknown prompt versions remain fail-closed", () => {
  for (const templateVersion of ["amux-v4-analysis-prompt-v1",
    "amux-v4-analysis-prompt-v2", "amux-v4-analysis-prompt-v3",
    "amux-v4-analysis-prompt-v999", "", null]) {
    const changed = { ...reply, payload: { ...reply.payload, templateVersion } };
    assert.equal(readPreparedIdeaTransferPreview(200, changed, previewId, ideaId,
      model, "high"), null);
  }
});

test("a pending receipt survives a lost reply and cannot be overwritten", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); } };
  assert.deepEqual(readPreviewReceipt(storage, "operator", ideaId), { kind: "absent" });
  assert.equal(reservePreviewReceipt(storage, "operator", ideaId, previewId, model, "high"), true);
  assert.deepEqual(readPreviewReceipt(storage, "operator", ideaId), {
    kind: "present", previewId, model, effort: "high",
  });
  assert.equal(reservePreviewReceipt(storage, "operator", ideaId, ideaId, model, "high"), false);
  assert.deepEqual(readPreviewReceipt(null, "operator", ideaId), { kind: "unavailable" });
});

test("later page preview and recovery are bound to their exact chunk", () => {
  const later = { ...reply, payload: { ...reply.payload, version: 2, chunkIndex: 1 } };
  assert.ok(readPreparedIdeaTransferPreview(201, later, previewId, ideaId,
    model, "high", 1));
  assert.equal(readPreparedIdeaTransferPreview(201, later, previewId, ideaId,
    model, "high", 2), null);
  assert.equal(readPreparedIdeaTransferPreview(201, reply, previewId, ideaId,
    model, "high", 1), null);
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); } };
  assert.equal(reservePreviewReceipt(storage, "operator", ideaId, previewId,
    model, "high", 1), true);
  assert.deepEqual(readPreviewReceipt(storage, "operator", ideaId, 0),
    { kind: "absent" });
  assert.equal(readPreviewReceipt(storage, "operator", ideaId, 1).kind,
    "present");
  assert.equal(reservePreviewReceipt(storage, "operator", ideaId, ideaId,
    model, "high", 1), false);
  assert.equal(reservePreviewReceipt(storage, "operator", ideaId, ideaId,
    model, "high", 2), true);
});

test("Admin UI gates preparation on an observed idea-only plan and provides exact-ID read-back", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxFrontierModelsPanel.tsx", import.meta.url), "utf8");
  const input = readFileSync(new URL("../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../components/admin/AmuxInitialPlanPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(panel, /!previewAvailable \|\| !planReady \|\| declaredExternalSources/);
  assert.match(panel, /reservePreviewReceipt\(receiptStore\(\), operatorId, ideaId, previewId/);
  assert.match(panel, /new URLSearchParams\(\{ previewId: pendingId \}\)/);
  assert.match(panel, /readPreparedIdeaTransferPreview\(response\.status, body/);
  assert.match(plan, /onCommitted\?\.\(ideaId\)/);
  assert.match(input, /planReady=\{submission\.kind === "submitted" && planReadyIdeaId === submission\.ideaId\}/);
  assert.match(page, /transferPreviewWritePermitted\(process\.env\[AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV\]\)/);
  assert.match(page, /transferPreviewReadPermitted\(process\.env\[AMUX_V4_TRANSFER_PREVIEW_READ_ENV\]\)/);
});

test("Admin confirmation uses a separate dark gate and a one-shot browser receipt", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxFrontierModelsPanel.tsx", import.meta.url), "utf8");
  const input = readFileSync(new URL("../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(page, /transferConfirmWritePermitted\(process\.env\[AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV\]\)/);
  assert.match(page, /transferConfirmReadPermitted\(process\.env\[AMUX_V4_TRANSFER_CONFIRM_READ_ENV\]\)/);
  assert.match(input, /confirmAvailable=\{transferConfirmAvailable\}/);
  assert.match(panel, /reserveConfirmationAttempt\(receiptStore\(\), operatorId, value\.previewId/);
  assert.match(panel, /readConfirmationAttempt\(receiptStore\(\), operatorId, pendingId/);
  assert.match(panel, /await readConfirmation\(value\.previewId, ideaId/);
  assert.match(panel, /payloadDigestKeyId: value\.payloadDigestKeyId/);
});
