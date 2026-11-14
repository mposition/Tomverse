import assert from "node:assert/strict";
import test from "node:test";

import {
  AMUX_DM_T2_MERGE_ENV, AMUX_DM_T2_MERGE_READY_SETTLE_MS, amuxDmT2MergeChangeVerdict, amuxDmT2MergeEnabled,
  amuxDmT2MergeGate, amuxDmT2MergeReadyInFlight,
  amuxDmT2MergePatchPaths, amuxDmT2MergeReadyVerdict, amuxDmT2MergeRoomBesideLine,
} from "../lib/amux/dmT2MergeCore.ts";
import { decideEngineeringAgentDmApprovedMerge, decideEngineeringAgentMergedPr } from "../lib/engineeringAgentPrApprovalCore.ts";
import { createQaReleaseMergeLaneAppPorts } from "../lib/qaReleaseMergeLaneAppClient.ts";
import {
  QA_RELEASE_MERGE_LANE_GATE_PATTERNS, judgeQaReleaseMergeLaneExclusion, qaReleaseDmApprovedHumanPaths,
  qaReleaseDmMergeAllowed, qaReleaseMergeLaneExcludingFiles,
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

test("only a change wholly inside the allow list takes the automatic path; anything else is a person's", () => {
  // Review r-20261113-134019-5d8f82: the three files it named, and every lib/, agent and API path.
  const human = [
    "app/api/memories/delete-all/route.ts", "lib/providerCostBudget.ts", "lib/stripePromotionProvisioning.ts",
    "lib/amux/dmT2MergeCore.ts", "lib/amux/x/y.ts", "lib/engineeringAgentPrObserver.ts", "lib/engineeringAgentStore.ts",
    "app/api/chat/route.ts", "app/api/x/page.tsx", "lib/ordinary.ts", "packages/x/index.ts", "types/x.d.ts",
    "prisma/migrations/20261113200000_x/migration.sql", "prisma/schema.prisma", "scripts/x.mjs", "middleware.ts",
    // Inside the allow list and still a person's.
    "docs/policy/amux-decision-maker.md", "docs/ui-contracts/typography.md", "docs/agents/agents-reference.md",
    "tests/agentAuthorityFiles.test.mjs", "tests/engineeringAgentStore.test.mjs", "tests/amuxDmT2MergeCore.test.mjs",
    "tests/billingPolicy.test.mjs", "tests/mobileComposerInvariant.test.mjs", "tests/fooContract.test.ts",
    "components/admin/AdminShell.tsx", "app/(site)/(application)/admin/page.tsx",
    "app/(site)/x/route.ts", "app/(site)/x/actions.ts", "app/globals.css",
    // The lane's own gate files, whatever list they sit beside.
    "package.json", ".github/workflows/ci.yml", "AGENTS.md",
    // Case never slips one through.
    "Tests/x.test.mjs", "Components/X.tsx", "DOCS/POLICY/x.md",
  ];
  for (const path of human) {
    assert.equal(qaReleaseDmMergeAllowed(path), false, path);
    assert.deepEqual(amuxDmT2MergeGate([path]), { pass: false, reason: "outside_dm_merge_allowlist", paths: [path] }, path);
  }
  // The lane's gate files are all a person's.
  for (const pattern of QA_RELEASE_MERGE_LANE_GATE_PATTERNS) {
    const sample = pattern.replace("/**", "/x/y.ts").replaceAll("*", "x");
    assert.equal(qaReleaseDmApprovedHumanPaths([sample]).length, 1, pattern);
  }
  // A test the policy documents name, when the caller read them.
  assert.equal(qaReleaseDmMergeAllowed("tests/chatComposer.test.mjs", ["tests/chatComposer.test.mjs"]), false);
  const allowed = ["tests/chatComposer.test.mjs", "tests/server-contract/chat-route.test.ts", "docs/guides/x.md",
    "docs/ops/x.md", "locales/en.ts", "locales/ko.ts", "components/chat/MessageBubble.tsx",
    "app/(site)/(application)/chat/page.tsx", "app/(site)/layout.tsx", "app/(site)/x/loading.tsx",
    "app/(site)/x/error.tsx"];
  for (const path of allowed) assert.equal(qaReleaseDmMergeAllowed(path), true, path);
  assert.deepEqual(qaReleaseDmApprovedHumanPaths(allowed), []);
  assert.deepEqual(amuxDmT2MergeGate(allowed), { pass: true }, "tests, docs, locales and components only");
  // One path outside leaves the whole change to a person.
  assert.deepEqual(amuxDmT2MergeGate([...allowed, "lib/providerCostBudget.ts"]),
    { pass: false, reason: "outside_dm_merge_allowlist", paths: ["lib/providerCostBudget.ts"] });
  // A path that cannot be judged, or no paths at all, goes to a person.
  assert.deepEqual(amuxDmT2MergeGate(["../etc/passwd"]).pass, false);
  assert.deepEqual(amuxDmT2MergeGate(null), { pass: false, reason: "paths_unreadable", paths: [] });
  assert.deepEqual(amuxDmT2MergeGate([]), { pass: false, reason: "paths_unreadable", paths: [] });
});

test("a patch names both sides of a rename, and a patch with no file names nothing", () => {
  const patch = [
    "diff --git a/components/X.tsx b/components/X.tsx", "@@ -1 +1 @@", "-a", "+b",
    "diff --git a/components/Old.tsx b/lib/modelPricing.ts", "similarity index 90%",
  ].join("\n");
  assert.deepEqual(amuxDmT2MergePatchPaths(patch), ["components/X.tsx", "components/Old.tsx", "lib/modelPricing.ts"]);
  assert.equal(amuxDmT2MergeGate(amuxDmT2MergePatchPaths(patch)).reason, "outside_dm_merge_allowlist");
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
  const pull = (over = {}) => ({ open: true, draft: true, base: "develop", head: REF, headSha: HEAD, fork: false, ...over });
  const change = (over = {}) => ({ state: "open", baseRef: "develop", headRef: REF, headSha: HEAD, diffDigest: DIFF,
    crossRepository: false,
    changedFiles: ["components/X.tsx"], ...over });
  const verdict = (p = pull(), c = change()) => amuxDmT2MergeReadyVerdict({ approved, pull: p, change: c });
  assert.deepEqual(verdict(), { verdict: "ready" });
  assert.deepEqual(verdict(pull({ draft: false })), { verdict: "already_ready" });
  assert.deepEqual(verdict(null), { verdict: "skip", reason: "pull_closed" });
  assert.deepEqual(verdict(pull({ open: false })), { verdict: "skip", reason: "pull_closed" });
  // A fork's pull request never takes the automatic path, as CI admission or the engineering token reads it.
  assert.deepEqual(verdict(pull({ fork: true })), { verdict: "skip", reason: "fork_pr" });
  assert.deepEqual(verdict(pull({ fork: true, draft: false })), { verdict: "skip", reason: "fork_pr" });
  assert.deepEqual(verdict(pull(), change({ crossRepository: true })), { verdict: "skip", reason: "fork_pr" });
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ crossRepository: true }) }),
    { holds: false, reason: "fork_pr" });
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ crossRepository: undefined }) }),
    { holds: false, reason: "fork_pr" }, "unread is a fork");
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
  assert.deepEqual(verdict(pull(), change({ changedFiles: ["components/X.tsx", "prisma/schema.prisma"] })),
    { verdict: "skip", reason: "outside_dm_merge_allowlist", paths: ["prisma/schema.prisma"] });
  // The change alone, as the lane's list reads it: the approved digest holds, any other or none does not.
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change() }), { holds: true });
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ diffDigest: "e".repeat(64) }) }),
    { holds: false, reason: "diff_changed" });
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ diffDigest: null }) }),
    { holds: false, reason: "diff_unreadable" });
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ changedFiles: ["lib/providerCostBudget.ts"] }) }),
    { holds: false, reason: "outside_dm_merge_allowlist", paths: ["lib/providerCostBudget.ts"] });
  assert.deepEqual(amuxDmT2MergeChangeVerdict({ approved, change: change({ state: "closed" }) }),
    { holds: false, reason: "pull_closed" });
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

const inputs = (over = {}) => ({ headBranch: REF, changedFiles: [{ path: "components/X.tsx" }], changedFilesComplete: true,
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
  for (const path of ["lib/creditLedger.ts", "lib/providerCostBudget.ts", "lib/stripePromotionProvisioning.ts",
    "app/api/memories/delete-all/route.ts", "lib/amux/x.ts", "lib/engineeringAgentStore.ts", "lib/ordinary.ts"]) {
    assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path }] })),
      { excluded: true, reasons: ["dm_outside_allowlist"] }, path);
  }
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path: "package.json" }] })),
    { excluded: true, reasons: ["dm_outside_allowlist", "gate_path"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path: "components/X.tsx", previousPath: "lib/x.ts" }] })),
    { excluded: true, reasons: ["dm_outside_allowlist"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path: "tests/x.test.mjs" },
    { path: "docs/guides/x.md" }, { path: "locales/en.ts" }, { path: "components/X.tsx" }] })), { excluded: false });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFilesComplete: false })),
    { excluded: true, reasons: ["changed_files_incomplete"] });
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ dmApproved: true, changedFiles: [{ path: "tests/x.test.mjs" }],
    policyTestPaths: ["tests/x.test.mjs"] })), { excluded: true, reasons: ["dm_outside_allowlist", "policy_test"] });
  // A pull request the app did not report keeps its old verdict, irreversible paths and all.
  assert.deepEqual(judgeQaReleaseMergeLaneExclusion(inputs({ headBranch: "claude/to-develop/x", changedFiles: [{ path: "lib/creditLedger.ts" }] })),
    { excluded: false });
  assert.deepEqual(qaReleaseMergeLaneExcludingFiles(inputs({ dmApproved: true, changedFiles: [{ path: "lib/auth.ts" }] })),
    [{ path: "lib/auth.ts", reasons: ["dm_outside_allowlist"] }]);
});

test("the app's report counts only for the same number, head and branch, into develop", () => {
  const state = { dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] };
  const pull = (over = {}) => ({ number: 42, headRefOid: HEAD, headRefName: REF, baseRefName: "develop",
    isCrossRepository: false, ...over });
  assert.equal(qaReleaseDmApprovedPull(state, pull()), true);
  assert.equal(qaReleaseDmApprovedPull({}, pull()), false);
  for (const over of [{ number: 43 }, { headRefOid: OTHER }, { headRefName: "agent/engineering/2" }, { baseRefName: "main" },
    { isCrossRepository: true }, { isCrossRepository: undefined }])
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
  const pull = { number: 42, createdAt: "2026-11-13T00:00:00Z", baseRefName: "develop", headRefName: REF, isCrossRepository: false,
    headRefOid: HEAD, isDraft: false, mergeable: "MERGEABLE", state: "OPEN", statusCheckRollup: GREEN,
    merged: false, mergeCommitSha: null };
  const run = async (state, answers = {}) => {
    const issued = [];
    const merges = [];
    const order = [];
    const consumes = [];
    const ports = {
      app: {
        readState: async () => ({ dbNowMs: 1, latched: false, openAttempt: null, ...state }),
        issue: async (request) => { issued.push(request); return answers.issue ?? { issued: false, reason: "lane_off" }; },
        consume: async (request) => { order.push("consume"); consumes.push(request); return answers.consume ?? { consumed: false }; },
        report: async () => ({ recorded: true }),
      },
      github: {
        listOpenDevelopPulls: async () => [pull],
        exclusionInputs: async (p) => inputs({ headBranch: p.headRefName }),
        readPull: async () => pull,
        diffDigest: async () => { order.push("diff"); return "diffDigest" in answers ? answers.diffDigest : DIFF; },
        merge: async (number, headSha) => { order.push("merge"); merges.push([number, headSha]); return { result: "merged", sha: "9".repeat(40) }; },
        onDevelop: async () => true,
        commitsContaining: async () => new Set(), cancelledCommits: async () => new Set(),
      },
      railway: { developDeployments: async () => [] },
    };
    return { outcome: await runQaReleaseMergeLaneRound(ENV, ports), issued, merges, order, consumes };
  };
  const reported = await run({ dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] });
  assert.deepEqual(reported.issued, [{ pullRequestNumber: 42, headSha: HEAD }]);
  const unreported = await run({});
  assert.deepEqual(unreported.issued, []);
  assert.equal(unreported.outcome.outcome, "idle");
  const moved = await run({ dmApproved: [{ number: 42, headSha: OTHER, headRef: REF }] });
  assert.deepEqual(moved.issued, [], "a report of another head is not this one");
  // Merged, the call pins the approved head: a head that moved since is refused by GitHub.
  const merged = await run({ dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] },
    { issue: { issued: true, attemptId: "att-1" }, consume: { consumed: true } });
  assert.deepEqual(merged.merges, [[42, HEAD]]);
  // Review r-20261114-021949-8dbd49: the diff as GitHub serves it now is read right before the consume and carried in it.
  assert.deepEqual(merged.order, ["diff", "consume", "merge"]);
  assert.equal(merged.consumes[0].diffDigest, DIFF);
  // Its diff unread: no consume, no merge.
  const unread = await run({ dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] },
    { issue: { issued: true, attemptId: "att-1" }, consume: { consumed: true }, diffDigest: null });
  assert.deepEqual([unread.order, unread.merges], [["diff"], []]);
  // The app refuses the consume (its Decision Maker approval no longer holds): never merged without it.
  const refused = await run({ dmApproved: [{ number: 42, headSha: HEAD, headRef: REF }] },
    { issue: { issued: true, attemptId: "att-1" }, consume: { consumed: false, reason: "dm_approval_not_holding" } });
  assert.deepEqual(refused.issued, [{ pullRequestNumber: 42, headSha: HEAD }]);
  assert.deepEqual(refused.merges, [], "no merge call without the app's consume");
});

test("a Decision Maker ready is a person's: while an earlier one's CI has not shown, the next waits, for ten minutes at most", () => {
  const NOW = Date.parse("2026-11-13T10:00:00Z");
  const ready = { prNumber: 42, headSha: HEAD, atMs: NOW - 60_000 };
  // Its CI not on GitHub yet: the next ready waits, so at most one pull request's CI can overflow.
  assert.equal(amuxDmT2MergeReadyInFlight({ readies: [ready], running: new Set(), nowMs: NOW }), true);
  // Its run shows (queued or in progress at that head): counted as running, the hold is off.
  assert.equal(amuxDmT2MergeReadyInFlight({ readies: [ready], running: new Set([`42@${HEAD}`]), nowMs: NOW }), false);
  // A run of another head is not its CI.
  assert.equal(amuxDmT2MergeReadyInFlight({ readies: [ready], running: new Set([`42@${OTHER}`]), nowMs: NOW }), true);
  // Ten minutes after the ready with no run: the hold is off.
  assert.equal(AMUX_DM_T2_MERGE_READY_SETTLE_MS, 10 * 60 * 1000);
  assert.equal(amuxDmT2MergeReadyInFlight({ readies: [{ ...ready, atMs: NOW - AMUX_DM_T2_MERGE_READY_SETTLE_MS }],
    running: new Set(), nowMs: NOW }), false);
  assert.equal(amuxDmT2MergeReadyInFlight({ readies: [], running: new Set(), nowMs: NOW }), false);
});

test("the engineering agent and the merge lane digest a diff with one function", async () => {
  const { readFileSync } = await import("node:fs");
  const { createHash } = await import("node:crypto");
  const { pullDiffDigest, PULL_DIFF_DIGEST_MAX_BYTES } = await import("../lib/pullDiffDigestCore.ts");
  const diff = "diff --git a/components/X.tsx b/components/X.tsx\n@@ -1 +1 @@\n-a\n+b\n";
  assert.equal(pullDiffDigest(diff), createHash("sha256").update(Buffer.from(diff, "utf8")).digest("hex"));
  assert.equal(pullDiffDigest(Buffer.from(diff, "utf8")), pullDiffDigest(diff), "the bytes and their text agree");
  assert.equal(PULL_DIFF_DIGEST_MAX_BYTES, 1024 * 1024);
  for (const file of ["lib/engineeringAgentGitHubRead.ts", "lib/qaReleaseMergeLaneGithub.ts"]) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
    assert.match(source, /import \{ PULL_DIFF_DIGEST_MAX_BYTES, pullDiffDigest \} from "\.\/pullDiffDigestCore\.ts";/, file);
  }
});

test("a diff with bytes that are not UTF-8 digests the same in the engineering read and in the merge lane", async () => {
  // Review r-20261114-023008-48bc7e: both sides digest the response's own bytes.
  const { createHash } = await import("node:crypto");
  const { pullDiffDigest } = await import("../lib/pullDiffDigestCore.ts");
  const { createQaReleaseGithubPorts } = await import("../lib/qaReleaseMergeLaneGithub.ts");
  const { readEngineeringAgentPullChange, ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV } =
    await import("../lib/engineeringAgentGitHubRead.ts");
  const raw = Buffer.concat([Buffer.from("diff --git a/components/X.tsx b/components/X.tsx\n@@ -1 +1 @@\n-caf"),
    Buffer.from([0xe9, 0xff, 0xfe]), Buffer.from("\n+cafe\n")]);
  const expected = createHash("sha256").update(raw).digest("hex");
  assert.notEqual(expected, pullDiffDigest(new TextDecoder().decode(raw)), "its text would digest otherwise");

  // The lane, through the service's own way of answering: the bytes beside their text.
  const lane = createQaReleaseGithubPorts({ token: async () => "t", http: async (request) => {
    assert.equal(request.headers.accept, "application/vnd.github.diff");
    return { status: 200, text: new TextDecoder().decode(raw), bytes: new Uint8Array(raw) };
  } });
  assert.equal(await lane.diffDigest(42), expected);
  // An answer without its bytes gives no digest, so the pull request is not merged on one.
  const textOnly = createQaReleaseGithubPorts({ token: async () => "t",
    http: async () => ({ status: 200, text: new TextDecoder().decode(raw) }) });
  assert.equal(await textOnly.diffDigest(42), null);
  const tooBig = createQaReleaseGithubPorts({ token: async () => "t",
    http: async () => ({ status: 200, text: "", bytes: new Uint8Array(1024 * 1024 + 1) }) });
  assert.equal(await tooBig.diffDigest(42), null);

  // The engineering agent's read of the same pull request.
  const HEAD_SHA = "c".repeat(40);
  const BASE_SHA = "b".repeat(40);
  const pull = { number: 42, state: "open", changed_files: 1,
    base: { ref: "develop", sha: BASE_SHA, repo: { full_name: "mposition/Tomverse" } },
    head: { ref: "agent/engineering/1", sha: HEAD_SHA, repo: { full_name: "mposition/Tomverse" } } };
  const fetchImpl = async (url, init) => {
    const path = String(url).replace("https://api.github.com/repos/mposition/Tomverse", "");
    if (path === "/pulls/42" && init.headers.Accept === "application/vnd.github.diff") return new Response(raw, { status: 200 });
    if (path === "/pulls/42") return new Response(JSON.stringify(pull), { status: 200 });
    if (path.startsWith("/pulls/42/files")) {
      return new Response(JSON.stringify([{ filename: "components/X.tsx", status: "modified" }]), { status: 200 });
    }
    return new Response("{}", { status: 404 });
  };
  const change = await readEngineeringAgentPullChange(42, { env: { [ENGINEERING_AGENT_GITHUB_READ_TOKEN_ENV]: "t" }, fetchImpl });
  assert.equal(change.diffDigest, expected);
  assert.equal(change.crossRepository, false);
  assert.deepEqual(change.changedFiles, ["components/X.tsx"]);
});
