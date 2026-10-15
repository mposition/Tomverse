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
  assert.ok(action.indexOf("build.reserve(requestId)") < action.indexOf("adminFetch("), "the attempt is recorded first");
  assert.ok(action.includes("reservePreviewReceipt(receiptStore(), operatorId, builtIdeaId, previewId"),
    "a preview that may exist is recovered by its own receipt");
  assert.ok(action.includes("build.onUnknown(requestId)"));
  const input = readFileSync("components/admin/AmuxIdeaInputPanel.tsx", "utf8");
  assert.ok(input.includes('build={submission.kind === "submitted" ? null : buildHooks}'));
  assert.ok(input.includes("onUnknown: (requestId) => { void readBack(requestId); }"));
  const messages = readFileSync("lib/adminMessages/amuxIdeaInput.ts", "utf8");
  for (const key of ["buildPreviewAction", "buildPreviewHint", "buildPreviewPending"]) {
    assert.equal((messages.match(new RegExp(`${key}:`, "g")) ?? []).length, 2, key);
  }
});
