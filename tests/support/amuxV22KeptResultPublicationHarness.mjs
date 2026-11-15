import assert from "node:assert/strict";
import { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// lib/amux/v22KeptResultPublication.ts against fake stores: what one round
// writes for a kept v22 result, in what order, and what it leaves alone.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const BASE = "b".repeat(40);
const DIGEST = "d".repeat(64);
let calls;
let candidates;
let switches;
let consent;
let orchestratorHalt;
let admission;
let modeAtStart;
let patch;
/** What the read under the card's lock returns; null means the same as the round's read. */
let locked;

class StoreRefused extends Error { constructor(code) { super(code); this.code = code; } }

const fakeTx = {
  $queryRaw: async (strings) => {
    const sql = strings.join("?");
    calls.push(["sql", `${/FROM "(\w+)"/.exec(sql)?.[1]} ${/FOR (SHARE|UPDATE)/.exec(sql)?.[1]}`]);
    return [];
  },
  amuxWorkItem: { updateMany: async (args) => { calls.push(["task", args]); return { count: 1 }; } },
  amuxDmOwnerSettlement: { updateMany: async (args) => { calls.push(["settlement", args]); return { count: 1 }; } },
};

mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: {
      executionRecoveryRead: { operation: "execution_recovery_read", prismaCallCeiling: 4, isolation: "read" },
      executionRecoveryWrite: { operation: "execution_recovery_write", prismaCallCeiling: 22, isolation: "mutation" },
    },
    withAmuxDbBoundary: async (boundary, work) => {
      calls.push(["boundary", boundary.operation, boundary.prismaCallCeiling]);
      return work(fakeTx, { dbNow: new Date("2026-11-15T00:00:00Z"), attachedTransaction: fakeTx });
    },
  },
});
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: {
    takeAuditChainLock: async () => { calls.push(["lock"]); },
    writeSystemAuditLog: async (entry) => { calls.push(["audit", entry]); return "audit"; },
  },
});
mock.module(mod("lib/amux/orchestratorHaltStore.ts"), {
  namedExports: { findOpenAmuxOrchestratorHalt: async () => orchestratorHalt },
});
mock.module(mod("lib/amux/v22PublicPrConsent.ts"), {
  namedExports: { readAmuxV22PublicPrConsent: async () => consent },
});
mock.module(mod("lib/amux/v22KeptResultRead.ts"), {
  namedExports: {
    readAmuxV22KeptResultCandidates: async (_tx, limit, taskId = null, skip = []) => {
      calls.push(["candidates", limit, taskId]);
      if (taskId === null) skipped.push([...skip]);
      if (taskId === null) return candidates.filter((row) => !skip.includes(row.taskId)).slice(0, limit);
      return (locked ?? candidates).filter((row) => row.taskId === taskId);
    },
  },
});
mock.module(mod("lib/engineeringAgentStore.ts"), {
  namedExports: {
    EngineeringAgentStoreRefusedError: StoreRefused,
    engineeringAgentTransactionInAmux: (lent) => lent,
    readEngineeringAgentSwitches: async () => switches,
    requireEngineeringAgentRunAdmission: async (_tx, card) => {
      calls.push(["admission", card]);
      if (admission) throw new StoreRefused(admission);
    },
    recordEngineeringAgentRunStart: async (_tx, input) => {
      calls.push(["run_start", input]);
      return { runId: input.runId, modeAtStart, leaseExpiresAt: new Date() };
    },
    endEngineeringAgentRun: async (_tx, input) => { calls.push(["run_end", input]); },
  },
});
mock.module(mod("lib/engineeringAgentV22ProductStore.ts"), {
  namedExports: {
    openEngineeringAgentV22Product: async (_tx, input) => {
      calls.push(["product", input]);
      return { id: "draft-1", kind: "t2_draft", patchDigest: input.patch.sha256, baseSha: input.patch.baseSha };
    },
  },
});
mock.module(mod("lib/engineeringAgentV22SettlementPatch.ts"), {
  // Each attempt's own stored patch: the same body, under the card that attempt ran for.
  namedExports: { loadEngineeringAgentV22SettlementPatch: async (attemptId) => patch &&
    { ...patch, taskId: candidates.find((row) => row.attemptId === attemptId)?.taskId ?? patch.taskId } },
});

const { publishAmuxV22KeptResults, AMUX_V22_KEPT_RESULT_PUBLISHED_ACTION, AMUX_V22_KEPT_RESULT_DEFER_MS } =
  await import(mod("lib/amux/v22KeptResultPublication.ts"));

// The round's clock: each scenario starts past every deferral the last one left.
let clock = Date.parse("2026-11-15T00:00:00Z");
let skipped = [];
const round = (limit) => publishAmuxV22KeptResults(limit, () => clock);

const reset = () => {
  clock += AMUX_V22_KEPT_RESULT_DEFER_MS + 1;
  skipped = [];
  calls = [];
  candidates = [{ taskId: "card", taskStatus: "review", attemptId: "attempt-3", baseSha: BASE, cardKind: "task" }];
  switches = { mode: "t1", frozen: false, claimAllowed: true, publishAllowed: true, registrationAllowed: false,
    maintenanceAllowed: true };
  consent = true;
  orchestratorHalt = null;
  admission = null;
  modeAtStart = "t1";
  locked = null;
  patch = { taskId: "card", text: "diff --git a/x b/x\n", sha256: DIGEST, baseSha: BASE };
  process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION = "enabled";
  delete process.env.ENGINEERING_AGENT_LEGACY_HALTS;
};
const kinds = () => calls.map(([kind]) => kind);

// A kept result of a card in review: the run is admitted and started for the
// attempt that produced it, the product settlement would have opened is
// opened, the run ends with its outcome, and one audit entry says so.
reset();
assert.deepEqual(await round(), [{ taskId: "card", attemptId: "attempt-3", outcome: "published" }]);
assert.deepEqual(kinds(), ["boundary", "candidates", "boundary", "sql", "lock", "sql", "candidates", "admission",
  "settlement", "run_start", "product", "run_end", "audit"]);
// A Decision Maker settlement still open for the card is cancelled: its answers include a retry.
assert.deepEqual(calls.find(([kind]) => kind === "settlement")[1],
  { where: { taskId: "card", state: "open" }, data: { state: "cancelled", cancelReason: "kept_result_published" } });
// The attempt is locked shared before the audit chain, the card after it (AMUX's lock order).
assert.deepEqual(calls.filter(([kind]) => kind === "sql").map(([, sql]) => sql),
  ["AmuxExecutionAttempt SHARE", "AmuxWorkItem UPDATE"]);
const start = calls.find(([kind]) => kind === "run_start")[1];
assert.equal(start.amuxAttemptId, "attempt-3");
assert.equal(start.cardId, "card");
assert.equal(start.baseSha, BASE);
assert.match(start.runId, /^[0-9]{12}$/);
const product = calls.find(([kind]) => kind === "product")[1];
assert.deepEqual(product, { runId: start.runId, patch: { text: patch.text, sha256: DIGEST, baseSha: BASE }, tierPending: true });
assert.deepEqual(calls.find(([kind]) => kind === "run_end")[1],
  { runId: start.runId, amuxAttemptId: "attempt-3", outcome: "t2_draft", halt: "none" });
const audit = calls.find(([kind]) => kind === "audit")[1];
assert.equal(audit.action, AMUX_V22_KEPT_RESULT_PUBLISHED_ACTION);
assert.equal(audit.metadata.fromStatus, "review");
assert.equal(audit.metadata.toStatus, "review");
assert.equal(JSON.stringify(audit.metadata).includes("diff --git"), false, "no patch text in the audit entry");
assert.equal(kinds().includes("task"), false, "a card in review stays where it is");

// A card blocked after its budget ran out goes back to review with its pull request on the way.
reset();
candidates[0].taskStatus = "blocked";
await round();
const moved = calls.find(([kind]) => kind === "task")[1];
assert.deepEqual(moved.where, { id: "card", status: "blocked", owner: null, archivedAt: null, v22AssignmentId: null });
assert.deepEqual(moved.data, { status: "review", revision: { increment: 1 } });
assert.ok(kinds().indexOf("task") > kinds().indexOf("admission") && kinds().indexOf("task") < kinds().indexOf("run_start"));

// Review r-20261115-112638-578ac8: with no public pull request consent under
// t1 the result still goes on, as the owner's T2 draft of a t1 run, which a
// person sends back to the tier round once the consent is there.
reset();
consent = false;
assert.deepEqual(await round(), [{ taskId: "card", attemptId: "attempt-3", outcome: "published" }]);
assert.equal(calls.find(([kind]) => kind === "product")[1].tierPending, false, "the owner's T2 draft");
assert.equal(calls.find(([kind]) => kind === "audit")[1].metadata.tierPending, false);

// Only shadow (review r-20261115-115151-9e04dc: a shadow run's product can
// never become a pull request), an agent that is off or frozen, a halted AMUX
// or the run's own admission keeps the result waiting, and then nothing is written.
for (const [setup, reason] of [
  [() => { switches = { ...switches, mode: "shadow", publishAllowed: false }; }, "shadow_mode"],
  [() => { switches = { ...switches, mode: "off", claimAllowed: false, publishAllowed: false }; }, "engineering_off"],
  [() => { switches = { ...switches, frozen: true, claimAllowed: false, publishAllowed: false }; }, "engineering_off"],
  [() => { orchestratorHalt = { id: "halt" }; }, "orchestrator_halted"],
  [() => { admission = "halted"; }, "run_admission_halted"],
  [() => { admission = "owner_queue_full"; }, "run_admission_owner_queue_full"],
]) {
  reset();
  setup();
  assert.deepEqual(await round(),
    [{ taskId: "card", attemptId: "attempt-3", outcome: "waiting", reason }], reason);
  for (const write of ["settlement", "task", "run_start", "product", "run_end", "audit"])
    assert.equal(kinds().includes(write), false, `${reason}: ${write}`);
}

// The card moved between the read and its lock: nothing is written.
reset();
locked = [];
assert.deepEqual(await round(), [{ taskId: "card", attemptId: "attempt-3", outcome: "moved" }]);
assert.equal(kinds().includes("run_start"), false);
// So did its stored patch: a body purged or gone is nothing to publish.
reset();
patch = null;
assert.deepEqual(await round(), [{ taskId: "card", attemptId: "attempt-3", outcome: "moved" }]);
assert.equal(kinds().includes("boundary"), true);
assert.equal(kinds().includes("run_start"), false);

// A throw after the first write fails that card's transaction (so it rolls
// back) and the round goes on to the next card.
reset();
candidates.push({ taskId: "card-2", taskStatus: "review", attemptId: "attempt-9", baseSha: BASE, cardKind: "task" });
modeAtStart = "shadow";
const mixed = await round();
assert.deepEqual(mixed.map((row) => [row.taskId, row.outcome]), [["card", "failed"], ["card-2", "failed"]]);
// Review r-20261115-110851-297f45: the oldest that keep waiting or failing
// must not take every round's turn. They are left out of the next reads, so
// the one behind them is published, and they are read again after the deferral.
modeAtStart = "t1";
candidates.push({ taskId: "card-3", taskStatus: "review", attemptId: "attempt-4", baseSha: BASE, cardKind: "task" });
const after = await round(1);
assert.deepEqual(after.map((row) => [row.taskId, row.outcome]), [["card-3", "published"]],
  "a card that keeps failing never holds the others back");
assert.deepEqual(skipped, [[], ["card", "card-2"]], "the round's reads leave out what it deferred");
admission = "halted";
clock += AMUX_V22_KEPT_RESULT_DEFER_MS + 1;
assert.deepEqual((await round(1)).map((row) => [row.taskId, row.outcome]), [["card", "waiting"]], "read again after it");
admission = null;
assert.deepEqual((await round(1)).map((row) => [row.taskId, row.outcome]), [["card-2", "published"]],
  "a waiting card is deferred as a failing one is");

// Off with the kill switch, or with v22 publication off: no read at all.
reset();
process.env.ENGINEERING_AGENT_LEGACY_HALTS = "enabled";
assert.deepEqual(await round(), []);
assert.deepEqual(calls, []);
reset();
delete process.env.TOMVERSE_AMUX_V22_ENGINEERING_PUBLICATION;
assert.deepEqual(await round(), []);
assert.deepEqual(calls, []);
