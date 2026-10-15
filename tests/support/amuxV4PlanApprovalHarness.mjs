import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let calls;
let nodePlan;
let cardPlan;
let failIn;
let commitFails;
class DecisionError extends Error { constructor(code) { super(code); this.code = code; } }
class PortfolioError extends Error { constructor(code) { super(code); this.code = code; } }

mock.module(mod("lib/prisma.ts"), {
  namedExports: { prisma: { $transaction: async (work, options) => {
    calls.push(["transaction", options.isolationLevel]);
    const result = await work("tx-1");
    if (commitFails) throw new Error("connection lost at commit");
    return result;
  } } },
});
mock.module(mod("lib/amux/ideaNodeDuplicateScanService.ts"), { namedExports: { AmuxNodeDuplicateScanError: class extends Error {} } });
mock.module(mod("lib/amux/ideaUnitDecisionStore.ts"), { namedExports: { AmuxV4UnitDecisionError: DecisionError } });
mock.module(mod("lib/amux/portfolioAssessmentService.ts"), { namedExports: { AmuxPortfolioError: PortfolioError } });
mock.module(mod("lib/amux/ideaNodePlanApprovalService.ts"), {
  namedExports: {
    prepareAmuxV4NodePlan: async (_s, _r, input, options) => { calls.push(["prepareNodes", input.ideaId, options.allowEmpty]); return { plan: nodePlan }; },
    runAmuxV4NodePlanInTx: async (tx) => { calls.push(["runNodes", tx]); if (failIn === "nodes") throw new DecisionError("reconfirm"); return nodePlan; },
  },
});
mock.module(mod("lib/amux/ideaCardPlanApprovalService.ts"), {
  namedExports: {
    prepareAmuxV4CardPlan: async (_s, _r, input, options) => {
      calls.push(["prepareCards", input.publicPrConsentOff, options.allowEmpty, [...options.pendingFeatures]]);
      return { plan: cardPlan, remaining: 0 };
    },
    runAmuxV4CardPlanInTx: async (tx) => { calls.push(["runCards", tx]); if (failIn === "cards") throw new DecisionError("reconfirm"); return cardPlan; },
    amuxV4PlanFailure: (error, returned) => (!returned && error instanceof DecisionError ? error : new DecisionError("outcome_unknown")),
  },
});
mock.module(mod("lib/amux/portfolioPlanApprovalService.ts"), {
  namedExports: {
    prepareAmuxV4ScorePlan: async (_s, _r, input, options) => { calls.push(["prepareScores", input, options.allowEmpty]); return { input }; },
    runAmuxV4ScorePlanInTx: async (tx) => { calls.push(["runScores", tx]); if (failIn === "scores") throw new PortfolioError("not_ready"); return { assessments: [1], scores: [2] }; },
  },
});

const { approveAmuxV4Plan, AmuxV4PlanError } = await import(mod("lib/amux/ideaPlanApprovalService.ts"));
const session = { user: { id: "owner-1" }, role: "owner" };
const request = new Request("https://t.test");
const reset = () => {
  calls = []; failIn = null; commitFails = false;
  nodePlan = [
    { draftUnitId: "unit-init-01", localRef: "i1", level: "initiative", nodeId: "node-i" },
    { draftUnitId: "unit-feat-01", localRef: "f1", level: "feature", nodeId: "node-f" },
  ];
  cardPlan = [{ draftUnitId: "unit-task-01", cardType: "task", cardId: "card-t" },
    { draftUnitId: "unit-story-1", cardType: "story", cardId: "card-s" }];
};
const metrics = { metrics: { value: 3 }, uncertainty: "low", evidenceRefs: ["evidence-01"], modelProposalDigest: null };
const input = (extra = {}) => ({ ideaId: "idea-0001", planRequestId: "11111111-2222-4333-8444-555555555555",
  reasons: {}, publicPrConsentOff: ["unit-task-01"],
  assessments: [{ unitId: "unit-init-01", ...metrics }, { unitId: "unit-task-01", ...metrics },
    { subject: { kind: "epic", id: "node-existing-epic" }, ...metrics }],
  scoreTaskUnitIds: ["unit-task-01"], ...extra });

// Nodes, then cards, then scores, in ONE transaction; parts are prepared first.
reset();
const approved = await approveAmuxV4Plan(session, request, input());
assert.deepEqual(calls.map(([k]) => k), ["prepareNodes", "prepareCards", "prepareScores", "transaction", "runNodes", "runCards", "runScores"]);
assert.ok(calls.filter(([k]) => k.startsWith("run")).every(([, tx]) => tx === "tx-1"));
assert.equal(approved.cards.length, 2);
// The Features this plan creates are handed to the card part by local ref.
assert.deepEqual(calls.find(([k]) => k === "prepareCards")[3], [["f1", "node-f"]]);
assert.deepEqual(calls.find(([k]) => k === "prepareCards")[1], ["unit-task-01"]);
// Assessments and scores name this plan's units by the ids made before the transaction.
const scoreInput = calls.find(([k]) => k === "prepareScores")[1];
assert.deepEqual(scoreInput.assessments.map((a) => a.subject), [
  { kind: "initiative", id: "node-i" }, { kind: "task", id: "card-t" }, { kind: "epic", id: "node-existing-epic" }]);
assert.deepEqual(scoreInput.taskIds, ["card-t"]);
assert.equal(scoreInput.planRequestId, "11111111-2222-4333-8444-555555555555");

// A refusal in any part surfaces as itself; after the callback, an unknown outcome.
for (const part of ["nodes", "cards", "scores"]) {
  reset(); failIn = part;
  await assert.rejects(approveAmuxV4Plan(session, request, input()),
    (error) => error.code === (part === "scores" ? "not_ready" : "reconfirm"));
}
reset(); commitFails = true;
await assert.rejects(approveAmuxV4Plan(session, request, input()), (error) => error.code === "outcome_unknown");

// A unit that is not in this plan, or a score for a non-Task, refuses before any transaction.
reset();
await assert.rejects(approveAmuxV4Plan(session, request, input({ scoreTaskUnitIds: ["unit-story-1"] })),
  (error) => error instanceof AmuxV4PlanError && error.code === "unit_not_in_plan");
await assert.rejects(approveAmuxV4Plan(session, request, input({ assessments: [{ unitId: "unit-nowhere", ...metrics }] })),
  (error) => error instanceof AmuxV4PlanError && error.draftUnitIds.includes("unit-nowhere"));
reset(); nodePlan = []; cardPlan = [];
await assert.rejects(approveAmuxV4Plan(session, request, input({ assessments: [], scoreTaskUnitIds: [] })),
  (error) => error instanceof AmuxV4PlanError && error.code === "nothing_to_approve");
assert.equal(calls.some(([k]) => k === "transaction"), false);
