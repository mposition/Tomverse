import assert from "node:assert/strict";
import test from "node:test";
import { acceptResearchRunUpdate, researchProgress, researchRunNeedsPolling, researchStatusKey } from "../packages/chat-core/src/research.ts";
import { createResearchApi } from "../packages/api-client/src/research.ts";

const view = (patch = {}) => ({ id: "run1", engineVersion: 2, conversationId: "conv1", assistantMessageId: "m1", status: "running",
  eventSequence: 5, inputRevision: 0, planRevision: 1, approvedPlanRevision: 1, qualityStatus: null, currentReportRevision: 0,
  pauseRequested: false, cancelRequested: false,
  progress: { items: { queued: 2, running: 1, completed: 3, failed: 0, attention: 0, blocked: 0, cancelled: 0 }, questions: [], sourcesSeen: 0, sourcesRead: 0, privateSources: 0, openQuestions: [] },
  money: { approvedCredits: 100, settledCredits: 10, reservedCredits: 5, unknownCredits: 0, finalizationReserveCredits: 20, settlement: "pending" },
  actions: { canPause: true, canResume: false, canCancel: true, canExtendBudget: true, canApprovePlan: false, canEditPlan: false, canRevise: false, canDelete: false },
  createdAt: "", updatedAt: "", ...patch });
const scope = { runId: "run1", conversationId: "conv1", accountKey: "a" };

test("a late, older response never overwrites a newer one (late poll, second device)", () => {
  const current = view({ eventSequence: 9, status: "paused" });
  assert.equal(acceptResearchRunUpdate(current, view({ eventSequence: 8, status: "running" }), scope), current);
  assert.equal(acceptResearchRunUpdate(current, view({ eventSequence: 10, status: "running" }), scope).status, "running");
});

test("a response for another run, conversation or a malformed body is dropped", () => {
  const current = view();
  assert.equal(acceptResearchRunUpdate(current, view({ id: "run2", eventSequence: 99 }), scope), current);
  assert.equal(acceptResearchRunUpdate(current, view({ conversationId: "conv2", eventSequence: 99 }), scope), current);
  assert.equal(acceptResearchRunUpdate(current, { id: "run1" }, scope), current);
  assert.equal(acceptResearchRunUpdate(null, view({ conversationId: "conv2" }), scope), null);
});

test("progress counts real work items only; no timer percentage", () => {
  assert.deepEqual(researchProgress(view()), { done: 3, total: 6, hasCounts: true });
  assert.equal(researchProgress(view({ progress: { ...view().progress, items: { queued: 0, running: 0, completed: 0, failed: 0, attention: 0, blocked: 0, cancelled: 0 } } })).hasCounts, false);
  assert.equal(researchRunNeedsPolling(view({ status: "paused", money: { ...view().money, settlement: "settled" } })), false);
  assert.equal(researchRunNeedsPolling(view({ status: "completed" })), true, "keeps polling while settlement is pending");
  assert.equal(researchStatusKey("finalizing"), "statusFinalizing");
});

test("a lost action response is read back, never re-sent", async () => {
  const calls = [];
  const api = createResearchApi(async (path, init) => {
    calls.push(`${init?.method ?? "GET"} ${path}`);
    if (init?.method === "POST") throw new TypeError("network lost");
    return new Response(JSON.stringify({ run: view({ status: "paused", eventSequence: 7 }) }), { status: 200 });
  });
  const result = await api.act("run1", { kind: "pause" });
  assert.equal(result.readback, true);
  assert.equal(result.run.status, "paused");
  assert.deepEqual(calls, ["POST /api/chat/research/runs/run1/pause", "GET /api/chat/research/runs/run1"]);
});

test("a revision action sends the revision kind as `kind`", async () => {
  let body;
  const api = createResearchApi(async (_path, init) => { body = JSON.parse(init.body); return new Response(JSON.stringify({ run: view() })); });
  await api.act("run1", { kind: "revisions", expectedReportRevision: 1, revisionKind: "format", instruction: "shorter" });
  assert.deepEqual(body, { expectedReportRevision: 1, kind: "format", instruction: "shorter" });
});
