import assert from "node:assert/strict";
import test from "node:test";

import {
  PR_CI_AUTO_FIX_COMMIT_PREFIX,
  judgePrCiAutoFixDiff,
  judgePrCiAutoFixTarget,
} from "../lib/prCiAutoFixGuardCore.ts";

const diff = (nameStatus, numstat) => judgePrCiAutoFixDiff({ nameStatus, numstat });

test("a small edit to ordinary code is pushed", () => {
  assert.deepEqual(diff("M\tlib/foo.ts\nA\tcomponents/Bar.tsx", "3\t1\tlib/foo.ts\n10\t0\tcomponents/Bar.tsx"), { push: true });
});

test("gate paths, tests, deletions, binaries, empty and large diffs are refused", () => {
  const cases = [
    ["M\t.github/workflows/x.yml", "1\t1\t.github/workflows/x.yml", "gate_path"],
    ["M\tscripts/merge-train.mjs", "1\t1\tscripts/merge-train.mjs", "gate_path"],
    ["M\tdocs/policy/a.md", "1\t1\tdocs/policy/a.md", "gate_path"],
    ["M\tdocs/ui-contracts/a.md", "1\t1\tdocs/ui-contracts/a.md", "gate_path"],
    ["M\tdocs/release-gates/a.yaml", "1\t1\tdocs/release-gates/a.yaml", "gate_path"],
    ["M\tAGENTS.md", "1\t1\tAGENTS.md", "gate_path"],
    ["M\tlib/adminAuth.ts", "1\t1\tlib/adminAuth.ts", "gate_path"],
    ["M\tpackages/x/package.json", "1\t1\tpackages/x/package.json", "gate_path"],
    ["M\ttests/foo.test.mjs", "1\t1\ttests/foo.test.mjs", "test_file"],
    ["M\tlib/foo.spec.ts", "1\t1\tlib/foo.spec.ts", "test_file"],
    ["R100\ttests/a.mjs\tlib/a.mjs", "0\t0\tlib/a.mjs", "test_file"],
    ["D\tlib/old.ts", "0\t9\tlib/old.ts", "deletion"],
    ["M\tpublic/logo.png", "-\t-\tpublic/logo.png", "binary"],
    ["", "", "no_change"],
    ["M\tlib/big.ts", "300\t200\tlib/big.ts", "too_large"],
  ];
  for (const [nameStatus, numstat, reason] of cases) {
    const verdict = diff(nameStatus, numstat);
    assert.equal(verdict.push, false, nameStatus);
    assert.ok(verdict.reasons.includes(reason), `${nameStatus}: ${verdict.reasons}`);
  }
});

test("only same-repository, ready develop pull requests from agent branches, at most twice", () => {
  const base = { headBranch: "claude/to-develop/x", baseBranch: "develop", draft: false, sameRepository: true, commitMessages: ["feat: a"], commitCount: 1 };
  assert.deepEqual(judgePrCiAutoFixTarget(base), { push: true });
  assert.deepEqual(judgePrCiAutoFixTarget({ ...base, headBranch: "codex/to-develop/y" }), { push: true });
  for (const [change, reason] of [
    [{ sameRepository: false }, "fork"],
    [{ baseBranch: "main" }, "base_not_develop"],
    [{ draft: true }, "draft"],
    [{ headBranch: "dependabot/npm/x" }, "branch_not_served"],
    [{ headBranch: "release/2026-10-20-x" }, "branch_not_served"],
    [{ commitMessages: [`${PR_CI_AUTO_FIX_COMMIT_PREFIX}a`, "feat: b", `${PR_CI_AUTO_FIX_COMMIT_PREFIX}c`], commitCount: 3 }, "attempts_exhausted"],
    // A list cut short by paging cannot prove the attempt count.
    [{ commitMessages: ["feat: a"], commitCount: 251 }, "commits_incomplete"],
  ]) {
    const verdict = judgePrCiAutoFixTarget({ ...base, ...change });
    assert.equal(verdict.push, false, JSON.stringify(change));
    assert.ok(verdict.reasons.includes(reason));
  }
  assert.deepEqual(judgePrCiAutoFixTarget({ ...base, commitMessages: [`${PR_CI_AUTO_FIX_COMMIT_PREFIX}a`], commitCount: 1 }), { push: true });
});
