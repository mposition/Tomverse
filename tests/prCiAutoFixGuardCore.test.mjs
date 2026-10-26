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
    // The lane may merge these when a person wrote them; the model still may not touch them.
    ["M\t.github/audits/x.md", "1\t1\t.github/audits/x.md", "gate_path"],
    ["M\teslint.config.mjs", "1\t1\teslint.config.mjs", "gate_path"],
    ["M\tapps/mobile/.npmrc", "1\t1\tapps/mobile/.npmrc", "gate_path"],
    ["M\tscripts/deep/run.mjs", "1\t1\tscripts/deep/run.mjs", "gate_path"],
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

test("only same-repository, ready develop pull requests from agent or Dependabot branches, at most twice", () => {
  const base = { headBranch: "claude/to-develop/x", baseBranch: "develop", draft: false, sameRepository: true, author: "mposition", commitMessages: ["feat: a"], commitCount: 1 };
  const bot = { headBranch: "dependabot/npm_and_yarn/develop/group-9a3125fb27", author: "dependabot[bot]" };
  assert.deepEqual(judgePrCiAutoFixTarget(base), { push: true });
  assert.deepEqual(judgePrCiAutoFixTarget({ ...base, headBranch: "codex/to-develop/y" }), { push: true });
  // Owner 2026-10-26: Dependabot's updates into develop are served too.
  assert.deepEqual(judgePrCiAutoFixTarget({ ...base, ...bot }), { push: true });
  for (const [change, reason] of [
    [{ sameRepository: false }, "fork"],
    [{ baseBranch: "main" }, "base_not_develop"],
    // A security update Dependabot opens against main stays a person's.
    [{ ...bot, headBranch: "dependabot/npm_and_yarn/next-16.4.2", baseBranch: "main" }, "base_not_develop"],
    // A person who names a branch dependabot/ does not get Dependabot's root allowance.
    [{ ...bot, author: "mposition" }, "dependabot_branch_not_by_dependabot"],
    [{ ...bot, author: "" }, "dependabot_branch_not_by_dependabot"],
    [{ draft: true }, "draft"],
    [{ headBranch: "dependabot" }, "branch_not_served"],
    [{ headBranch: "my-dependabot/x" }, "branch_not_served"],
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

test("a Dependabot fix may change the app's own build and instrumentation config at the root, and nothing else there", () => {
  const dependabot = "dependabot/npm_and_yarn/develop/infrastructure-and-observability-9a3125fb27";
  const judge = (path, headBranch) => judgePrCiAutoFixDiff({ nameStatus: `M\t${path}`, numstat: `2\t1\t${path}`, headBranch });
  for (const path of ["next.config.ts", "sentry.server.config.ts", "sentry.edge.config.ts", "sentry.client.config.ts",
    "instrumentation.ts", "instrumentation-client.ts"]) {
    assert.deepEqual(judge(path, dependabot), { push: true }, path);
    // The same file stays fenced for an agent branch, and when the caller names no branch.
    assert.deepEqual(judge(path, "claude/to-develop/x"), { push: false, reasons: ["gate_path"] }, path);
    assert.deepEqual(judge(path, undefined), { push: false, reasons: ["gate_path"] }, path);
  }
  // How the checks run, request handling, and the packages themselves stay fenced.
  for (const path of ["proxy.ts", "tsconfig.json", "eslint.config.mjs", "playwright.config.ts", "package.json",
    "package-lock.json", ".npmrc", "next.config.ts.bak", "AGENTS.md"]) {
    assert.equal(judge(path, dependabot).push, false, path);
  }
  // A rename onto an allowed name from a fenced one is still refused.
  assert.equal(judgePrCiAutoFixDiff({ nameStatus: "R100\ttsconfig.json\tnext.config.ts", numstat: "0\t0\tnext.config.ts",
    headBranch: dependabot }).push, false);
});
