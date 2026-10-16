import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let calls;
let proposedUnits;
let failOn;
let commitFails;
let refusalFails;
const proposals = {
  "unit-story-1": { localRef: "s1", cardType: "story", featureRef: "f1", parentStoryRef: null, dependencyRefs: [], taskRole: null, title: "Story" },
  "unit-task-01": { localRef: "t1", cardType: "task", featureRef: "f1", parentStoryRef: "s1", dependencyRefs: [], taskRole: "implement", executionGrade: "routine", expectedPaths: ["components/example.tsx"], title: "Task one" },
  "unit-task-02": { localRef: "t2", cardType: "task", featureRef: "f1", parentStoryRef: "s1", dependencyRefs: ["t1"], taskRole: "test", executionGrade: "routine", expectedPaths: ["tests/example.test.ts"], title: "Task two" },
  "unit-task-bad": { localRef: "bad", cardType: "task", featureRef: "f1", parentStoryRef: "s1", dependencyRefs: [], taskRole: "implement", executionGrade: "routine", expectedPaths: ["lib/amux/ideaUnitRegistrationCore.ts", "components/example.tsx"], title: "Mixed Task" },
};

class DecisionError extends Error { constructor(code) { super(code); this.code = code; } }

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      amuxIdeaDraftUnit: { findMany: async (args) => (args.where.unitKind === "card" ? proposedUnits : [{ id: "unit-feat-00", localRef: "f1" }]) },
      amuxIdeaUnitDecision: { findFirst: async () => ({ resolvedNodeId: "node-feature-1", linkedNodeId: null }) },
      $transaction: async (work, options) => {
        calls.push(["transaction", options.isolationLevel]);
        const result = await work("tx-1");
        if (commitFails) throw new Error("connection lost at commit");
        return result;
      },
    },
  },
});
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => true, getAdminRole: (s) => s.role } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: { assertRecentAdminAuthentication: async () => {} } });
mock.module(mod("lib/amux/ideaCardDuplicateScanService.ts"), {
  namedExports: { AmuxCardDuplicateScanError: class extends Error {},
    loadAmuxCardDuplicateScanner: async () => Object.assign(async () => ({ candidates: [] }),
      { admitCreated: async (tx, created) => { calls.push(["admit", tx, created.id]); } }) },
});
mock.module(mod("lib/amux/ideaKeyConfig.ts"), { namedExports: { loadCurrentAmuxContentKeys: () => "digest-keys" } });
mock.module(mod("lib/amux/ideaKeyStore.ts"), {
  namedExports: { createAmuxContentKeyRing: async (existing, created) => { calls.push(["keys", existing.length, created.length]); return "content-keys"; } },
});
mock.module(mod("lib/amux/ideaUnitBrowserCore.ts"), {
  namedExports: { amuxV4UnitBrowserDigest: ({ decisionId }) => ({ digest: `d:${decisionId}`, keyId: "k" }) },
});
mock.module(mod("lib/amux/ideaUnitConfirmationCore.ts"), {
  namedExports: {
    deriveAmuxIdeaUnitConfirmation: (snapshot) => ({ ok: true, confirmationDigest: `c:${snapshot.decisionId}` }),
    sameAmuxIdeaUnitConfirmation: (a, b) => a === b,
  },
});
mock.module(mod("lib/amux/v4TaskCostCatalogApprovalService.ts"), {
  namedExports: { AmuxV4TaskCatalogApprovalError: class extends Error {}, calculateCurrentApprovedAmuxV4TaskCost: async () => ({ receipt: "r" }) },
});
mock.module(mod("lib/amux/ideaUnitProposalReadService.ts"), {
  namedExports: {
    readVerifiedAmuxCardProposal: async (_session, _ideaId, unitId) => {
      const p = proposals[unitId];
      return { unit: { id: unitId, localRef: p.localRef }, proposal: p,
        previewId: "preview-0001" };
    },
  },
});
mock.module(mod("lib/amux/ideaRegistrationRefusalService.ts"), {
  namedExports: { recordAmuxV20RegistrationRefusal: async (input) => {
    if (refusalFails) throw new Error("refusal persistence failed");
    calls.push(["refusal", input.requestId, input.attemptKind, input.refusalCode,
      input.ideaId, input.draftUnitId, input.analysisPreviewId]);
    return { state: "awaiting_operator" };
  } },
});
mock.module(mod("lib/amux/ideaStoryRegistrationService.ts"), {
  namedExports: {
    prepareAmuxV4CardRegistrationInTx: async (tx, args) => {
      calls.push(["prepare", tx, args.choice.draftUnitId, args.choice.featureNodeId,
        args.choice.cardType, args.choice.publicPrDisclosureApproved, args.choice.decisionReason]);
      if (failOn === args.choice.draftUnitId) {
        throw new DecisionError("task_expected_paths_mixed");
      }
      return { result: { confirmationDigest: `c:${args.decisionId}` },
        snapshot: { decisionId: args.decisionId, duplicates: null,
          card: { cardType: args.choice.cardType, task: args.choice.cardType === "task" ? { costReceipt: "r" } : null } } };
    },
  },
});
mock.module(mod("lib/amux/ideaUnitDecisionStore.ts"), {
  namedExports: {
    AMUX_V4_UNIT_WRITE_ENV: "TOMVERSE_AMUX_V4_UNIT_WRITE",
    AmuxV4UnitDecisionError: DecisionError,
    amuxV4UnitWriteEnabled: (value) => value === "enabled",
    commitAmuxV4CardRegistration: async (tx, input) => {
      calls.push(["consume", tx, input.context.draftUnitId, input.cardId, input.keys]);
      return { decisionId: input.context.decisionId, cardId: input.cardId, auditId: "a" };
    },
  },
});

const { approveAmuxV4CardPlan } = await import(mod("lib/amux/ideaCardPlanApprovalService.ts"));
const session = { user: { id: "owner-1", authenticatedAt: "2026-10-15T00:00:00.000Z" }, role: "owner" };
const request = new Request("https://t.test");
const reset = () => {
  calls = []; failOn = null; commitFails = false; refusalFails = false;
  proposedUnits = [{ id: "unit-task-02" }, { id: "unit-task-01" }, { id: "unit-story-1" }];
  process.env.TOMVERSE_AMUX_V4_UNIT_WRITE = "enabled";
};
const run = (extra = {}) => approveAmuxV4CardPlan(session, request,
  { ideaId: "idea-0001", planRequestId: "11111111-2222-4333-8444-555555555555",
    reasons: {}, publicPrConsentOff: [], ...extra });

// Story first, then Tasks in dependency order, all in one serializable transaction.
reset();
const approved = await run({ reasons: { "unit-task-02": "Different scope" } });
assert.deepEqual(approved.cards.map((c) => c.draftUnitId), ["unit-story-1", "unit-task-01", "unit-task-02"]);
assert.equal(approved.remaining, 0);
const step = calls.filter(([k]) => ["prepare", "consume", "admit"].includes(k))
  .map(([k, tx, id]) => [k, tx, k === "admit" ? "card" : id]);
assert.deepEqual(step, [
  ["prepare", "tx-1", "unit-story-1"], ["consume", "tx-1", "unit-story-1"], ["admit", "tx-1", "card"],
  ["prepare", "tx-1", "unit-task-01"], ["consume", "tx-1", "unit-task-01"], ["admit", "tx-1", "card"],
  ["prepare", "tx-1", "unit-task-02"], ["consume", "tx-1", "unit-task-02"], ["admit", "tx-1", "card"],
]);
assert.equal(calls.filter(([k]) => k === "transaction").length, 1);
const prepares = calls.filter(([k]) => k === "prepare");
// The Feature resolves to the node its approved node unit created.
assert.ok(prepares.every((entry) => entry[3] === "node-feature-1"));
// PR consent: on for the implement Task, off for the test Task and the Story.
assert.deepEqual(prepares.map((entry) => entry[5]), [false, true, false]);
assert.equal(prepares[2][6], "Different scope");
// The admitted card is the one consumed.
const consumes = calls.filter(([k]) => k === "consume");
assert.deepEqual(calls.filter(([k]) => k === "admit").map(([, , id]) => id), consumes.map((entry) => entry[3]));
// Keys: one analysis draft per unit; title and body per card, and a brief per Task.
assert.deepEqual(calls.find(([k]) => k === "keys"), ["keys", 3, 2 + 3 + 3]);

// The owner can turn an implement Task's consent off.
reset();
await run({ publicPrConsentOff: ["unit-task-01"] });
assert.deepEqual(calls.filter(([k]) => k === "prepare").map((entry) => entry[5]), [false, false, false]);

// A refusal of any unit surfaces as itself; after the callback, an unknown outcome.
reset(); proposedUnits = [{ id: "unit-task-bad" }];
await assert.rejects(run(), (error) => error.code === "task_expected_paths_mixed");
assert.deepEqual(calls.filter(([kind]) => kind === "refusal"), [["refusal",
  "11111111-2222-4333-8444-555555555555", "whole_plan",
  "task_expected_paths_mixed", "idea-0001", "unit-task-bad", "preview-0001"]]);
assert.equal(calls.some(([kind]) => kind === "transaction"), false);
reset(); proposedUnits = [{ id: "unit-task-bad" }]; refusalFails = true;
await assert.rejects(run(), (error) => error.code === "integrity_unavailable");
reset(); failOn = "unit-task-02";
await assert.rejects(run(), (error) => error.code === "task_expected_paths_mixed");
reset(); commitFails = true;
await assert.rejects(run(), (error) => error.code === "outcome_unknown");

// Gates.
reset(); proposedUnits = [];
await assert.rejects(run(), (error) => error.code === "nothing_to_approve");
reset(); process.env.TOMVERSE_AMUX_V4_UNIT_WRITE = "disabled";
await assert.rejects(run(), (error) => error.code === "write_disabled");
reset();
await assert.rejects(approveAmuxV4CardPlan({ ...session, role: "ops" }, request,
  { ideaId: "idea-0001", planRequestId: "11111111-2222-4333-8444-555555555555",
    reasons: {}, publicPrConsentOff: [] }), (error) => error.code === "forbidden");
assert.equal(calls.some(([k]) => k === "transaction"), false);
