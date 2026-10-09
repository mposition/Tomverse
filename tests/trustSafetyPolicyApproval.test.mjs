import assert from "node:assert/strict";
import test from "node:test";

import {
  FIXED_NOTES,
  changedTheFile,
  hasToDevelopSegment,
  isBotIdentity,
  isEvilMerge,
  isPlaceholder,
  judgeAllowlistPr,
  judgeTrustSafetyPolicyApproval,
  maxApprovedVersion,
  parseVersion,
  readAllOrNothing,
  versionEntryOf,
} from "../scripts/report-trust-safety-policy-approval-core.mjs";

/**
 * The docs/policy/trust-safety-compliance-agent.md §2 judgement of the trust-safety policy, pinned against the two failures
 * that made version 2 necessary.
 *
 * Version 1 was merged and **failed its own docs/policy/trust-safety-compliance-agent.md §2**: `approvedAt` named 2026-10-05
 * while the merge was 2026-10-07 (step 5), and commit-level wording made the
 * allowlist's own genesis pull request a permanent violation (step 0). Both were
 * found by a person reading the document afterwards. These tests hold the code
 * to catching each one.
 */

/** The facts observed on develop for version 2, on 2026-10-07. */
const v2 = () => ({
  policyPath: "docs/policy/trust-safety-compliance-agent.md",
  allowlistPath: "docs/policy/agent-operator-allowlist.md",
  header: { version: "2", approvedBy: "mposition", approvedAt: "2026-10-07" },
  historyLastRowVersion: "2",
  declaredGenesisCommit: "8e3dbf64452ab75e3c6f080c8f5f531c02ace387",
  observedAllowlistGenesis: "8e3dbf64452ab75e3c6f080c8f5f531c02ace387",
  lastChangeCommit: "8a3803c5fe6cc4b4edcc2be869265609114caa7f",
  pullRequestsContainingLastChange: [{ number: 2155, base: "develop" }],
  approvalPr: {
    number: 2155,
    headRef: "policy/trust-safety-compliance-agent-v2",
    baseSha: "e77379d971ddf5fcb56b2ce925d96728eb8183c8",
    mergedBy: { login: "mposition", type: "User" },
    mergedAtIso: "2026-10-07T09:45:33Z",
    mergedAtUtcDate: "2026-10-07",
    files: ["docs/policy/trust-safety-compliance-agent.md"],
    commits: [
      {
        sha: "8a3803c5fe6cc4b4edcc2be869265609114caa7f",
        author: { name: "mposition", email: "60078951+mposition@users.noreply.github.com" },
        committer: { name: "mposition", email: "60078951+mposition@users.noreply.github.com" },
      },
    ],
  },
  policyCommitsReachableFromBase: [
    { sha: "e77379d971ddf5fcb56b2ce925d96728eb8183c8", version: "1" },
    { sha: "8a71b5b171824f3f071668645bed70ddccea834c", version: "1" },
  ],
  policyChangesAfterMerge: [],
  allowlistApproversAtBase: ["mposition"],
  approverOnAllowlistAtBase: true,
  allowlistChanges: [
    { sha: "916625d26a8bc2effd3954be9203ba2f8510d542", prNumbers: [1598], evilMerge: false },
    { sha: "8e3dbf64452ab75e3c6f080c8f5f531c02ace387", prNumbers: [1598], evilMerge: false },
  ],
  allowlistCarryingMerges: ["9cedc01f2df56a70e98fe3f7bc4cf95521c398b8"],
  genesisPrNumber: 1598,
  allowlistPrs: [
    {
      number: 1598,
      headRef: "policy/agent-operator-allowlist",
      mergedBy: { login: "mposition", type: "User" },
      mergedAtUtcDate: "2026-09-21",
      approvedAtAtMerge: "2026-09-21",
      approvedByAtMerge: "mposition",
      files: ["docs/policy/agent-operator-allowlist.md"],
      commitPrCounts: [1, 1],
      commits: [
        {
          sha: "8e3dbf64452ab75e3c6f080c8f5f531c02ace387",
          author: { name: "mposition", email: "60078951+mposition@users.noreply.github.com" },
          committer: { name: "mposition", email: "60078951+mposition@users.noreply.github.com" },
        },
        {
          sha: "916625d26a8bc2effd3954be9203ba2f8510d542",
          author: { name: "mposition", email: "60078951+mposition@users.noreply.github.com" },
          committer: { name: "mposition", email: "60078951+mposition@users.noreply.github.com" },
        },
      ],
    },
  ],
});

const stepOf = (report, id) => report.steps.find((entry) => entry.id === id);
const conditionOf = (report, id) =>
  stepOf(report, 0).conditions.find((entry) => entry.id === id);

test("the facts observed for version 2 are approved", () => {
  const report = judgeTrustSafetyPolicyApproval(v2());
  const failed = report.steps.filter((entry) => entry.met !== true);
  assert.deepEqual(failed.map((entry) => entry.id), []);
  assert.equal(report.verdict, "approved");
});

test("version 1's approvedAt would have failed step 5 before it was merged", () => {
  // The actual values: approved on 2026-10-05, merged 2026-10-07T00:12:37Z.
  const observation = v2();
  observation.header = { version: "1", approvedBy: "mposition", approvedAt: "2026-10-05" };
  observation.historyLastRowVersion = "1";
  observation.policyCommitsReachableFromBase = [];
  observation.approvalPr.mergedAtIso = "2026-10-07T00:12:37Z";
  observation.approvalPr.mergedAtUtcDate = "2026-10-07";
  const report = judgeTrustSafetyPolicyApproval(observation);
  assert.equal(stepOf(report, 5).met, false);
  assert.match(stepOf(report, 5).because, /2026-10-05.*2026-10-07/);
  assert.equal(report.verdict, "unmet");
});

test("counting an ancestry merge as a change is what failed version 1's step 0", () => {
  // Under the commit-level reading, `git log --full-history` returns the 31
  // merges that carried the genesis change across branches. Two were authored
  // by github-actions[bot], so (다) item 2 fails and step 0 can never be met.
  const observation = v2();
  observation.allowlistChanges = [
    ...observation.allowlistChanges,
    { sha: "2b30beb07bba53385774c89eed0eb12e6b29bb9c", prNumbers: [1769], evilMerge: false },
  ];
  observation.allowlistPrs = [
    ...observation.allowlistPrs,
    {
      number: 1769,
      headRef: "develop",
      mergedBy: { login: "mposition", type: "User" },
      mergedAtUtcDate: "2026-10-01",
      approvedAtAtMerge: "2026-09-21",
      approvedByAtMerge: "mposition",
      files: ["docs/policy/agent-operator-allowlist.md"],
      commitPrCounts: [1],
      baseListApprovers: ["mposition"],
      approverWasOnBaseList: true,
      baseVersion: "1",
      mergeVersion: "1",
      commits: [
        {
          sha: "2b30beb07bba53385774c89eed0eb12e6b29bb9c",
          author: { name: "github-actions[bot]", email: "github-actions[bot]@users.noreply.github.com" },
          committer: { name: "github-actions[bot]", email: "github-actions[bot]@users.noreply.github.com" },
        },
      ],
    },
  ];
  const report = judgeTrustSafetyPolicyApproval(observation);
  assert.equal(stepOf(report, 0).met, false);
  const da = conditionOf(report, "0-da");
  const bad = da.pullRequests.find((pr) => pr.number === 1769);
  assert.equal(bad.items.find((item) => item.id === 2).met, false);
  // The same pull request also fails item 7, which is the other half of version
  // 1's step 0: a change that does not raise the allowlist's version.
  assert.equal(bad.items.find((item) => item.id === 7).met, false);
});

test("the genesis pull request is exempt from exactly two items, reported as skipped", () => {
  const judgement = judgeAllowlistPr(
    { ...v2().allowlistPrs[0], allowlistPath: "docs/policy/agent-operator-allowlist.md" },
    { genesis: true },
  );
  const skipped = judgement.items.filter((item) => item.met === "skipped").map((item) => item.id);
  assert.deepEqual(skipped, [6, 7]);
  assert.equal(judgement.met, true);
  // Exemption is not a pass: the reason names (라) rather than claiming the
  // condition held.
  for (const item of judgement.items.filter((entry) => entry.met === "skipped")) {
    assert.match(item.because, /\(라\)/);
  }
});

test("a commit changed the file only when its blob differs from every parent", () => {
  const carried = { sha: "m", blob: "b1", parents: [{ sha: "p1", blob: "b0" }, { sha: "p2", blob: "b1" }] };
  assert.equal(changedTheFile(carried), false);
  assert.equal(isEvilMerge(carried), false);
  const evil = { sha: "m", blob: "b2", parents: [{ sha: "p1", blob: "b0" }, { sha: "p2", blob: "b1" }] };
  assert.equal(changedTheFile(evil), true);
  assert.equal(isEvilMerge(evil), true);
  const ordinary = { sha: "c", blob: "b1", parents: [{ sha: "p", blob: "b0" }] };
  assert.equal(changedTheFile(ordinary), true);
  assert.equal(isEvilMerge(ordinary), false);
  assert.equal(changedTheFile({ sha: "root", blob: "b0", parents: [] }), true);
  assert.equal(changedTheFile({ sha: "root", blob: undefined, parents: [] }), false);
});

test("V_max reports every commit holding it, never one", () => {
  const { value, holders } = maxApprovedVersion([
    { sha: "a", version: "1" },
    { sha: "b", version: "(미부여)" },
    { sha: "c", version: "2" },
    { sha: "d", version: "2" },
    { sha: "e", version: "1" },
  ]);
  assert.equal(value, 2);
  assert.deepEqual(holders, ["c", "d"]);
  // Nothing non-placeholder: the version must then be exactly 1.
  assert.deepEqual(maxApprovedVersion([{ sha: "a", version: "(미승인)" }]), {
    value: undefined,
    holders: [],
  });
});

test("a reverted or reused version does not exceed V_max", () => {
  const observation = v2();
  observation.header.version = "1";
  observation.historyLastRowVersion = "1";
  observation.policyCommitsReachableFromBase = [
    { sha: "a", version: "1" },
    { sha: "b", version: "2" },
  ];
  const report = judgeTrustSafetyPolicyApproval(observation);
  const increase = stepOf(report, "0a").checks.find((check) => check.id === "0a-increase");
  assert.equal(increase.met, false);
  assert.equal(increase.vMax, 2);
});

test("a version is a positive integer with no leading zero", () => {
  assert.equal(parseVersion("2"), 2);
  assert.equal(parseVersion("01"), undefined);
  assert.equal(parseVersion("1.0"), undefined);
  assert.equal(parseVersion("0"), undefined);
  assert.equal(parseVersion("(미부여)"), undefined);
  assert.equal(parseVersion(undefined), undefined);
  assert.equal(isPlaceholder("(미기록)"), true);
  assert.equal(isPlaceholder("mposition"), false);
});

test("to-develop is a path segment, not a substring", () => {
  assert.equal(hasToDevelopSegment("claude/to-develop/thing"), true);
  assert.equal(hasToDevelopSegment("to-develop"), true);
  assert.equal(hasToDevelopSegment("feature/to-development-notes"), false);
  assert.equal(hasToDevelopSegment("chore/to-develop-later"), false);
  assert.equal(hasToDevelopSegment("policy/trust-safety-compliance-agent-v2"), false);
});

test("a noreply address is not a bot, and a bot name is", () => {
  // The trap: the operator's own git email is a users.noreply address, so the
  // bot test cannot key on that domain.
  assert.equal(
    isBotIdentity({ name: "mposition", email: "60078951+mposition@users.noreply.github.com" }),
    false,
  );
  assert.equal(
    isBotIdentity({ name: "github-actions[bot]", email: "github-actions[bot]@users.noreply.github.com" }),
    true,
  );
  assert.equal(isBotIdentity({ name: "dependabot[bot]", email: "support@github.com" }), true);
  assert.equal(isBotIdentity({ name: "github-actions", email: "x@y" }), true);
});

test("four pull requests containing the commit is not one that introduced it", () => {
  // The real reading on 2026-10-07: `commits/{sha}/pulls` returned #2153, #2155,
  // #2168 and #2171 -- the merge and three open branches cut afterwards.
  const observation = v2();
  observation.pullRequestsContainingLastChange = [
    { number: 2153, base: "develop" },
    { number: 2155, base: "develop" },
    { number: 2168, base: "develop" },
    { number: 2171, base: "develop" },
  ];
  const report = judgeTrustSafetyPolicyApproval(observation);
  assert.equal(stepOf(report, 2).met, false);
  assert.match(stepOf(report, 2).because, /^4:/);
});

test("a later change to the file makes step 7 demand a re-judgement", () => {
  const observation = v2();
  observation.policyChangesAfterMerge = ["deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"];
  const report = judgeTrustSafetyPolicyApproval(observation);
  assert.equal(stepOf(report, 7).met, false);
  assert.match(stepOf(report, 7).because, /re-judge from step 0/);
});

test("a fact that cannot be read is never an approval", () => {
  for (const blank of ["approvalPr", "allowlistChanges", "policyCommitsReachableFromBase"]) {
    const observation = v2();
    delete observation[blank];
    if (blank === "approvalPr") delete observation.pullRequestsContainingLastChange;
    const report = judgeTrustSafetyPolicyApproval(observation);
    assert.notEqual(report.verdict, "approved", `${blank} missing must not be approved`);
  }
  // docs/policy/trust-safety-compliance-agent.md §2 says an unreadable merger is unmet, not unknown; the step says so in
  // its own words.
  const observation = v2();
  delete observation.approvalPr.mergedBy;
  const report = judgeTrustSafetyPolicyApproval(observation);
  assert.equal(stepOf(report, 4).met, undefined);
  assert.match(stepOf(report, 4).because, /unmet rather than unknown/);
  assert.equal(report.verdict, "unreadable");
});

test("the manifest always carries the two fixed notes", () => {
  const { manifest } = judgeTrustSafetyPolicyApproval(v2());
  assert.deepEqual(manifest.notes, [FIXED_NOTES.forcePush, FIXED_NOTES.authorship]);
  assert.match(FIXED_NOTES.forcePush, /force-push/);
  assert.match(FIXED_NOTES.authorship, /procedure, not authorship/);
});

test("the manifest never carries the two outputs docs/policy/trust-safety-compliance-agent.md §2 withdrew", () => {
  const report = judgeTrustSafetyPolicyApproval(v2());
  const text = JSON.stringify(report);
  // docs/policy/trust-safety-compliance-agent.md §2 withdrew both: the first parent's version as a comparison point, and a
  // 1-7 verdict for a V_max commit. Printing either would have the manifest
  // demand work the script does not do.
  assert.equal(/firstParent/i.test(text), false);
  assert.equal(/vMaxVerdict|vMaxSteps|vMaxJudgement/i.test(text), false);
  assert.deepEqual(report.manifest.omitted.length, 2);
  assert.match(report.manifest.omitted[0], /first parent/);
  assert.match(report.manifest.omitted[1], /V_max/);
});

test("the report writes nothing: the core takes no writer and returns data", () => {
  // The whole point of a report is that it does not edit its subject. The core
  // is pure, so this is a statement about its shape: given the same observation
  // twice it returns equal data and mutates neither.
  const observation = v2();
  const frozen = JSON.stringify(observation);
  const first = judgeTrustSafetyPolicyApproval(observation);
  const second = judgeTrustSafetyPolicyApproval(observation);
  assert.equal(JSON.stringify(observation), frozen);
  assert.deepEqual(first, second);
});

test("a past allowlist pull request is judged against its own approvedBy", () => {
  // The current policy's approver must not be substituted for a past merge's.
  // Both directions are wrong, so both are pinned.
  const base = {
    ...v2().allowlistPrs[0],
    allowlistPath: "docs/policy/agent-operator-allowlist.md",
  };

  // A different legitimate approver signs the policy today. The genesis
  // history, authored and merged by its own approver, still holds.
  const withOtherApproverToday = judgeAllowlistPr(base, { genesis: true });
  assert.equal(withOtherApproverToday.items.find((item) => item.id === 2).met, true);
  assert.equal(withOtherApproverToday.items.find((item) => item.id === 3).met, true);

  // A past merge whose allowlist named someone else, authored by today's
  // approver, must fail -- it would have passed had the current approver been
  // substituted in.
  const mismatched = judgeAllowlistPr(
    { ...base, approvedByAtMerge: "someone-else" },
    { genesis: true },
  );
  assert.equal(mismatched.items.find((item) => item.id === 2).met, false);
  assert.equal(mismatched.items.find((item) => item.id === 3).met, false);
  assert.match(mismatched.items.find((item) => item.id === 2).because, /someone-else/);

  // And an unreadable approvedBy at that merge is unreadable, not a pass.
  const unknown = judgeAllowlistPr({ ...base, approvedByAtMerge: undefined }, { genesis: true });
  assert.equal(unknown.items.find((item) => item.id === 2).met, undefined);
  assert.equal(unknown.items.find((item) => item.id === 3).met, undefined);
  assert.equal(unknown.met, undefined);
});

test("no readable commit is unmet, not vacuously true", () => {
  // An empty array passes `every()`. A pull request always has at least one
  // commit, so an empty list means the reader failed.
  const empty = judgeAllowlistPr(
    {
      ...v2().allowlistPrs[0],
      allowlistPath: "docs/policy/agent-operator-allowlist.md",
      commits: [],
    },
    { genesis: true },
  );
  assert.equal(empty.items.find((item) => item.id === 2).met, undefined);
  assert.match(empty.items.find((item) => item.id === 2).because, /vacuously true/);

  const observation = v2();
  observation.approvalPr.commits = [];
  const report = judgeTrustSafetyPolicyApproval(observation);
  assert.equal(stepOf(report, 6).met, undefined);
  assert.match(stepOf(report, 6).because, /vacuously true/);
  assert.notEqual(report.verdict, "approved");
});

test("a version it could not read leaves V_max unknown, not absent", () => {
  // Skipping an unreadable commit would let a reused number pass while a commit
  // the reader never opened held a higher one.
  const observation = v2();
  observation.header.version = "2";
  observation.policyCommitsReachableFromBase = [
    { sha: "a", version: "1" },
    { sha: "b", unreadable: true },
  ];
  const report = judgeTrustSafetyPolicyApproval(observation);
  const increase = stepOf(report, "0a").checks.find((check) => check.id === "0a-increase");
  assert.equal(increase.met, undefined);
  assert.deepEqual(increase.vMaxUnread, ["b"]);
  assert.notEqual(report.verdict, "approved");

  assert.deepEqual(maxApprovedVersion(undefined), {
    value: undefined,
    holders: [],
    unreadable: true,
  });
  const partial = maxApprovedVersion([{ sha: "a", version: "3" }, { sha: "b", unreadable: true }]);
  assert.equal(partial.unreadable, true);
  assert.equal(partial.value, undefined);
});

test("one unreadable item makes the whole list unreadable", () => {
  // The rule a review found missing from the wrapper, where filter(Boolean)
  // dropped unreadable commits and an empty result then passed every().
  const lookup = (sha) => (sha === "bad" ? undefined : { sha });
  assert.deepEqual(readAllOrNothing(["a", "b"], lookup), [{ sha: "a" }, { sha: "b" }]);
  assert.equal(readAllOrNothing(["a", "bad", "b"], lookup), undefined);
  assert.equal(readAllOrNothing(undefined, lookup), undefined);
  // An empty input is an empty list, not a failure; the judgement itself is
  // what refuses to read an empty commit list as a pass.
  assert.deepEqual(readAllOrNothing([], lookup), []);
});

test("absent and unreadable are different entries for V_max", () => {
  const versionOf = (text) => /^version: (\d+)/.exec(text ?? "")?.[1];
  assert.deepEqual(versionEntryOf("a", { state: "present", text: "version: 2" }, versionOf), {
    sha: "a",
    version: "2",
  });
  // The file had a first commit; before it there is no version, and that is an
  // ordinary fact rather than a failure.
  assert.deepEqual(versionEntryOf("b", { state: "absent" }, versionOf), {
    sha: "b",
    version: undefined,
  });
  assert.deepEqual(versionEntryOf("c", { state: "unreadable" }, versionOf), {
    sha: "c",
    unreadable: true,
  });
  assert.deepEqual(versionEntryOf("d", undefined, versionOf), { sha: "d", unreadable: true });
  // And the two must not meet the same answer downstream.
  assert.equal(maxApprovedVersion([versionEntryOf("b", { state: "absent" }, versionOf)]).unreadable, undefined);
  assert.equal(maxApprovedVersion([versionEntryOf("c", { state: "unreadable" }, versionOf)]).unreadable, true);
});

test("an unreadable policy file is not a policy with empty fields", () => {
  // This report is read as a record of what the document says, so it must not
  // say the header is blank when it could not open the file.
  const observation = v2();
  delete observation.header;
  const report = judgeTrustSafetyPolicyApproval(observation);
  const zeroA = stepOf(report, "0a");
  assert.equal(zeroA.checks.find((check) => check.id === "0a-filled").met, undefined);
  assert.match(
    zeroA.checks.find((check) => check.id === "0a-filled").because,
    /could not be read/,
  );
  assert.equal(zeroA.checks.find((check) => check.id === "0a-integer").met, undefined);
  assert.notEqual(report.verdict, "approved");
});
