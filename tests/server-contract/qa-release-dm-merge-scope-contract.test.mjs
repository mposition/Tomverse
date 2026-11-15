import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// The Decision Maker's develop merge through the app's three uses of an
// approval -- the ready step, the merge lane's list and the lane's consume --
// in each merge scope (owner decisions 2026-11-13 and 2026-11-15): by default
// a reviewed lib/ and app/api/ change goes from approval through ready to the
// lane without a person; TOMVERSE_AMUX_DM_MERGE_SCOPE=allowlist on the app
// puts every use back on the allow list of 2026-11-13; main never.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;

const HEAD = "c".repeat(40);
const DIFF = "d".repeat(64);
const REF = "agent/engineering/700000042";
const ON = { TOMVERSE_AMUX_DM_T2_MERGE: "enabled" };
const KILL = { ...ON, TOMVERSE_AMUX_DM_MERGE_SCOPE: "allowlist" };

const patchOf = (path, added = "const limit = 12;") =>
  [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, "@@ -1 +1 @@", "-const limit = 10;", `+${added}`, ""].join("\n");
const CODE = ["lib/conversationSearch.ts", "app/api/conversations/search/route.ts"];
const CODE_PATCH = CODE.map((path) => patchOf(path)).join("");

let approvals = [];
let audits = [];
let visits = [];

const fakeTx = {
  $executeRaw: async (_strings, ...values) => { visits.push(values[0]); return 1; },
  adminAuditLog: { findMany: async () => [] },
};

mock.module(mod("lib/amux/dbBoundary.ts"), {
  namedExports: {
    AMUX_DB_BOUNDARIES: {
      dmT2MergeLaneRead: { operation: "dm_t2_merge_lane_read" },
      dmT2MergeReadyPick: { operation: "dm_t2_merge_ready_pick" },
      dmT2MergeReadyRecord: { operation: "dm_t2_merge_ready_record" },
      dmT2MergeObservedRead: { operation: "dm_t2_merge_observed_read" },
    },
    withAmuxDbBoundary: async (_boundary, work) => work(fakeTx, { dbNow: new Date() }),
  },
});
mock.module(mod("lib/amux/decisionMakerSwitchStore.ts"), {
  namedExports: {
    readDecisionMakerSwitches: async () => ({ killSwitch: false }),
    readDecisionMakerSwitchesOrThrow: async () => ({ killSwitch: false }),
  },
});
mock.module(mod("lib/amux/dmT2MergeRead.ts"), {
  namedExports: {
    readAmuxDmT2MergeApprovals: async (_tx, input) => approvals
      .filter((row) => !input.prNumbers || input.prNumbers.includes(row.prNumber))
      .filter((row) => !input.settlementId || row.settlementId === input.settlementId)
      .slice(0, input.limit).map((row) => ({ ...row })),
    readAmuxDmT2MergeObservedFacts: async () => null,
    readAmuxDmT2MergeIsEngineeringPull: async () => true,
  },
});
mock.module(mod("lib/adminAudit.ts"), {
  namedExports: {
    takeAuditChainLock: async () => {},
    writeSystemAuditLog: async (entry) => { audits.push(entry.action); return "audit"; },
  },
});
mock.module(mod("lib/engineeringAgentGitHubRead.ts"), {
  namedExports: { readEngineeringAgentPullChange: async () => { throw new Error("live read"); } },
});

const { amuxDmT2MergeConsumeAllowed, readAmuxDmT2MergeLanePulls, runAmuxDmT2MergeReadyStep } =
  await import(mod("lib/amux/dmT2MergeService.ts"));

const approval = (patchBody, over = {}) => ({
  settlementId: "s-1", taskId: "t-1", attemptId: "a-1", bindingId: "b-1", prNumber: 42, headRef: REF,
  approvedHeadSha: HEAD, approvedDiffDigest: DIFF, decidedAt: new Date(), patchBody, ...over,
});
const changeOf = (files, over = {}) => async () => ({ state: "open", baseRef: "develop", headRef: REF, headSha: HEAD,
  diffDigest: DIFF, changedFiles: files, crossRepository: false, ...over });
const reset = (patchBody, over = {}) => { approvals = [approval(patchBody, over)]; audits = []; visits = []; };

test("the merge lane hears of a reviewed lib/ and app/api/ change by default, and not with the kill switch on", async () => {
  reset(CODE_PATCH);
  assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: changeOf(CODE) }), [{ number: 42, headSha: HEAD, headRef: REF }]);
  reset(CODE_PATCH);
  assert.deepEqual(await readAmuxDmT2MergeLanePulls(KILL, { change: changeOf(CODE) }), [], "kill switch: the allow list");
  // What the allow list took, the kill switch still takes.
  reset(patchOf("components/X.tsx"));
  assert.deepEqual((await readAmuxDmT2MergeLanePulls(KILL, { change: changeOf(["components/X.tsx"]) })).length, 1);
  // A block list path in the change, or an alarm in the stored patch's lines: not listed, and its turn is used.
  reset(CODE_PATCH);
  assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: changeOf([...CODE, "lib/creditLedger.ts"]) }), []);
  assert.deepEqual(visits, ["s-1"], "visited, so it never hides the approvals behind it");
  reset(patchOf("lib/conversationSearch.ts", 'const on = process.env.NEW_PAID_CALL !== "off";'));
  assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: changeOf(["lib/conversationSearch.ts"]) }), []);
  reset(null);
  assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: changeOf(CODE) }), [], "no stored patch to judge");
  // Never main.
  reset(CODE_PATCH);
  assert.deepEqual(await readAmuxDmT2MergeLanePulls(ON, { change: changeOf(CODE, { baseRef: "main" }) }), []);
  // The develop merge switch off: nothing at all, whatever the scope.
  reset(CODE_PATCH);
  assert.deepEqual(await readAmuxDmT2MergeLanePulls({}, { change: changeOf(CODE) }), []);
});

test("the lane's consume holds a reviewed code change by default, and the allow list with the kill switch on", async () => {
  const consume = (env, over = {}) => amuxDmT2MergeConsumeAllowed(fakeTx, { prNumber: 42, headSha: HEAD, base: "develop",
    diffDigest: DIFF, env, ...over });
  reset(CODE_PATCH);
  assert.equal(await consume(ON), "allowed");
  assert.equal(await consume(KILL), "dm_approval_not_holding", "kill switch: the lane's own path check is the block list's");
  assert.equal(await consume(ON, { base: "main" }), "dm_approval_not_holding", "never main");
  assert.equal(await consume(ON, { diffDigest: "e".repeat(64) }), "dm_diff_changed");
  assert.equal(await consume(ON, { headSha: "a".repeat(40) }), "dm_approval_not_holding");
  reset(patchOf("lib/conversationSearch.ts", "await tx.message.deleteMany({ where });"));
  assert.equal(await consume(ON), "dm_approval_not_holding");
  reset(patchOf("lib/creditLedger.ts"));
  assert.equal(await consume(ON), "dm_approval_not_holding");
  reset(patchOf("components/X.tsx"));
  assert.equal(await consume(KILL), "allowed", "what the allow list took, as before");
  assert.equal(await consume({}), "dm_approval_not_holding", "the develop merge switch off");
});

test("a reviewed code change is marked ready by the app without a person, audited first; never with the kill switch on", async () => {
  const draft = { number: 42, head: REF, headSha: HEAD, base: "develop", draft: true, fork: false, labels: [] };
  const ready = async (env, files = CODE, pullOver = {}, freshOver = {}) => {
    const written = [];
    const ports = {
      pull: async () => ({ pull: { ...draft, nodeId: "PR_x", title: "x", ...pullOver, ...freshOver }, open: true }),
      change: changeOf(files),
      markReady: async (pull) => { written.push(pull.number); },
    };
    const outcome = await runAmuxDmT2MergeReadyStep({ drafts: [{ ...draft, ...pullOver }], room: true, running: new Set(),
      ports, env, nowMs: Date.parse("2026-11-15T00:00:00Z") });
    return { outcome, written };
  };
  reset(CODE_PATCH);
  const marked = await ready(ON);
  assert.equal(marked.outcome.outcome, "marked_ready");
  assert.deepEqual(marked.written, [42]);
  assert.deepEqual(audits, ["amux.dm_t2_merge.ready_requested"], "the chain audit before the write");
  reset(CODE_PATCH);
  const killed = await ready(KILL);
  assert.deepEqual([killed.outcome.outcome, killed.outcome.reason, killed.written, audits], ["skipped", "outside_dm_merge_allowlist", [], []]);
  reset(patchOf("lib/conversationSearch.ts", "creditWeight: 3,"));
  const valued = await ready(ON, ["lib/conversationSearch.ts"]);
  assert.deepEqual([valued.outcome.outcome, valued.written], ["skipped", []], "a value AGENTS.md reserves for a person");
  reset(CODE_PATCH);
  const intoMain = await ready(ON, CODE, { base: "main" });
  assert.deepEqual(intoMain.written, [], "never main");
  // A person's ci:hold stands, whether it was on the listed draft or appeared on the fresh read.
  reset(CODE_PATCH);
  const held = await ready(ON, CODE, { labels: ["ci:hold"] });
  assert.deepEqual([held.outcome.outcome, held.written], ["none", []]);
  reset(CODE_PATCH);
  const heldLate = await ready(ON, CODE, {}, { labels: ["ci:hold"] });
  assert.deepEqual([heldLate.outcome.outcome, heldLate.outcome.reason, heldLate.written, audits], ["skipped", "ci_hold", [], []]);
});
