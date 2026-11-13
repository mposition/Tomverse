import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_DM_T2_MERGE_ENV, amuxDmT2MergeEnabled, amuxDmT2MergeGate, amuxDmT2MergePatchPaths,
  amuxDmT2MergeReadyVerdict, amuxDmT2MergeRoomBesideLine,
} from "../lib/amux/dmT2MergeCore.ts";
import { decideEngineeringAgentDmApprovedMerge, decideEngineeringAgentMergedPr } from "../lib/engineeringAgentPrApprovalCore.ts";
import { createQaReleaseMergeLaneAppPorts } from "../lib/qaReleaseMergeLaneAppClient.ts";
import {
  QA_RELEASE_MERGE_LANE_GATE_PATTERNS, judgeQaReleaseMergeLaneExclusion, qaReleaseDmApprovedHumanPaths,
  qaReleaseMergeLaneExcludingFiles,
} from "../lib/qaReleaseMergeLaneExclusionCore.ts";
import { qaReleaseDmApprovedPull, runQaReleaseMergeLaneRound } from "../lib/qaReleaseMergeLaneServiceCore.ts";

// Owner decision 2026-11-13: "develop 병합 권한은 DM에게 승인합니다. main은 안됩니다."
// The pure judgements of the Decision Maker's develop merge.

const HEAD = "a".repeat(40);
const OTHER = "f".repeat(40);
const DIFF = "d".repeat(64);
const REF = "agent/engineering/700000001";

test("the switch is off unless set to exactly enabled", () => {
  assert.equal(AMUX_DM_T2_MERGE_ENV, "TOMVERSE_AMUX_DM_T2_MERGE");
  assert.equal(amuxDmT2MergeEnabled({}), false);
  for (const value of ["true", "on", "1", "Enabled", " enabled"]) assert.equal(amuxDmT2MergeEnabled({ [AMUX_DM_T2_MERGE_ENV]: value }), false);
  assert.equal(amuxDmT2MergeEnabled({ [AMUX_DM_T2_MERGE_ENV]: "enabled" }), true);
});

test("the gate leaves every irreversible path, and every merge lane gate file, to a person", () => {
  const human = [
    "prisma/migrations/20261113200000_x/migration.sql", "prisma/schema.prisma",
    "lib/modelPricing.ts", "lib/modelPricingDb.ts", "lib/creditLedger.ts", "lib/credits/x.ts",
    "lib/billingPriceCatalog.ts", "lib/planChangeService.ts", "app/api/billing/checkout/route.ts",
    "lib/models.ts", "lib/chatCostGuardrails.ts", "lib/conversationProduct.ts", "lib/emailLogin.ts",
    "lib/adminAuth.ts", "lib/adminAuthCore.ts", "lib/auth.ts", "app/api/auth/[...nextauth]/route.ts",
    "lib/mcpConnectorSecrets.ts", "lib/adminAudit.ts", "lib/adminAuditIntegrityCore.ts",
    "lib/adminAuditSystemActors.ts", "lib/autoRouterOptimizerSystemAudit.ts", "lib/amux/auditContract.ts",
    "lib/retentionPolicyCore.ts", "lib/emailSnapshotRetention.ts", "lib/accountDeletion.ts",
    ".github/workflows/ci.yml", ".github/actions/setup/action.yml", "package.json", "tsconfig.json",
    "next.config.ts", "AGENTS.md", "CLAUDE.md", "docs/policy/qa-release-agent.md", "lib/agentAuthorityFiles.ts",
    // Case never hides one.
    "LIB/ModelPricing.ts", "Prisma/Schema.prisma",
  ];
  for (const path of human) {
    assert.deepEqual(qaReleaseDmApprovedHumanPaths([path]), [path], path);
    assert.deepEqual(amuxDmT2MergeGate([path]), { pass: false, reason: "irreversible_path", paths: [path] }, path);
  }
  // The merge lane's own gate list is all in it.
  for (const pattern of QA_RELEASE_MERGE_LANE_GATE_PATTERNS) {
    const sample = pattern.replace("/**", "/x/y.ts").replace("*", "x");
    assert.equal(qaReleaseDmApprovedHumanPaths([sample]).length, 1, pattern);
  }
  const ordinary = ["lib/amux/dmT2MergeCore.ts", "components/chat/ChatInput.tsx", "tests/x.test.mjs",
    "docs/policy/amux-decision-maker.md", "lib/engineeringAgentPrObserver.ts", "scripts/x.mjs"];
  assert.deepEqual(qaReleaseDmApprovedHumanPaths(ordinary), []);
  assert.deepEqual(amuxDmT2MergeGate(ordinary), { pass: true });
  // A path that cannot be judged, or no paths at all, goes to a person.
  assert.deepEqual(amuxDmT2MergeGate(["../etc/passwd"]).pass, false);
  assert.deepEqual(amuxDmT2MergeGate(null), { pass: false, reason: "paths_unreadable", paths: [] });
  assert.deepEqual(amuxDmT2MergeGate([]), { pass: false, reason: "paths_unreadable", paths: [] });
});

test("a patch names both sides of a rename, and a patch with no file names nothing", () => {
  const patch = [
    "diff --git a/lib/x.ts b/lib/x.ts", "@@ -1 +1 @@", "-a", "+b",
    "diff --git a/lib/old.ts b/lib/modelPricing.ts", "similarity index 90%",
  ].join("\n");
  assert.deepEqual(amuxDmT2MergePatchPaths(patch), ["lib/x.ts", "lib/old.ts", "lib/modelPricing.ts"]);
  assert.equal(amuxDmT2MergeGate(amuxDmT2MergePatchPaths(patch)).reason, "irreversible_path");
  assert.equal(amuxDmT2MergePatchPaths("no diff here"), null);
  assert.equal(amuxDmT2MergePatchPaths(null), null);
});

test("a ready pull request never jumps CI admission's line", () => {
  const room = (queue, used = 10) => amuxDmT2MergeRoomBesideLine({ queue, used, capacity: 40, need: 15 });
  assert.equal(room([]), true);
  assert.equal(room([{ draft: false, status: "running" }, { draft: true, status: "conflict" }, { draft: true, status: "behind" }]), true);
  for (const status of ["waiting", "checking", "next", "updating"]) assert.equal(room([{ draft: true, status }]), false, status);
  assert.equal(room([], 26), false, "its whole need must fit");
  assert.equal(room([], 25), true);
  assert.equal(room([], Number.NaN), false);
});

test("a pull request read fresh is marked ready only as the Decision Maker approved it", () => {
  const approved = { prNumber: 42, headRef: REF, approvedHeadSha: HEAD, approvedDiffDigest: DIFF };
  const pull = (over = {}) => ({ open: true, draft: true, base: "develop", head: REF, headSha: HEAD, ...over });
  const change = (over = {}) => ({ state: "open", baseRef: "develop", headRef: REF, headSha: HEAD, diffDigest: DIFF,
    changedFiles: ["lib/x.ts"], ...over });
  const verdict = (p = pull(), c = change()) => amuxDmT2MergeReadyVerdict({ approved, pull: p, change: c });
  assert.deepEqual(verdict(), { verdict: "ready" });
  assert.deepEqual(verdict(pull({ draft: false })), { verdict: "already_ready" });
  assert.deepEqual(verdict(null), { verdict: "skip", reason: "pull_closed" });
  assert.deepEqual(verdict(pull({ open: false })), { verdict: "skip", reason: "pull_closed" });
  assert.deepEqual(verdict(pull({ base: "main" })), { verdict: "skip", reason: "base_not_develop" });
  assert.deepEqual(verdict(pull(), change({ baseRef: "main" })), { verdict: "skip", reason: "base_not_develop" });
  assert.deepEqual(verdict(pull({ head: "agent/engineering/1" })), { verdict: "skip", reason: "branch_moved" });
  assert.deepEqual(verdict(pull({ headSha: OTHER })), { verdict: "skip", reason: "head_moved" });
  assert.deepEqual(verdict(pull(), change({ headSha: OTHER })), { verdict: "skip", reason: "head_moved" });
  // A moved head is never "already ready": nothing about it is the approved change.
  assert.deepEqual(verdict(pull({ draft: false, headSha: OTHER })), { verdict: "skip", reason: "head_moved" });
  assert.deepEqual(verdict(pull(), change({ diffDigest: null })), { verdict: "skip", reason: "diff_unreadable" });
  assert.deepEqual(verdict(pull(), change({ diffDigest: "e".repeat(64) })), { verdict: "skip", reason: "diff_changed" });
  assert.deepEqual(verdict(pull(), change({ changedFiles: null })), { verdict: "skip", reason: "paths_unreadable", paths: [] });
  assert.deepEqual(verdict(pull(), change({ changedFiles: ["lib/x.ts", "prisma/schema.prisma"] })),
    { verdict: "skip", reason: "irreversible_path", paths: ["prisma/schema.prisma"] });
  // Only the engineering agent's own branch.
  assert.equal(amuxDmT2MergeReadyVerdict({ approved: { ...approved, headRef: "claude/to-develop/x" },
    pull: pull({ head: "claude/to-develop/x" }), change: change({ headRef: "claude/to-develop/x" }) }).verdict, "skip");
});

test("the observer's second basis: the lane's own merge of exactly the approved change, into develop", () => {
  const mergedAt = new Date("2026-11-13T10:00:00Z");
  const approval = { approvedHeadSha: HEAD, approvedDiffDigest: DIFF, decidedAt: new Date("2026-11-13T09:00:00Z") };
  const judge = (over = {}) => decideEngineeringAgentDmApprovedMerge({ baseRef: "develop", headSha: HEAD,
    diffDigest: DIFF, mergedAt, mergedByKind: "bot", approval, laneMerge: "merged", ...over });
  assert.equal(judge(), "done");
  assert.equal(judge({ mergedByKind: "app" }), "done");
  assert.equal(judge({ headSha: OTHER }), "not_approved", "a head the Decision Maker did not approve");
  assert.equal(judge({ baseRef: "main" }), "not_approved", "never main");
  assert.equal(judge({ diffDigest: "e".repeat(64) }), "not_approved");
  assert.equal(judge({ approval: null }), "not_approved");
  assert.equal(judge({ approval: { ...approval, decidedAt: new Date("2026-11-13T11:00:00Z") } }), "not_approved",
    "an approval after the merge is not one");
  assert.equal(judge({ mergedByKind: "user" }), "not_approved", "a person not on the list is not the lane");
  assert.equal(judge({ mergedByKind: "unknown" }), "not_approved");
  assert.equal(judge({ laneMerge: null }), "not_approved", "a bot's merge the lane never reported is not the lane's");
  assert.equal(judge({ laneMerge: "pending" }), "waiting", "the lane's report is still to come");
  assert.equal(judge({ diffDigest: null }), "waiting", "an unread diff decides nothing");
  // The first basis is untouched: a bot's merge alone is still not approved.
  assert.equal(decideEngineeringAgentMergedPr({ merged: true, approvalRecordedBeforeMerge: false,
    mergedByApprover: false, baseRef: "develop", headVerified: true }), "merged_without_approval");
});

const inputs = (over = {}) => ({ headBranch: REF, changedFiles: [{ path: "lib/x.ts" }], changedFilesComplete: true,
  policyTestPaths: [], agentOwnPatterns: [], ...over });

test("the merge lane takes an engineering branch only on the app's report, and still leaves its human paths", () => {
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs()), { excluded: true, reasons: ["excluded_branch"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: false })), { excluded: true, reasons: ["excluded_branch"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true })), { excluded: false });
  // Only the engineering agent's own branch, never another agent prefix.
  for (const headBranch of ["agent/other/1", "agent", "marketing-agent/to-develop/x", "dependabot/npm/x", "agent/engineering/x"]) {
    assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ headBranch, dmApproved: true })).reasons, ["excluded_branch"], headBranch);
  }
  // Every other rule still holds.
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path: "lib/creditLedger.ts" }] })),
    { excluded: true, reasons: ["dm_human_path"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path: "package.json" }] })),
    { excluded: true, reasons: ["dm_human_path", "gate_path"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path: "lib/x.ts", previousPath: "prisma/schema.prisma" }] })),
    { excluded: true, reasons: ["dm_human_path"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFilesComplete: false })),
    { excluded: true, reasons: ["changed_files_incomplete"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, policyTestPaths: ["lib/x.ts"] })),
    { excluded: true, reasons: ["policy_test"] });
  // A pull request the app did not report keeps its old verdict, irreversible paths and all.
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ headBranch: "claude/to-develop/x", changedFiles: [{ path: "lib/creditLedger.ts" }] })),
    { excluded: false });
  assert.deepEqual(qaReleaseMergeLaneExcludingFiles(inputs({ dmApproved: true, changedFiles: [{ path: "lib/auth.ts" }] })),
    [{ path: "lib/auth.ts", reasons: ["dm_human_path"] }]);
});

test("the app's report counts only for the same number, head and branch, into develop", () => {
  const state = { dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] };
  const pull = (over = {}) => ({ number: 42, headRefOid: HEAD, headRefName: REF, baseRefName: "develop", ...over });
  assert.equal(qaReleaseDmApprovedPull(state, pull()), true);
  assert.equal(qaReleaseDmApprovedPull({}, pull()), false);
  for (const over of [{ number: 43 }, { headRefOid: OTHER }, { headRefName: "agent/engineering/2" }, { baseRefName: "main" }])
    assert.equal(qaReleaseDmApprovedPull(state, pull(over)), false, JSON.stringify(over));
});

test("the lane service reads the app's list strictly and drops any entry it cannot trust", async () => {
  const body = { dbNowMs: 1, latched: false, openAttempt: null, priority: [7],
    dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }, { number: 0, headSha: HEAD, headRef: REF },
      { number: 43, headSha: "x", headRef: REF }, { number: 44, headSha: HEAD, headRef: "claude/to-develop/x" }, "junk", null] };
  const env = { RAILWAY_ENVIRONMENT_NAME: "production", QA_RELEASE_MERGE_LANE_SECRET: "lane-secret",
    QA_RELEASE_CONTROL_REVISION: "3" };
  const read = (answer) => createQaReleaseMergeLaneAppPorts({ env,
    http: async () => ({ status: 200, text: JSON.stringify(answer) }) }).readState();
  const state = await read(body);
  assert.deepEqual(state.dmApproved, [{ number: 42, headSha: HEAD, headRef: REF }]);
  assert.deepEqual(state.priority, [7]);
  // No list, or none it can trust: no key at all, exactly as before.
  assert.equal("dmApproved" in await read({ dbNowMs: 1, latched: false, openAttempt: null }), false);
  assert.equal("dmApproved" in await read({ ...body, dmApproved: [{ number: 1, headSha: HEAD, headRef: "x" }] }), false);
  // Beside an open attempt too.
  const open = await read({ ...body, openAttempt: { id: "att", state: "issued", pullRequestNumber: 9, headSha: HEAD,
    mergeCommitSha: null, issuedAtMs: 1, mergeNotBeforeMs: 1 } });
  assert.deepEqual(open.dmApproved, [{ number: 42, headSha: HEAD, headRef: REF }]);
});

test("a lane round merges a reported engineering pull request and leaves an unreported one", async () => {
  const ENV = {
    QA_RELEASE_MERGE_LANE_SECRET: "s".repeat(40), QA_RELEASE_MERGE_LANE_APP_ID: "123",
    QA_RELEASE_MERGE_LANE_APP_PRIVATE_KEY: "key", QA_RELEASE_MERGE_LANE_RAILWAY_TOKEN: "token",
    QA_RELEASE_MERGE_LANE_ENABLED: "true", QA_RELEASE_MERGE_LANE_KILL_SWITCH: "", QA_RELEASE_CONTROL_REVISION: "4",
  };
  const GREEN = [{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS", workflowName: "PR Fast Gate" }];
  const pull = { number: 42, createdAt: "2026-11-13T00:00:00Z", baseRefName: "develop", headRefName: REF,
    headRefOid: HEAD, isDraft: false, mergeable: "MERGEABLE", state: "OPEN", statusCheckRollup: GREEN,
    merged: false, mergeCommitSha: null };
  const run = async (state) => {
    const issued = [];
    const ports = {
      app: {
        readState: async () => ({ dbNowMs: 1, latched: false, openAttempt: null, ...state }),
        issue: async (request) => { issued.push(request); return { issued: false, reason: "lane_off" }; },
        consume: async () => ({ consumed: false }), report: async () => ({ recorded: true }),
      },
      github: {
        listOpenDevelopPulls: async () => [pull],
        exclusionInputs: async (p) => inputs({ headBranch: p.headRefName }),
        readPull: async () => pull, merge: async () => ({ result: "refused" }), onDevelop: async () => true,
        commitsContaining: async () => new Set(), cancelledCommits: async () => new Set(),
      },
      railway: { developDeployments: async () => [] },
    };
    return { outcome: await runQaReleaseMergeLaneRound(ENV, ports), issued };
  };
  const reported = await run({ dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] });
  assert.deepEqual(reported.issued, [{ pullRequestNumber: 42, headSha: HEAD }]);
  const unreported = await run({});
  assert.deepEqual(unreported.issued, []);
  assert.equal(unreported.outcome.outcome, "idle");
  const moved = await run({ dmApproved: [{ number: 42, headSha: OTHER, headRef: REF }] });
  assert.deepEqual(moved.issued, [], "a report of another head is not this one");
});
