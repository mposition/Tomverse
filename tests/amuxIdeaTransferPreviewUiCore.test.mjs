import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  clearRefusedPreviewReceipt, definitivePreviewPrewriteRefusal,
  readPreparedIdeaTransferPreview, readPreviewReceipt, readPreviewWriteReply,
  replacePreviewReceipt,
  reservePreviewReceipt,
} from "../lib/amux/ideaTransferPreviewUiCore.ts";

const model = { approvalId: "123e4567-e89b-42d3-a456-426614174003",
  approvalVersion: 1, provider: "openai", modelId: "gpt-frontier",
  allowedEfforts: ["high"] };
const ideaId = "123e4567-e89b-42d3-a456-426614174002";
const previewId = "123e4567-e89b-42d3-a456-426614174001";
const reply = { state: "prepared", previewId, expiresAt: "2099-10-02T12:00:00.000Z",
  payloadDigest: "a".repeat(64), payloadDigestKeyId: "synthetic-key",
  transferAuthorized: false,
  payload: { version: 1, previewId, ideaId, templateVersion: "amux-v4-analysis-prompt-v3",
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

test("a replacement receipt changes only the expected preview id", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); } };
  const nextId = "123e4567-e89b-42d3-a456-426614174004";
  assert.equal(reservePreviewReceipt(storage, "operator", ideaId, previewId, model, "high"), true);
  assert.equal(replacePreviewReceipt(storage, "operator", ideaId,
    ideaId, nextId, model, "high"), false);
  assert.equal(replacePreviewReceipt(storage, "operator", ideaId,
    previewId, nextId, model, "high"), true);
  assert.deepEqual(readPreviewReceipt(storage, "operator", ideaId), {
    kind: "present", previewId: nextId, model, effort: "high",
  });
  assert.equal(replacePreviewReceipt(storage, "operator", ideaId,
    previewId, previewId, model, "high"), false);
  assert.equal(replacePreviewReceipt(storage, "operator", ideaId,
    nextId, previewId, model, "high"), true,
  "a definitive refusal restores the exact prior receipt for read-back");
  assert.equal(readPreviewReceipt(storage, "operator", ideaId).previewId, previewId);
});

test("definite pre-write refusals release only their exact receipt; unknown outcomes stay fenced", () => {
  const values = new Map();
  const storage = { getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); } };
  assert.equal(reservePreviewReceipt(storage, "operator", ideaId, previewId, model, "high"), true);
  for (const [status, body] of [
    [400, { error: "schema_rejected" }],
    [403, { error: "Forbidden." }],
    [404, { error: "not_found" }],
    [413, { code: "REQUEST_BODY_TOO_LARGE" }],
    [415, { error: "content_type_refused" }],
    [428, { error: "ADMIN_REAUTHENTICATION_REQUIRED" }],
    [429, { code: "API_RATE_LIMITED" }],
    [409, { error: "not_ready" }],
    [409, { error: "model_changed" }],
    [503, { error: "preview_disabled" }],
  ]) assert.equal(definitivePreviewPrewriteRefusal(status, body), true);
  for (const [status, body] of [
    [503, { error: "outcome_unknown" }],
    [503, { error: "preview_unavailable" }],
    [409, { error: "outcome_unknown" }],
    [400, null], [404, null], [429, null],
    [404, { error: "some_future_postwrite_error" }],
    [200, { state: "prepared" }],
  ]) assert.equal(definitivePreviewPrewriteRefusal(status, body), false);
  assert.equal(clearRefusedPreviewReceipt(storage, "operator", ideaId, ideaId), false);
  assert.equal(readPreviewReceipt(storage, "operator", ideaId).kind, "present");
  assert.equal(clearRefusedPreviewReceipt(storage, "operator", ideaId, previewId), true);
  assert.deepEqual(readPreviewReceipt(storage, "operator", ideaId), { kind: "absent" });
});

test("a consumed refusal still has a readable server error for the Admin notice", async () => {
  const response = new Response(JSON.stringify({ error: "ADMIN_REAUTHENTICATION_REQUIRED" }),
    { status: 428, headers: { "content-type": "application/json" } });
  const reply = await readPreviewWriteReply(response);
  assert.equal(reply.definitiveRefusal, true);
  assert.deepEqual(reply.body, { error: "ADMIN_REAUTHENTICATION_REQUIRED" });
  assert.deepEqual(await reply.refusalResponse.json(), reply.body,
    "the notice must not throw after the original response was consumed");

  const ambiguous = await readPreviewWriteReply(new Response(
    JSON.stringify({ error: "outcome_unknown" }), { status: 503 }));
  assert.equal(ambiguous.definitiveRefusal, false);
});

test("Admin UI gates preparation on an observed idea-only plan and provides exact-ID read-back", () => {
  const panel = readFileSync(new URL("../components/admin/AmuxFrontierModelsPanel.tsx", import.meta.url), "utf8");
  const input = readFileSync(new URL("../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const plan = readFileSync(new URL("../components/admin/AmuxInitialPlanPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(panel, /!previewAvailable \|\| !planReady \|\| declaredExternalSources/);
  assert.match(panel, /reservePreviewReceipt\(receiptStore\(\), operatorId,/);
  assert.match(panel, /replacePreviewReceipt\(receiptStore\(\), operatorId, ideaId,/);
  assert.match(panel, /readPreviewWriteReply\(response\)/);
  assert.match(panel, /clearRefusedPreviewReceipt\(receiptStore\(\), operatorId, ideaId, previewId\)/);
  assert.match(panel, /if \(previous\?\.kind === "present"\) \{[\s\S]*?await readBack\(previous\.previewId, previous\.model, previous\.effort\);/);
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
