import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

test("the plan screen posts once to the whole-plan route and reads back instead of re-posting", () => {
  const panel = readFileSync("components/admin/AmuxIdeaPlanApprovalPanel.tsx", "utf8");
  const approve = panel.slice(panel.indexOf("const approve = async"), panel.indexOf("const readBack ="));
  assert.equal((approve.match(/adminFetch\(/g) ?? []).length, 1, "one request, never a retry");
  assert.ok(approve.includes("/api/admin/amux/ideas/plan"));
  assert.ok(approve.indexOf("writePending(ideaId, { planRequestId") < approve.indexOf("adminFetch("),
    "the attempt is remembered before the request");
  assert.ok(approve.indexOf("if (readPending(ideaId))") < approve.indexOf("crypto.randomUUID()"),
    "an earlier lost attempt is read back, not sent again");
  assert.ok(approve.includes("buildAmuxV4PlanRequest({ ideaId, planRequestId"));
  // A lost answer stays locked until a fresh read shows it settled.
  const readBack = panel.slice(panel.indexOf("const readBack = async"), panel.indexOf("const setMetric ="));
  assert.ok(readBack.indexOf("await load()") < readBack.indexOf("writePending(ideaId, null)"),
    "the attempt is released only after the fresh read");
  assert.ok(readBack.includes("stillProposed.length === 0 ||"));
  assert.ok(readBack.includes("Date.now() - pending.startedAt > PLAN_SETTLED_AFTER_MS"));
  assert.ok(readBack.includes('setState("processing")'));
  assert.ok(panel.includes("const PLAN_SETTLED_AFTER_MS = 180_000;"));
  // Every analysis page is read, so the screen shows what the server approves.
  assert.ok(panel.includes("async function readAllUnits("));
  assert.ok(panel.includes("page = view.nextChunkIndex"));
  // Model-derived text is rendered as text, never HTML.
  assert.doesNotMatch(panel, /dangerouslySetInnerHTML/);
});

test("the analysis result offers the plan approval only for a finished proposal", () => {
  const result = readFileSync("components/admin/AmuxIdeaAnalysisResultPanel.tsx", "utf8");
  assert.ok(result.includes('view.state === "ready" && view.outcome === "propose" ? <AmuxIdeaPlanApprovalPanel'));
  assert.ok(result.includes("ideaId={ideaId} onChanged={() => void refresh()} />"));
});

test("both admin locales describe the plan approval", () => {
  const messages = readFileSync("lib/adminMessages/amuxIdeaInput.ts", "utf8");
  for (const key of ["planApprovalTitle", "planApprovalHint", "planApprovalAction", "planApprovalUnknown", "planApprovalReadBack"]) {
    assert.equal((messages.match(new RegExp(`${key}:`, "g")) ?? []).length, 2, key);
  }
});
