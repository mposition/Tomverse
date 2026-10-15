import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("the plan screen posts once to the whole-plan route and reads back instead of re-posting", () => {
  const panel = readFileSync("components/admin/AmuxIdeaPlanApprovalPanel.tsx", "utf8");
  const approve = panel.slice(panel.indexOf("const approve = async"), panel.indexOf("const readBack ="));
  assert.equal((approve.match(/adminFetch\(/g) ?? []).length, 1, "one request, never a retry");
  assert.ok(approve.includes("/api/admin/amux/ideas/plan"));
  assert.ok(approve.indexOf("writePending(ideaId, planRequestId)") < approve.indexOf("adminFetch("),
    "the attempt is remembered before the request");
  assert.ok(approve.indexOf("if (readPending(ideaId))") < approve.indexOf("crypto.randomUUID()"),
    "an earlier lost attempt is read back, not sent again");
  assert.ok(approve.includes("buildAmuxV4PlanRequest({ ideaId, planRequestId"));
  // Model-derived text is rendered as text, never HTML.
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);
});

test("the analysis result offers the plan approval only for a finished proposal", () => {
  const result = readFileSync("components/admin/AmuxIdeaAnalysisResultPanel.tsx", "utf8");
  assert.ok(result.includes('view.state === "ready" && view.outcome === "propose" ? <AmuxIdeaPlanApprovalPanel'));
});

test("both admin locales describe the plan approval", () => {
  const messages = readFileSync("lib/adminMessages/amuxIdeaInput.ts", "utf8");
  for (const key of ["planApprovalTitle", "planApprovalHint", "planApprovalAction", "planApprovalUnknown", "planApprovalReadBack"]) {
    assert.equal((messages.match(new RegExp(`${key}:`, "g")) ?? []).length, 2, key);
  }
});
