import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import { amuxIdeaProgress, amuxIdeaProgressStep } from "../lib/amux/ideaProgressCore.ts";
import { AMUX_IDEA_PROGRESS_LIMIT, readAmuxIdeaProgressInTx } from "../lib/amux/ideaProgressRead.ts";

const root = process.cwd();
const read = (path) => readFileSync(join(root, path), "utf8");
const facts = (overrides = {}) => ({ state: "submitted", analysisCompleted: false, cancelled: false,
  previews: [], chunkStates: [], proposedUnits: 0, cards: [], ...overrides });
const task = (overrides = {}) => ({ cardType: "task", status: "todo", reviewPrNumber: null, terminal: false, ...overrides });

test("each idea is at exactly one of the six stages, and only the human ones wait for a decision", () => {
  const stage = (value) => { const result = amuxIdeaProgress(facts(value)); return [result.stage, result.decisionWaiting]; };
  assert.deepEqual(stage({}), ["execution_approval", true], "saved, nothing approved yet");
  assert.deepEqual(stage({ previews: [{ state: "prepared", holdStatus: null }] }), ["execution_approval", true]);
  assert.deepEqual(stage({ previews: [{ state: "expired", holdStatus: "released" }] }), ["execution_approval", true],
    "an expired preview needs a new approval");
  assert.deepEqual(stage({ previews: [{ state: "confirmed", holdStatus: "reserved" }] }), ["analysis", false]);
  assert.deepEqual(stage({ state: "analyzing", previews: [{ state: "in_flight", holdStatus: "in_flight" }] }), ["analysis", false]);
  assert.deepEqual(stage({ state: "awaiting_owner", analysisCompleted: true, proposedUnits: 3 }), ["plan_approval", true]);
  assert.deepEqual(stage({ cards: [task(), task({ cardType: "story" })] }), ["execution", false]);
  assert.deepEqual(stage({ cards: [task({ status: "review", reviewPrNumber: 12 }), task()] }), ["review", false]);
  assert.deepEqual(stage({ cards: [task({ status: "done", terminal: true }), task({ cardType: "story" })] }), ["done", false],
    "stories do not hold an idea open");
  assert.deepEqual(stage({ cancelled: true, cards: [task()] }), ["cancelled", false]);
  const counts = amuxIdeaProgress(facts({ cards: [task({ terminal: true }), task({ status: "review", reviewPrNumber: 3 }), task()] })).tasks;
  assert.deepEqual(counts, { total: 3, done: 1, inReview: 1 });
});

test("an unknown outcome is flagged, never a decision to retry", () => {
  for (const value of [{ previews: [{ state: "outcome_unknown", holdStatus: null }] },
    { previews: [{ state: "confirmed", holdStatus: "outcome_unknown" }] }, { chunkStates: ["outcome_unknown"] }]) {
    const result = amuxIdeaProgress(facts(value));
    assert.equal(result.attention, true);
    assert.equal(result.decisionWaiting, false, "a stopped idea is not offered as a decision");
  }
  assert.deepEqual([1, 6, null].map((step, index) => amuxIdeaProgressStep(["execution_approval", "done", "cancelled"][index])), [1, 6, null]);
});

test("the list is one bounded snapshot of seven reads that never reads idea text", async () => {
  assert.deepEqual(AMUX_DB_BOUNDARIES.ideaProgressListRead,
    { operation: "idea_progress_list_read", prismaCallCeiling: 9, isolation: "read" });
  const ideaId = "idea-1";
  const calls = [];
  const rows = {
    amuxIdeaSubmission: [{ id: ideaId, requestId: "11111111-1111-4111-8111-111111111111", state: "awaiting_owner",
      submittedAt: new Date("2026-10-15T00:00:00Z"), analysisCompletedAt: new Date(), cancelledAt: null }],
    amuxIdeaAnalysisChunk: [{ ideaId, state: "decided", currentPreviewId: "p1" }],
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
  const [row] = await readAmuxIdeaProgressInTx(tx, "owner-1");
  assert.equal(calls.length, 7);
  assert.deepEqual(calls[0][1].where, { actorUserId: "owner-1" });
  assert.equal(calls[0][1].take, AMUX_IDEA_PROGRESS_LIMIT);
  for (const [, args] of calls) {
    const selected = Object.keys(args.select ?? {});
    assert.equal(selected.some((key) => /Ciphertext|title|body/i.test(key)), false, `no text: ${selected}`);
  }
  assert.equal(calls.find(([model]) => model === "amuxIdeaUnitDecision")[1].where.action, "register_card");
  assert.deepEqual([row.stage, row.displayKey, row.reviewPullRequests],
    ["review", "AMUX-ADM-001", [{ number: 2540, displayKey: "AMUX-ADM-002" }]]);
});

test("the Ideas tab shows the inbox and list above the input, and opens a row's idea by its request id", () => {
  const page = read("app/(site)/(application)/admin/amux-backlog/page.tsx");
  assert.match(page, /tab\.id === "ideas" && ideaReadBackAvailable\)/, "read only for the open Ideas tab, behind its switch");
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
