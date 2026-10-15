import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let calls;
let priors;
let failOn;
let commitFails;
class PortfolioError extends Error { constructor(code) { super(code); this.code = code; } }

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      amuxPortfolioAssessment: { findMany: async () => priors },
      $transaction: async (work, options) => {
        calls.push(["transaction", options.isolationLevel]);
        const result = await work("tx-1");
        if (commitFails) throw new Error("connection lost at commit");
        return result;
      },
    },
  },
});
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: { assertRecentAdminAuthentication: async () => {} } });
mock.module(mod("lib/amux/ideaKeyConfig.ts"), { namedExports: { loadCurrentAmuxContentKeys: () => "digest-keys" } });
mock.module(mod("lib/amux/portfolioAssessmentService.ts"), {
  namedExports: {
    AMUX_V4_PORTFOLIO_WRITE_ENV: "TOMVERSE_AMUX_V4_PORTFOLIO_WRITE",
    AmuxPortfolioError: PortfolioError,
    amuxPortfolioOwnerId: (session) => { if (session.role !== "owner") throw new PortfolioError("forbidden"); return "owner-1"; },
    amuxV4PortfolioWriteEnabled: (value) => value === "enabled",
    writeAmuxPortfolioAssessmentInTx: async (tx, input) => {
      calls.push(["assess", tx, input.payload.subject.id, input.payload.reasonCode, input.confirmationDigest,
        input.payload.evidenceAsOf]);
      if (failOn === input.payload.subject.id) throw new PortfolioError("not_ready");
      return { assessmentId: input.payload.id, assessmentVersion: 1 };
    },
  },
});
mock.module(mod("lib/amux/portfolioScoreService.ts"), {
  namedExports: {
    writeAmuxPortfolioScoreInTx: async (tx, input) => {
      calls.push(["score", tx, input.payload.taskId, input.confirmationDigest]);
      if (failOn === input.payload.taskId) throw new PortfolioError("not_ready");
      return { scoreId: input.payload.id, score: { total: 71 } };
    },
  },
});

const { approveAmuxV4ScorePlan } = await import(mod("lib/amux/portfolioPlanApprovalService.ts"));
const session = { user: { id: "owner-1" }, role: "owner" };
const request = new Request("https://t.test");
const assessment = (kind, id) => ({ subject: { kind, id }, metrics: { value: 3 }, uncertainty: "low",
  evidenceRefs: ["evidence-01"], modelProposalDigest: null });
const input = {
  assessments: [assessment("initiative", "node-init-01"), assessment("epic", "node-epic-01"),
    assessment("feature", "node-feat-01"), assessment("task", "card-task-01"), assessment("task", "card-task-02")],
  taskIds: ["card-task-01", "card-task-02"],
};
const reset = () => {
  calls = []; failOn = null; commitFails = false; priors = [{ nodeId: "node-init-01", cardId: null }];
  process.env.TOMVERSE_AMUX_V4_PORTFOLIO_WRITE = "enabled";
};

// Every assessment, then every Task score, in one serializable transaction; each subject once.
reset();
const approved = await approveAmuxV4ScorePlan(session, request, input);
assert.deepEqual(calls.filter(([k]) => k !== "transaction").map(([k, tx, id]) => [k, tx, id]), [
  ["assess", "tx-1", "node-init-01"], ["assess", "tx-1", "node-epic-01"], ["assess", "tx-1", "node-feat-01"],
  ["assess", "tx-1", "card-task-01"], ["assess", "tx-1", "card-task-02"],
  ["score", "tx-1", "card-task-01"], ["score", "tx-1", "card-task-02"],
]);
assert.equal(calls.filter(([k]) => k === "transaction").length, 1);
assert.deepEqual(approved.scores.map((s) => [s.taskId, s.total]), [["card-task-01", 71], ["card-task-02", 71]]);
// A subject assessed before is an owner override; a new one is initial. No preview digest is echoed.
const assessCalls = calls.filter(([k]) => k === "assess");
assert.deepEqual(assessCalls.map((c) => c[3]), ["operator_override", "initial", "initial", "initial", "initial"]);
assert.ok(assessCalls.every((c) => c[4] === null));
assert.ok(calls.filter(([k]) => k === "score").every((c) => c[3] === null));
// Evidence time is in the past on the server clock.
assert.ok(new Date(assessCalls[0][5]).getTime() < Date.now());

// A refusal of any one surfaces as itself; after the callback, an unknown outcome.
reset(); failOn = "card-task-02";
await assert.rejects(approveAmuxV4ScorePlan(session, request, input), (error) => error.code === "not_ready");
reset(); commitFails = true;
await assert.rejects(approveAmuxV4ScorePlan(session, request, input), (error) => error.code === "outcome_unknown");

// Gates: owner, switch, a subject twice, nothing at all.
reset();
await assert.rejects(approveAmuxV4ScorePlan({ ...session, role: "ops" }, request, input), (error) => error.code === "forbidden");
reset(); process.env.TOMVERSE_AMUX_V4_PORTFOLIO_WRITE = "disabled";
await assert.rejects(approveAmuxV4ScorePlan(session, request, input), (error) => error.code === "write_disabled");
reset();
await assert.rejects(approveAmuxV4ScorePlan(session, request, { ...input,
  assessments: [assessment("epic", "node-epic-01"), assessment("epic", "node-epic-01")] }),
(error) => error.code === "invalid_input");
await assert.rejects(approveAmuxV4ScorePlan(session, request, { assessments: [], taskIds: [] }),
  (error) => error.code === "invalid_input");
assert.equal(calls.some(([k]) => k === "transaction"), false);
