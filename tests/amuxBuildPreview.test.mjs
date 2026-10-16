import assert from "node:assert/strict";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

test("one request saves the idea, prepares its plan and its exact preview, and stops at the first step that does not finish", () => {
  const child = spawnSync(process.execPath, [
    "--experimental-test-module-mocks", "--conditions=react-server", "--import", "tsx",
    resolve("tests/support/amuxBuildPreviewRouteHarness.mjs"),
  ], { cwd: resolve(import.meta.dirname, ".."), encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr || child.stdout);
});

import { readFileSync } from "node:fs";

test("the frontier panel builds the preview in one request and recovers a lost answer as a lost submission", () => {
  const panel = readFileSync("components/admin/AmuxFrontierModelsPanel.tsx", "utf8");
  const action = panel.slice(panel.indexOf("const buildPreview = async"), panel.indexOf("const approveExecution = async"));
  assert.equal((action.match(/adminFetch\(/g) ?? []).length, 1, "one request, never a retry");
  assert.ok(action.includes("/api/admin/amux/ideas/build-preview"));
  assert.ok(action.indexOf("reserveBuildPreviewReceipt(") < action.indexOf("build.reserve(requestId)") &&
    action.indexOf("build.reserve(requestId)") < action.indexOf("adminFetch("),
    "the preview half and the submission attempt are both recorded before the request");
  const unknownAt = action.lastIndexOf("build.onUnknown(requestId)");
  assert.ok(unknownAt > 0 && !action.slice(action.indexOf("// Unknown:"), unknownAt).includes("takeBuildPreviewReceipt"),
    "a lost answer keeps the receipt for the read-back");
  // Recovery links the receipt only once the plan reads back committed.
  const link = panel.slice(panel.indexOf("// A build whose answer was lost"), panel.indexOf("const refresh = () =>"));
  assert.ok(link.includes("if (!ideaId || !planReady || !buildRequestId"));
  assert.ok(link.indexOf("takeBuildPreviewReceipt(") < link.indexOf("readBack(receipt.previewId"));
  const input = readFileSync("components/admin/AmuxIdeaInputPanel.tsx", "utf8");
  assert.ok(input.includes('build={submission.kind === "submitted" ? null : buildHooks}'));
  // An unknown answer is read back by its request id (after the blocking dialog says it is unknown), never posted again.
  assert.match(input, /onUnknown: \(requestId\) => \{\n[^}]*tone: "unknown"[^}]*\}\);\n\s*void readBack\(requestId\);\n\s*\},/);
  assert.ok(input.includes('buildRequestId={submission.kind === "submitted" ? submission.requestId : null}'));
  assert.equal(readFileSync("components/admin/AmuxInitialPlanPanel.tsx", "utf8").includes("BuildPreview"), false,
    "a plan read back absent never discards the receipt: the build may still be running");
  const messages = readFileSync("lib/adminMessages/amuxIdeaInput.ts", "utf8");
  for (const key of ["buildPreviewAction", "buildPreviewHint", "buildPreviewPending", "buildPreviewRecoveryUnavailable"]) {
    assert.equal((messages.match(new RegExp(`${key}:`, "g")) ?? []).length, 2, key);
  }
});

test("the build receipt is kept per submission request, read once and refused when malformed", async () => {
  const { reserveBuildPreviewReceipt, takeBuildPreviewReceipt } = await import("../lib/amux/ideaBuildPreviewUiCore.ts");
  const map = new Map();
  const storage = { getItem: (k) => map.get(k) ?? null, setItem: (k, v) => map.set(k, String(v)), removeItem: (k) => map.delete(k) };
  const model = { approvalId: "44444444-4444-4444-8444-444444444444", approvalVersion: 1, provider: "anthropic",
    modelId: "claude-opus-5-5", allowedEfforts: ["high"] };
  const receipt = { previewId: "33333333-3333-4333-8333-333333333333", model, effort: "high" };
  assert.equal(reserveBuildPreviewReceipt(null, "op", "r1", receipt), false);
  assert.equal(reserveBuildPreviewReceipt(storage, "op", "r1", receipt), true);
  assert.equal(takeBuildPreviewReceipt(storage, "other", "r1"), null, "keyed by operator");
  assert.deepEqual(takeBuildPreviewReceipt(storage, "op", "r1"), receipt);
  assert.equal(takeBuildPreviewReceipt(storage, "op", "r1"), null, "read once");
  map.set("amux-v4-build-preview:op:r2", JSON.stringify({ previewId: 1, model, effort: "high" }));
  assert.equal(takeBuildPreviewReceipt(storage, "op", "r2"), null);
  assert.equal(map.has("amux-v4-build-preview:op:r2"), false, "a malformed record is removed too");
});

test("a build answer keeps a preview receipt only for a prepared or unknown preview, and refuses only before the save", async () => {
  const { classifyBuildPreviewAnswer: c } = await import("../lib/amux/ideaBuildPreviewUiCore.ts");
  const ideaId = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(c(201, { state: "prepared", ideaId }),
    { kind: "saved", ideaId, hasExternalSources: false, planReady: true, previewMayExist: true,
      previewPrepared: true, stoppedAt: null, error: null });
  assert.deepEqual(c(503, { step: "preview", error: "outcome_unknown", ideaId }).previewMayExist, true);
  for (const [status, error] of [[409, "model_changed"], [409, "not_ready"], [503, "integrity_unavailable"],
    [503, "preview_disabled"], [400, "schema_rejected"]]) {
    const answer = c(status, { step: "preview", error, ideaId });
    assert.deepEqual([answer.kind, answer.planReady, answer.previewMayExist], ["saved", true, false], error);
    // A refusal after the save is a stop, never a prepared preview: the screen must not say "ready".
    assert.deepEqual([answer.previewPrepared, answer.stoppedAt, answer.error], [false, "preview", error], error);
  }
  assert.deepEqual(c(503, { step: "plan", error: "outcome_unknown", ideaId }),
    { kind: "saved", ideaId, hasExternalSources: false, planReady: false, previewMayExist: false,
      previewPrepared: false, stoppedAt: "plan", error: "outcome_unknown" });
  const sources = c(201, { state: "submitted", ideaId, hasExternalSources: true });
  assert.deepEqual([sources.hasExternalSources, sources.previewPrepared, sources.stoppedAt], [true, false, null],
    "an idea naming sources stops after the save: saved, not prepared");
  assert.deepEqual([c(503, { step: "preview", error: "outcome_unknown", ideaId }).previewPrepared], [false],
    "an unknown preview is not a prepared one");
  // Before the save: only errors known to precede it.
  assert.deepEqual(c(503, { error: "build_preview_disabled" }), { kind: "refused", code: "build_preview_disabled" });
  assert.deepEqual(c(429, { error: "Too many", code: "API_RATE_LIMITED" }), { kind: "refused", code: "API_RATE_LIMITED" });
  assert.deepEqual(c(400, { step: "submission", error: "schema_rejected" }), { kind: "refused", code: "schema_rejected" });
  assert.deepEqual(c(503, { step: "submission", error: "audit_unavailable" }).kind, "refused");
  for (const answer of [c(503, { step: "submission", error: "outcome_unknown", ideaId }),
    c(409, { step: "submission", error: "request_already_seen" }), c(503, { error: "outcome_unknown" }),
    c(500, null),
    c(400, { error: "build_preview_disabled" }), c(503, { step: "submission", error: "key_store_unavailable" })]) {
    assert.equal(answer?.kind, "verify");
  }
});

test("the execution approval reads as one numbered card: model, what is sent, cost and approval", () => {
  const panel = readFileSync("components/admin/AmuxFrontierModelsPanel.tsx", "utf8");
  const order = ["{m.executionCardTitle}", "{m.executionStepModel}", "{m.executionStepTransfer}",
    "{m.executionTransferShow}", "{m.executionStepApprove}", "void approveExecution()"].map((text) => panel.indexOf(text));
  assert.ok(order.every((at) => at > 0), "every step is drawn");
  assert.deepEqual([...order].sort((a, b) => a - b), order, "in the mockup's order");
  assert.ok(panel.includes("{preview.value.prompt}"), "the exact payload is still shown in full");
});
