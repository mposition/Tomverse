import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import { amuxIdeaProgress, amuxIdeaProgressStep } from "../lib/amux/ideaProgressCore.ts";
import { AMUX_IDEA_PROGRESS_LIMIT, readAmuxIdeaProgressInTx } from "../lib/amux/ideaProgressRead.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const facts = (overrides = {}) => ({ state: "submitted", cancelled: false, chunks: [], proposedUnits: 0, cards: [],
  ...overrides });
const chunk = (overrides = {}) => ({ chunkIndex: 0, state: "draft_ready", coverageStatus: "complete",
  previewState: "completed", holdStatus: "succeeded", ...overrides });
const task = (overrides = {}) => ({ cardType: "task", status: "todo", reviewPrNumber: null, merged: false, ...overrides });

test("each idea is at exactly one of the six stages, and a human step still open always comes first", () => {
  const stage = (value) => { const result = amuxIdeaProgress(facts(value)); return [result.stage, result.waitingFor]; };
  assert.deepEqual(stage({}), ["execution_approval", "execution_approval"], "saved, nothing approved yet");
  assert.deepEqual(stage({ chunks: [chunk({ state: "awaiting_preview", coverageStatus: null, previewState: "prepared", holdStatus: null })] }),
    ["execution_approval", "execution_approval"]);
  assert.deepEqual(stage({ chunks: [chunk({ state: "awaiting_preview", coverageStatus: null, previewState: "expired", holdStatus: "released" })] }),
    ["execution_approval", "execution_approval"], "an expired preview needs a new approval");
  assert.deepEqual(stage({ chunks: [chunk({ state: "awaiting_preview", coverageStatus: null, previewState: "confirmed", holdStatus: "reserved" })] }),
    ["analysis", null]);
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk({ state: "in_flight", coverageStatus: null, previewState: "in_flight", holdStatus: "in_flight" })] }),
    ["analysis", null]);
  // analyzing, but waiting on a person: the next page, or the owner's answer.
  assert.deepEqual(stage({ state: "analyzing", proposedUnits: 2, chunks: [chunk({ coverageStatus: "more" })] }),
    ["execution_approval", "continuation"]);
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk(), chunk({ chunkIndex: 1, state: "awaiting_preview", coverageStatus: null,
    previewState: "prepared", holdStatus: null })] }), ["execution_approval", "continuation"]);
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk({ coverageStatus: "needs_owner_input" })] }),
    ["execution_approval", "owner_input"]);
  assert.deepEqual(stage({ state: "awaiting_owner", proposedUnits: 3, chunks: [chunk()] }), ["plan_approval", "plan_approval"]);
  // Some cards registered one by one, proposals still undecided: the plan is still waiting.
  assert.deepEqual(stage({ proposedUnits: 1, chunks: [chunk()], cards: [task({ merged: true })] }), ["plan_approval", "plan_approval"]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task(), task({ cardType: "story" })] }), ["execution", null]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ status: "review", reviewPrNumber: 12 }), task()] }), ["review", null]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ status: "done", merged: true }), task({ cardType: "story" })] }),
    ["done", null], "stories do not hold an idea open");
  assert.deepEqual(stage({ cancelled: true, cards: [task()] }), ["cancelled", null]);
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ status: "cancelled" })] }), ["cancelled", null],
    "tasks all cancelled are not done");
  assert.deepEqual(stage({ chunks: [chunk()], cards: [task({ merged: true }), task({ status: "cancelled" })] }), ["done", null]);
  // A stale hold on an earlier page never hides the human step on the latest one.
  assert.deepEqual(stage({ state: "analyzing", chunks: [chunk({ holdStatus: "reserved" }), chunk({ chunkIndex: 1, coverageStatus: "needs_owner_input" })] }),
    ["execution_approval", "owner_input"]);
  const counts = amuxIdeaProgress(facts({ cards: [task({ merged: true }), task({ status: "review", reviewPrNumber: 3 }), task()] })).tasks;
  assert.deepEqual(counts, { total: 3, done: 1, inReview: 1 });
});

test("an unknown outcome is flagged, never a decision to retry", () => {
  for (const value of [chunk({ previewState: "outcome_unknown" }), chunk({ holdStatus: "outcome_unknown" }),
    chunk({ state: "outcome_unknown" })]) {
    const result = amuxIdeaProgress(facts({ proposedUnits: 1, chunks: [value] }));
    assert.equal(result.attention, true);
    assert.equal(result.waitingFor, null, "a stopped idea is not offered as a decision");
  }
  assert.deepEqual(["execution_approval", "done", "cancelled"].map(amuxIdeaProgressStep), [1, 6, null]);
});

test("the list is one bounded snapshot of seven reads that never reads idea text", async () => {
  assert.deepEqual(AMUX_DB_BOUNDARIES.ideaProgressListRead,
    { operation: "idea_progress_list_read", prismaCallCeiling: 9, isolation: "read" });
  const ideaId = "idea-1";
  const calls = [];
  const rows = {
    amuxIdeaSubmission: [{ id: ideaId, requestId: "11111111-1111-4111-8111-111111111111", state: "awaiting_owner",
      submittedAt: new Date("2026-10-15T00:00:00Z"), analysisCompletedAt: new Date(), cancelledAt: null }],
    amuxIdeaAnalysisChunk: [{ ideaId, chunkIndex: 0, state: "decided", coverageStatus: "complete", currentPreviewId: "p1" }],
    amuxIdeaTransferPreview: [{ id: "p1", ideaId, state: "completed" }],
    amuxIdeaAnalysisBudgetHold: [{ previewId: "p1", status: "succeeded" }],
    amuxIdeaUnitDecision: [{ ideaId, registeredWorkItemId: "c1" }, { ideaId, registeredWorkItemId: "c2" }],
    amuxWorkItem: [
      { id: "c1", cardType: "story", status: "backlog", reviewPrNumber: null, v4TerminalAt: null,
        displayKey: "AMUX-ADM-001", createdAt: new Date(1) },
      { id: "c2", cardType: "task", status: "review", reviewPrNumber: 2540, v4TerminalAt: null,
        displayKey: "AMUX-ADM-002", createdAt: new Date(2) }],
  };
  const tx = new Proxy({}, { get: (_target, model) => ({
    findMany: async (args) => { calls.push([model, args]); return rows[model] ?? []; },
    groupBy: async (args) => { calls.push([model, args]); return []; },
  }) });
  const now = new Date("2026-10-15T03:00:00Z");
  const [row] = await readAmuxIdeaProgressInTx(tx, "owner-1", now);
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0][1].where, { actorUserId: "owner-1" });
  assert.equal(calls[0][1].take, AMUX_IDEA_PROGRESS_LIMIT);
  for (const [, args] of calls) {
    const selected = Object.keys(args.select ?? {});
    assert.equal(selected.some((key) => /Ciphertext|title|body/i.test(key)), false, `no text: ${selected}`);
  }
  assert.equal(calls.find(([model]) => model === "amuxIdeaUnitDecision")[1].where.action, "register_card");
  assert.deepEqual(calls.find(([model]) => model === "amuxIdeaDraftUnit")[1].where.expiresAt, { gt: now },
    "an expired proposal waits for nobody");
  assert.deepEqual([row.stage, row.displayKey, row.reviewPullRequests],
    ["review", "AMUX-ADM-001", [{ number: 2540, displayKey: "AMUX-ADM-002" }]]);
});

test("the Ideas tab shows the inbox and list above the input, and opens a row's idea by its request id", () => {
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.match(page, /tab\.id === "ideas" && ideaReadBackAvailable && !hasRecentAdminAuthentication\(session\)\) \{\n    ideaProgress = "reauthenticate";/,
    "a stale sign-in reads nothing");
  assert.match(page, /\} else if \(tab\.id === "ideas" && ideaReadBackAvailable\) \{/, "read only for the open Ideas tab, behind its switch");
  assert.match(page, /readAmuxIdeaProgressForOwner\(session\.user\.id\)\.catch/);
  assert.ok(page.indexOf("<AmuxIdeaProgressPanel") < page.indexOf("<AmuxIdeaInputPanel"));
  assert.match(page, /<AmuxIdeaInputPanel key=\{openRequestId \?\? "new"\} openRequestId=\{openRequestId\}/);
  const panel = read("components/admin/AmuxIdeaProgressPanel.tsx");
  assert.match(panel, /if \(rows === null\)/, "a failed read is shown, not an empty list");
  assert.equal(/adminFetch|method:/.test(panel), false, "the list only links; it never writes");
  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  const recover = input.slice(input.indexOf("const recoverFromReceipts"), input.indexOf("useEffect(() => {", input.indexOf("const recoverFromReceipts")));
  assert.ok(recover.indexOf('recovered.kind === "pending"') < recover.indexOf("openRequestId &&"),
    "an unresolved request always comes before the idea a row opened");
});

test("the list asks before it leaves an unsaved draft", () => {
  const panel = read("components/admin/AmuxIdeaProgressPanel.tsx");
  assert.equal(panel.split("onClick={keepDraft}").length - 1, 2, "both links to an idea ask first");
  const input = read("components/admin/AmuxIdeaInputPanel.tsx");
  assert.ok(input.includes('const draftAtRisk = hasUnsavedInput && (submission.kind === "idle" || submission.kind === "refused");'));
  assert.ok(input.includes("setAmuxIdeaUnsavedDraft(draftAtRisk)"));
});
