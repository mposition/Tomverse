import assert from "node:assert/strict";
import test from "node:test";

import {
  PR_CI_AUTO_FIX_COMMIT_PREFIX,
  PR_CI_AUTO_FIX_CONFLICT_PREFIX,
  judgePrCiAutoFixDiff,
  judgePrCiAutoFixTarget,
} from "../lib/prCiAutoFixGuardCore.ts";
import { judgeQaReleaseMergeLaneExclusion } from "../lib/qaReleaseMergeLaneExclusionCore.ts";

const diff = (nameStatus, numstat) => judgePrCiAutoFixDiff({ nameStatus, numstat });

test("any file but the workflows and actions is pushed: tests, deletions, scripts, policy, packages, root config", () => {
  // Owner 2026-11-03: the auto-fix fixes CI with no exception; a person still merges.
  for (const [nameStatus, numstat] of [
    ["M\tlib/foo.ts\nA\tcomponents/Bar.tsx", "3\t1\tlib/foo.ts\n10\t0\tcomponents/Bar.tsx"],
    ["M\ttests/foo.test.mjs", "1\t1\ttests/foo.test.mjs"],
    ["A\ttests/new.test.mjs", "30\t0\ttests/new.test.mjs"],
    ["M\ttests/__snapshots__/a.snap", "1\t1\ttests/__snapshots__/a.snap"],
    ["D\tlib/old.ts", "0\t9\tlib/old.ts"],
    ["R100\ttests/a.mjs\tlib/a.mjs", "0\t0\tlib/a.mjs"],
    ["M\tscripts/merge-train.mjs", "1\t1\tscripts/merge-train.mjs"],
    ["M\tdocs/policy/a.md", "1\t1\tdocs/policy/a.md"],
    ["M\tdocs/ui-contracts/a.md", "1\t1\tdocs/ui-contracts/a.md"],
    ["M\tAGENTS.md", "1\t1\tAGENTS.md"],
    ["M\tlib/adminAuth.ts", "1\t1\tlib/adminAuth.ts"],
    ["M\tlib/agentAuthorityFiles.ts", "1\t1\tlib/agentAuthorityFiles.ts"],
    ["M\tpackage.json\nM\tpackage-lock.json", "1\t1\tpackage.json\n4\t4\tpackage-lock.json"],
    ["M\teslint.config.mjs", "1\t1\teslint.config.mjs"],
    ["M\t.github/audits/x.md", "1\t1\t.github/audits/x.md"],
    ["M\tdocker/product-research-scout.Dockerfile", "1\t1\tdocker/product-research-scout.Dockerfile"],
    ["M\tlib/big.ts", "300\t200\tlib/big.ts"],
  ]) {
    assert.deepEqual(diff(nameStatus, numstat), { push: true }, nameStatus);
  }
});

test("a change to the workflows or actions, a binary or an empty diff is refused", () => {
  for (const [nameStatus, numstat, reason] of [
    ["M\t.github/workflows/x.yml", "1\t1\t.github/workflows/x.yml", "gate_path"],
    ["A\t.github/actions/setup/action.yml", "9\t0\t.github/actions/setup/action.yml", "gate_path"],
    ["D\t.github/workflows/x.yml", "0\t9\t.github/workflows/x.yml", "gate_path"],
    // A rename names both sides; either one in the workflows refuses it.
    ["R100\t.github/workflows/x.yml\tdocs/x.yml", "0\t0\tdocs/x.yml", "gate_path"],
    ["R100\tdocs/x.yml\t.github/workflows/x.yml", "0\t0\t.github/workflows/x.yml", "gate_path"],
    ["M\tpublic/logo.png", "-\t-\tpublic/logo.png", "binary"],
    ["", "", "no_change"],
  ]) {
    const verdict = diff(nameStatus, numstat);
    assert.equal(verdict.push, false, nameStatus);
    assert.ok(verdict.reasons.includes(reason), `${nameStatus}: ${verdict.reasons}`);
  }
});

test("a fix to a gate path is pushed so CI runs, and the merge lane still leaves its merge to a person", () => {
  // #3190: a Dependabot `next` bump fails until CONVENTION_VERSIONS records the installed version.
  const nameStatus = "M\tlib/agentAuthorityFiles.ts\nM\ttools/auto-rec-agent/lib/agentAuthorityFiles.generated.mjs";
  const numstat = "1\t1\tlib/agentAuthorityFiles.ts\n1\t1\ttools/auto-rec-agent/lib/agentAuthorityFiles.generated.mjs";
  assert.deepEqual(diff(nameStatus, numstat), { push: true });
  for (const headBranch of ["dependabot/npm_and_yarn/develop/user-interface-150ef438eb", "claude/to-develop/x"]) {
    assert.equal(judgeQaReleaseMergeLaneExclusion({
      headBranch, changedFiles: [{ path: "lib/agentAuthorityFiles.ts" }], changedFilesComplete: true,
      policyTestPaths: [], agentOwnPatterns: [],
    }).excluded, true, headBranch);
  }
});

test("every same-repository pull request is served, whatever its base, branch or draft state, at most twice per kind", () => {
  const base = { sameRepository: true, commitMessages: ["feat: a"], commitCount: 1 };
  assert.deepEqual(judgePrCiAutoFixTarget(base), { push: true });
  assert.deepEqual(judgePrCiAutoFixTarget({ ...base, kind: "conflict" }), { push: true });
  for (const [change, reason] of [
    [{ sameRepository: false }, "fork"],
    [{ commitMessages: [`${PR_CI_AUTO_FIX_COMMIT_PREFIX}a`, "feat: b", `${PR_CI_AUTO_FIX_COMMIT_PREFIX}c`], commitCount: 3 }, "attempts_exhausted"],
    [{ kind: "conflict", commitMessages: [`${PR_CI_AUTO_FIX_CONFLICT_PREFIX}a`, `${PR_CI_AUTO_FIX_CONFLICT_PREFIX}b`], commitCount: 2 }, "attempts_exhausted"],
    // A list cut short by paging cannot prove the attempt count.
    [{ commitMessages: ["feat: a"], commitCount: 251 }, "commits_incomplete"],
  ]) {
    const verdict = judgePrCiAutoFixTarget({ ...base, ...change });
    assert.equal(verdict.push, false, JSON.stringify(change));
    assert.ok(verdict.reasons.includes(reason));
  }
  // Each kind counts its own commits.
  assert.deepEqual(judgePrCiAutoFixTarget({ ...base, commitMessages: [`${PR_CI_AUTO_FIX_COMMIT_PREFIX}a`, `${PR_CI_AUTO_FIX_COMMIT_PREFIX}b`],
    commitCount: 2, kind: "conflict" }), { push: true });
});
