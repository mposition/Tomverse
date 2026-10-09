import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  classifyFrontierRegistrationReadFailure,
  classifyFrontierRegistrationPost,
  clearFrontierRegistrationReceipt,
  decideFrontierRegistrationRestart,
  readAvailableFrontierModels,
  readCheckedFrontierSelection,
  readFrontierCatalogApprovalReadBack,
  readFrontierCatalogApprovalWrite,
  readFrontierRegistrationReceipt,
  reduceFrontierRegistrationPost,
  reserveFrontierRegistrationReceipt,
} from "../lib/amux/ideaFrontierCatalogUiCore.ts";

const model = { approvalId: "123e4567-e89b-42d3-a456-426614174000", approvalVersion: 1,
  provider: "openai", modelId: "gpt-frontier", allowedEfforts: ["high"] };
const reply = { state: "available", models: [model], transferAuthorized: false };

test("only a bounded no-transfer approved model list is displayed", () => {
  assert.deepEqual(readAvailableFrontierModels(200, reply), [model]);
  assert.equal(readAvailableFrontierModels(200, { ...reply, transferAuthorized: true }), null);
  assert.equal(readAvailableFrontierModels(503, reply), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply, models: [model, model] }), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply,
    models: [{ ...model, approvalId: "approval_123" }] }), null);
  assert.equal(readAvailableFrontierModels(200, { ...reply,
    models: [{ ...model, allowedEfforts: ["fast"] }] }), null);
});

test("a selection check must match the visible revision and never confer transfer authority", () => {
  const checked = { state: "current", approvalId: model.approvalId,
    approvalVersion: model.approvalVersion, transferAuthorized: false };
  assert.deepEqual(readCheckedFrontierSelection(200, checked, model), {
    approvalId: model.approvalId, approvalVersion: model.approvalVersion,
  });
  assert.equal(readCheckedFrontierSelection(200, { ...checked, transferAuthorized: true }, model), null);
  assert.equal(readCheckedFrontierSelection(200, { ...checked, approvalVersion: 2 }, model), null);
  assert.equal(readCheckedFrontierSelection(503, checked, model), null);
});

const pending = {
  approvalId: model.approvalId, provider: model.provider, modelId: model.modelId,
  allowedEfforts: ["low", "high"], expectedPreviousVersion: 0,
};

test("a registration success must bind the exact approval id and next version", () => {
  const reply = { approvalId: pending.approvalId, version: 1,
    status: "approved", auditId: "audit_12345678" };
  assert.deepEqual(readFrontierCatalogApprovalWrite(201, reply, pending), {
    state: "found", status: "approved", approvalVersion: 1,
  });
  assert.equal(readFrontierCatalogApprovalWrite(201,
    { ...reply, approvalId: crypto.randomUUID() }, pending), null);
  assert.equal(readFrontierCatalogApprovalWrite(201, { ...reply, version: 2 }, pending), null);
  assert.equal(readFrontierCatalogApprovalWrite(200, reply, pending), null);
});

test("exact-id read-back verifies identity and never turns absence into retry permission", () => {
  const found = { state: "found", retryWrite: false, approval: {
    id: pending.approvalId, provider: pending.provider, modelId: pending.modelId,
    allowedEfforts: pending.allowedEfforts, version: 1, status: "approved",
  } };
  assert.deepEqual(readFrontierCatalogApprovalReadBack(200, found, pending), {
    state: "found", status: "approved", approvalVersion: 1,
  });
  assert.deepEqual(readFrontierCatalogApprovalReadBack(200,
    { state: "not_visible", retryWrite: false }, pending), { state: "not_visible" });
  assert.equal(readFrontierCatalogApprovalReadBack(200,
    { state: "not_visible", retryWrite: true }, pending), null);
  assert.equal(readFrontierCatalogApprovalReadBack(200, { ...found,
    approval: { ...found.approval, modelId: "another-model" } }, pending), null);
  assert.equal(readFrontierCatalogApprovalReadBack(200, { ...found,
    approval: { ...found.approval, allowedEfforts: ["high", "low"] } }, pending), null);
});

test("unknown registration failures retain the exact receipt without retired approval semantics", () => {
  for (const body of [
    { error: "outcome_unknown", retryWrite: false, approvalId: pending.approvalId },
    { error: "request_already_seen", retryWrite: false, approvalId: pending.approvalId },
    { error: "catalog_unavailable", retryWrite: false, approvalId: pending.approvalId },
  ]) {
    const decision = classifyFrontierRegistrationPost({ status:
      body.error === "request_already_seen" ? 409 : 503, body }, pending);
    assert.deepEqual(decision, { kind: "verify" });
    assert.deepEqual(reduceFrontierRegistrationPost(decision, pending), {
      state: "unknown", pendingRegistration: pending,
      registrationConfirmed: false, receipt: "keep",
      failure: { kind: "unknown", code: null, approvalId: null },
    });
  }
});

test("a definite reauthentication refusal clears the receipt and unlocks a reviewed retry", () => {
  const decision = classifyFrontierRegistrationPost({ status: 428,
    body: { error: "ADMIN_REAUTHENTICATION_REQUIRED" } }, pending);
  assert.deepEqual(decision, { kind: "refused",
    code: "ADMIN_REAUTHENTICATION_REQUIRED", requiresReauthentication: true });
  assert.deepEqual(reduceFrontierRegistrationPost(decision, pending), {
    state: "idle", pendingRegistration: null,
    registrationConfirmed: false, receipt: "clear",
    failure: { kind: "reauthentication", code: "ADMIN_REAUTHENTICATION_REQUIRED",
      approvalId: null },
  });
});

test("registration read-back never interprets an approval id as retired two-person state", () => {
  assert.deepEqual(classifyFrontierRegistrationReadFailure({ status: 428,
    body: { error: "ADMIN_REAUTHENTICATION_REQUIRED" } }), { kind: "reauthentication" });
  assert.deepEqual(classifyFrontierRegistrationReadFailure({ status: 428,
    body: { error: "ADMIN_REAUTHENTICATION_REQUIRED", approvalId: pending.approvalId } }),
  { kind: "unknown" });
  assert.deepEqual(classifyFrontierRegistrationReadFailure({ status: 503,
    body: { error: "catalog_unavailable", approvalId: pending.approvalId } }),
  { kind: "unknown" });
});

test("an exact version conflict unlocks editing but ambiguous conflicts keep the same id", () => {
  const conflict = { error: "catalog_revision_changed", retryWrite: false,
    approvalId: pending.approvalId };
  const decision = classifyFrontierRegistrationPost({ status: 409, body: conflict }, pending);
  assert.deepEqual(decision, { kind: "refused",
    code: "catalog_revision_changed", requiresReauthentication: false });
  const transition = reduceFrontierRegistrationPost(decision, pending);
  assert.equal(transition.state, "idle");
  assert.equal(transition.registrationConfirmed, false);
  assert.equal(transition.pendingRegistration, null);
  assert.equal(transition.receipt, "clear");
  assert.deepEqual(classifyFrontierRegistrationPost({ status: 409,
    body: { ...conflict, approvalId: crypto.randomUUID() } }, pending), { kind: "verify" });
  assert.deepEqual(classifyFrontierRegistrationPost({ status: 503,
    body: { ...conflict, error: "catalog_revision_changed" } }, pending), { kind: "verify" });
});

test("the unresolved registration receipt is actor-bound and contains no secret or free text", () => {
  const values = new Map();
  const storage = {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    removeItem: (key) => { values.delete(key); },
  };
  assert.deepEqual(readFrontierRegistrationReceipt(storage, "owner-1"), { kind: "absent" });
  assert.equal(reserveFrontierRegistrationReceipt(storage, "owner-1", pending), true);
  assert.deepEqual(readFrontierRegistrationReceipt(storage, "owner-1"), {
    kind: "present", registration: pending,
  });
  assert.deepEqual(readFrontierRegistrationReceipt(storage, "owner-2"), { kind: "absent" });
  assert.equal(reserveFrontierRegistrationReceipt(storage, "owner-1",
    { ...pending, approvalId: crypto.randomUUID() }), false);
  const persisted = [...values.values()].join("");
  assert.doesNotMatch(persisted, /credential|secret|token|prompt|idea|body/i);
  clearFrontierRegistrationReceipt(storage, "owner-2", pending.approvalId);
  assert.equal(readFrontierRegistrationReceipt(storage, "owner-1").kind, "present");
  clearFrontierRegistrationReceipt(storage, "owner-1", pending.approvalId);
  assert.deepEqual(readFrontierRegistrationReceipt(storage, "owner-1"), { kind: "absent" });
  assert.deepEqual(decideFrontierRegistrationRestart(
    readFrontierRegistrationReceipt(storage, "owner-1")), { kind: "ready" });
  assert.equal(reserveFrontierRegistrationReceipt(storage, "owner-1", pending), true);
  assert.deepEqual(decideFrontierRegistrationRestart(
    readFrontierRegistrationReceipt(storage, "owner-1")), {
    kind: "recover", registration: pending,
  });
  assert.deepEqual(decideFrontierRegistrationRestart({ kind: "unavailable" }),
    { kind: "unavailable" });
});

test("Admin exposes the real write gate and freezes a submitted approval on exact-ID read-back", () => {
  const panel = readFileSync(new URL(
    "../components/admin/AmuxFrontierModelsPanel.tsx", import.meta.url), "utf8");
  const input = readFileSync(new URL(
    "../components/admin/AmuxIdeaInputPanel.tsx", import.meta.url), "utf8");
  const page = readFileSync(new URL(
    "../app/(site)/(application)/admin/amux-backlog/page.tsx", import.meta.url), "utf8");
  assert.match(page, /frontierModelsAvailable && frontierCatalogWritePermitted\(/);
  assert.match(input, /writeAvailable=\{frontierModelWriteAvailable\}/);
  assert.match(panel, /ownerConfirmedFrontierEligibility: true/);
  assert.match(panel, /reserveFrontierRegistrationReceipt\(receiptStore\(\), operatorId, registration\)/);
  assert.match(panel, /readFrontierRegistrationReceipt\(receiptStore\(\), operatorId\)/);
  assert.match(panel, /registrationState !== "idle"/);
  assert.match(panel,
    /new URLSearchParams\(\{ approvalId: registration\.approvalId \}\)/);
  const readBack = panel.slice(panel.indexOf("const readRegistration"),
    panel.indexOf("const checkSelection"));
  assert.match(readBack, /readFrontierCatalogApprovalReadBack/);
  assert.doesNotMatch(readBack, /method: "POST"/);
  assert.doesNotMatch(readBack, /readAdminApiFailure/);
  const post = panel.slice(panel.indexOf("const registerModel"),
    panel.indexOf("const readRegistration"));
  assert.match(post, /classifyFrontierRegistrationPost/);
  assert.doesNotMatch(post, /readAdminApiFailure/);
  assert.match(panel, /decideFrontierRegistrationRestart/);
});
