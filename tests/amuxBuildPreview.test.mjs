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
  assert.ok(action.includes('(row.step === "preview" && (response.status >= 500 || row.error === "outcome_unknown"))'),
    "only a preview that may exist keeps a receipt; a definite preview refusal keeps none");
  assert.ok(action.includes("if (previewMayExist && receipt)"));
  const unknownAt = action.lastIndexOf("build.onUnknown(requestId)");
  assert.ok(unknownAt > 0 && !action.slice(action.indexOf("// Unknown:"), unknownAt).includes("takeBuildPreviewReceipt"),
    "a lost answer keeps the receipt for the read-back");
  // Recovery links the receipt only once the plan reads back committed.
  const link = panel.slice(panel.indexOf("// A build whose answer was lost"), panel.indexOf("const refresh = () =>"));
  assert.ok(link.includes("if (!ideaId || !planReady || !buildRequestId"));
  assert.ok(link.indexOf("takeBuildPreviewReceipt(") < link.indexOf("readBack(receipt.previewId"));
  const input = readFileSync("components/admin/AmuxIdeaInputPanel.tsx", "utf8");
  assert.ok(input.includes('build={submission.kind === "submitted" ? null : buildHooks}'));
  assert.ok(input.includes("onUnknown: (requestId) => { void readBack(requestId); }"));
  assert.ok(input.includes('buildRequestId={submission.kind === "submitted" ? submission.requestId : null}'));
  assert.ok(input.includes("onAbsent={onInitialPlanAbsent}"), "a plan read back absent discards the receipt");
  const plan = readFileSync("components/admin/AmuxInitialPlanPanel.tsx", "utf8");
  const absent = plan.slice(plan.indexOf('decision.kind === "absent"'));
  assert.ok(absent.slice(0, 200).includes("onAbsent?.(ideaId)"));
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
