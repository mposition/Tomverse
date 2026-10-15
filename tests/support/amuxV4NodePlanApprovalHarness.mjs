import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

let calls;
let proposedUnits;
let approvedUnits;
let failOn;
let commitFails;
const proposals = {
  "unit-init-01": { localRef: "i1", level: "initiative", parentRef: null, title: "Initiative" },
  "unit-epic-01": { localRef: "e1", level: "epic", parentRef: "i1", title: "Epic" },
  "unit-feat-01": { localRef: "f1", level: "feature", parentRef: "e1", title: "Feature" },
};

class DecisionError extends Error { constructor(code) { super(code); this.code = code; } }
class DuplicateRequired extends DecisionError { constructor(ids) { super("duplicate_reason_required"); this.candidateIds = ids; } }

mock.module(mod("lib/prisma.ts"), {
  namedExports: {
    prisma: {
      amuxIdeaDraftUnit: { findMany: async (args) => (args.where.state === "proposed" ? proposedUnits : approvedUnits) },
      amuxIdeaUnitDecision: { findFirst: async () => ({ resolvedNodeId: "node-existing-epic", linkedNodeId: null }) },
      $transaction: async (work, options) => {
        calls.push(["transaction", options.isolationLevel, options.timeout]);
        const result = await work("tx-1");
        if (commitFails) throw new Error("connection lost at commit");
        return result;
      },
    },
  },
});
mock.module(mod("lib/adminAuth.ts"), { namedExports: { isAdminSession: () => true, getAdminRole: (s) => s.role } });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: { assertRecentAdminAuthentication: async () => {} } });
mock.module(mod("lib/amux/ideaNodeDuplicateScanService.ts"), {
  namedExports: { AmuxNodeDuplicateScanError: class extends Error {}, loadAmuxNodeDuplicateScanner: async () => Object.assign(async () => ({ candidates: [] }),
    { admitCreated: async (tx, created) => { calls.push(["admit", tx, created.id]); } }) },
});
mock.module(mod("lib/amux/ideaKeyConfig.ts"), { namedExports: { loadCurrentAmuxContentKeys: () => "digest-keys" } });
mock.module(mod("lib/amux/ideaKeyStore.ts"), {
  namedExports: { createAmuxContentKeyRing: async (existing, created) => { calls.push(["keys", existing.length, created.length]); return "content-keys"; } },
});
mock.module(mod("lib/amux/ideaUnitBrowserCore.ts"), {
  namedExports: { amuxV4UnitBrowserDigest: ({ decisionId, nonce }) => ({ digest: `d:${decisionId}:${nonce.length}`, keyId: "k" }) },
});
mock.module(mod("lib/amux/ideaUnitConfirmationCore.ts"), {
  namedExports: {
    deriveAmuxIdeaUnitConfirmation: (snapshot) => ({ ok: true, confirmationDigest: `c:${snapshot.decisionId}` }),
    sameAmuxIdeaUnitConfirmation: (a, b) => a === b,
  },
});
mock.module(mod("lib/amux/ideaUnitProposalReadService.ts"), {
  namedExports: {
    readVerifiedAmuxNodeProposal: async (_session, _ideaId, unitId) => {
      const p = proposals[unitId];
      return { unit: { id: unitId, localRef: p.localRef }, proposal: { level: p.level, parentRef: p.parentRef, title: p.title } };
    },
  },
});
mock.module(mod("lib/amux/ideaNodeRegistrationService.ts"), {
  namedExports: {
    prepareAmuxV4NodeCreationInTx: async (tx, args) => {
      calls.push(["prepare", tx, args.choice.draftUnitId, args.choice.parentNodeId, args.choice.decisionReason, args.nodeId]);
      if (failOn === args.choice.draftUnitId) throw new DuplicateRequired(["node-dup"]);
      return { result: { confirmationDigest: `c:${args.decisionId}` }, snapshot: { decisionId: args.decisionId, duplicates: null } };
    },
  },
});
mock.module(mod("lib/amux/ideaUnitDecisionStore.ts"), {
  namedExports: {
    AMUX_V4_UNIT_WRITE_ENV: "TOMVERSE_AMUX_V4_UNIT_WRITE",
    AmuxV4UnitDecisionError: DecisionError,
    amuxV4UnitWriteEnabled: (value) => value === "enabled",
    commitAmuxV4NodeCreation: async (tx, input) => {
      calls.push(["consume", tx, input.context.draftUnitId, input.keys, input.context.recentOwnerStepUp,
        input.consumeRequestId !== undefined]);
      return { decisionId: input.context.decisionId, nodeId: "n", auditId: "a" };
    },
  },
});

const { approveAmuxV4NodePlan } = await import(mod("lib/amux/ideaNodePlanApprovalService.ts"));
const session = { user: { id: "owner-1", authenticatedAt: "2026-10-15T00:00:00.000Z" }, role: "owner" };
const request = new Request("https://t.test");
const reset = () => {
  calls = []; failOn = null; commitFails = false;
  proposedUnits = [{ id: "unit-feat-01" }, { id: "unit-epic-01" }, { id: "unit-init-01" }];
  approvedUnits = [];
  process.env.TOMVERSE_AMUX_V4_UNIT_WRITE = "enabled";
};

// Every node is prepared then consumed in one serializable transaction, parents first.
reset();
const approved = await approveAmuxV4NodePlan(session, request, { ideaId: "idea-0001", reasons: { "unit-epic-01": "Distinct epic" } });
assert.deepEqual(approved.nodes.map((node) => node.draftUnitId), ["unit-init-01", "unit-epic-01", "unit-feat-01"]);
const steps = calls.filter(([kind]) => kind === "prepare" || kind === "consume").map(([kind, tx, unit]) => [kind, tx, unit]);
assert.deepEqual(steps, [
  ["prepare", "tx-1", "unit-init-01"], ["consume", "tx-1", "unit-init-01"],
  ["prepare", "tx-1", "unit-epic-01"], ["consume", "tx-1", "unit-epic-01"],
  ["prepare", "tx-1", "unit-feat-01"], ["consume", "tx-1", "unit-feat-01"],
]);
assert.equal(calls.filter(([kind]) => kind === "transaction").length, 1);
assert.equal(calls.find(([kind]) => kind === "transaction")[1], "Serializable");
// A child's parent is the node its parent's decision creates in this plan.
const prepares = calls.filter(([kind]) => kind === "prepare");
assert.equal(prepares[0][3], null);
assert.equal(prepares[1][3], prepares[0][5]);
assert.equal(prepares[2][3], prepares[1][5]);
assert.equal(prepares[1][4], "Distinct epic");
assert.equal(prepares[0][4], null);
// Each created node is admitted to the scanner in the same transaction, in order.
assert.deepEqual(calls.filter(([kind]) => kind === "admit").map(([, tx, id]) => [tx, id]),
  prepares.map((entry) => ["tx-1", entry[5]]));
// Content keys for every unit and node are made before the transaction.
assert.deepEqual(calls.find(([kind]) => kind === "keys"), ["keys", 3, 3]);
assert.ok(calls.findIndex(([kind]) => kind === "keys") < calls.findIndex(([kind]) => kind === "transaction"));

// A refusal of any unit surfaces as itself; the transaction carried the units before it.
reset(); failOn = "unit-epic-01";
await assert.rejects(approveAmuxV4NodePlan(session, request, { ideaId: "idea-0001", reasons: {} }),
  (error) => error.code === "duplicate_reason_required" && error.candidateIds[0] === "node-dup");

// A failure after the callback returned is an unknown outcome.
reset(); commitFails = true;
await assert.rejects(approveAmuxV4NodePlan(session, request, { ideaId: "idea-0001", reasons: {} }),
  (error) => error.code === "outcome_unknown");

// A parent approved earlier resolves to its node; nothing is re-approved.
reset(); proposedUnits = [{ id: "unit-feat-01" }];
approvedUnits = [{ id: "unit-epic-00", localRef: "e1" }];
await approveAmuxV4NodePlan(session, request, { ideaId: "idea-0001", reasons: {} });
assert.equal(calls.find(([kind]) => kind === "prepare")[3], "node-existing-epic");

// Gates: owner, write switch, something to approve, a sane reason.
reset();
await assert.rejects(approveAmuxV4NodePlan({ ...session, role: "ops" }, request, { ideaId: "idea-0001", reasons: {} }),
  (error) => error.code === "forbidden");
reset(); process.env.TOMVERSE_AMUX_V4_UNIT_WRITE = "disabled";
await assert.rejects(approveAmuxV4NodePlan(session, request, { ideaId: "idea-0001", reasons: {} }),
  (error) => error.code === "write_disabled");
reset(); proposedUnits = [];
await assert.rejects(approveAmuxV4NodePlan(session, request, { ideaId: "idea-0001", reasons: {} }),
  (error) => error.code === "nothing_to_approve");
reset();
await assert.rejects(approveAmuxV4NodePlan(session, request, { ideaId: "idea-0001", reasons: { "unit-epic-01": " x " } }),
  (error) => error.code === "reason_invalid");
assert.equal(calls.some(([kind]) => kind === "transaction"), false);
