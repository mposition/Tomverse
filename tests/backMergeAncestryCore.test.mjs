// When an automated back-merge may keep `develop` (scripts/back-merge-ancestry-core.mjs).
//
// The dangerous answer is "yes" given too easily: keeping `develop` is `-s ours`
// by another name, and a hotfix reaches `main` first, so a wrong yes would erase
// it from every future release with nothing red. These tests pin the refusals as
// deliberately as the admissions, and the first fixture is the real conflict
// from 2026-10-03 that a person resolved by hand in #2023.

import assert from "node:assert/strict";
import test from "node:test";

import {
  ancestryMergeDecision,
  describeDecision,
  pathVerdict,
} from "../scripts/back-merge-ancestry-core.mjs";

/* ------------------------------------------------- the real 2026-10-03 case */

// package.json: develop added a script of its own on top of the one the
// selective release cherry-picked onto main, and the two additions were
// adjacent, which is why git could not merge them textually.
const PACKAGE_BASE = `{
  "scripts": {
    "report:issue-backlog": "node scripts/report-issue-backlog.mjs"
  }
}`;
const PACKAGE_MAIN = `{
  "scripts": {
    "report:check-script-inventory": "node scripts/report-check-script-inventory.mjs",
    "report:issue-backlog": "node scripts/report-issue-backlog.mjs"
  }
}`;
const PACKAGE_DEVELOP = `{
  "scripts": {
    "report:agent-policy-approval": "node scripts/report-agent-policy-approval.mjs",
    "report:check-script-inventory": "node scripts/report-check-script-inventory.mjs",
    "report:issue-backlog": "node scripts/report-issue-backlog.mjs"
  }
}`;

test("the 2026-10-03 package.json conflict is admitted", () => {
  const verdict = pathVerdict({
    path: "package.json",
    base: PACKAGE_BASE,
    theirs: PACKAGE_MAIN,
    ours: PACKAGE_DEVELOP,
  });
  assert.equal(verdict.admitted, true, verdict.reason);
});

test("the whole 2026-10-03 conflict set is admitted when the tree is develop's", () => {
  const decision = ancestryMergeDecision({
    conflicts: [
      { path: "package.json", base: PACKAGE_BASE, theirs: PACKAGE_MAIN, ours: PACKAGE_DEVELOP },
      {
        path: ".github/workflows/e2e.yml",
        base: "jobs:\n  e2e:\n    steps:\n      - run: npx playwright test\n",
        theirs: "jobs:\n  e2e:\n    steps:\n      - run: npx playwright test\n      # Shard weights\n",
        ours:
          "jobs:\n  e2e:\n    steps:\n      - name: Save the Playwright Chromium cache\n        uses: actions/cache/save@v5\n      - run: npx playwright test\n      # Shard weights\n",
      },
    ],
    treeEqualsDevelop: true,
  });
  assert.equal(decision.admitted, true, decision.reason);
  assert.match(describeDecision(decision), /Ancestry merge admitted/);
});

/* ------------------------------------------------------------- the refusals */

test("a line only main has is refused -- this is the hotfix case", () => {
  // The whole point. main carries a fix develop never received; keeping
  // develop would delete it and nothing else would notice.
  const verdict = pathVerdict({
    path: "lib/stripe.ts",
    base: "const timeout = 5000;\n",
    theirs: "const timeout = 30000;\n",
    ours: "const timeout = 5000;\nconst retries = 2;\n",
  });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.reason, /subsequence/);
  assert.deepEqual(verdict.sample, ["const timeout = 30000;"]);
});

test("a line main removed and develop still has is refused", () => {
  const verdict = pathVerdict({
    path: "lib/flags.ts",
    base: "export const legacy = true;\nexport const next = false;\n",
    theirs: "export const next = false;\n",
    ours: "export const legacy = true;\nexport const next = false;\nexport const extra = 1;\n",
  });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.reason, /resurrect/);
});

test("a path develop does not have is refused rather than deleted", () => {
  const verdict = pathVerdict({ path: "a.ts", base: "x\n", theirs: "x\ny\n", ours: null });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.reason, /would delete it/);
});

test("a path main does not have is refused rather than resurrected", () => {
  const verdict = pathVerdict({ path: "a.ts", base: "x\n", theirs: null, ours: "x\n" });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.reason, /resurrect/);
});

test("no merge base means refuse, because main's change cannot be computed", () => {
  const verdict = pathVerdict({ path: "a.ts", base: null, theirs: "x\n", ours: "x\n" });
  assert.equal(verdict.admitted, false);
  assert.match(verdict.reason, /merge base/);
});

test("one refused path refuses the whole set", () => {
  const decision = ancestryMergeDecision({
    conflicts: [
      { path: "ok.json", base: "a\n", theirs: "a\nb\n", ours: "a\nb\nc\n" },
      { path: "bad.ts", base: "a\n", theirs: "a\nonly-main\n", ours: "a\nc\n" },
    ],
    treeEqualsDevelop: true,
  });
  assert.equal(decision.admitted, false);
  assert.match(decision.reason, /1 of 2 path\(s\)/);
  assert.match(describeDecision(decision), /A person resolves this one/);
});

test("a tree that is not develop's is refused even when every path passes", () => {
  // Without this the line-set test would be the only guard, and it is not
  // strong enough alone: it ignores order, nesting and duplicate counts.
  const decision = ancestryMergeDecision({
    conflicts: [{ path: "ok.json", base: "a\n", theirs: "a\nb\n", ours: "a\nb\nc\n" }],
    treeEqualsDevelop: false,
  });
  assert.equal(decision.admitted, false);
  assert.match(decision.reason, /byte-identical/);
});

test("an unknown tree answer is refused, not assumed", () => {
  for (const treeEqualsDevelop of [undefined, null, "true", 1]) {
    const decision = ancestryMergeDecision({
      conflicts: [{ path: "ok.json", base: "a\n", theirs: "a\nb\n", ours: "a\nb\nc\n" }],
      treeEqualsDevelop,
    });
    assert.equal(decision.admitted, false, `treeEqualsDevelop=${String(treeEqualsDevelop)}`);
  }
});

test("an empty conflict set is refused, not admitted as vacuously safe", () => {
  for (const conflicts of [[], undefined, null, "package.json"]) {
    assert.equal(ancestryMergeDecision({ conflicts, treeEqualsDevelop: true }).admitted, false);
  }
});

/* ------------------------------------- the round 0 counterexamples, pinned */

test("a blank line main inserted is a line, and its loss is refused", () => {
  // Review round 0's counterexample against the first criterion, which filtered
  // whitespace: main inserts a blank line between A and B, develop inserts C
  // there. The inserts conflict, the set test saw main as adding nothing, and
  // `-X ours` still gave develop's tree -- so both guards passed while main's
  // edit was dropped, and recording main as a parent would have buried it.
  const verdict = pathVerdict({
    path: "lib/copy.ts",
    base: "const A = 1;\nconst B = 2;\n",
    theirs: "const A = 1;\n\nconst B = 2;\n",
    ours: "const A = 1;\nconst C = 3;\nconst B = 2;\n",
  });
  assert.equal(verdict.admitted, false, verdict.reason);
  assert.match(verdict.reason, /subsequence/);
});

test("a line main reordered is refused, because order is part of the change", () => {
  const verdict = pathVerdict({
    path: "lib/order.ts",
    base: "a\nb\n",
    theirs: "b\na\n",
    ours: "a\nb\nc\n",
  });
  assert.equal(verdict.admitted, false, verdict.reason);
});

test("a duplicate main added is refused when develop has only one", () => {
  const verdict = pathVerdict({
    path: "lib/dup.ts",
    base: "x\n",
    theirs: "x\nx\n",
    ours: "x\ny\n",
  });
  assert.equal(verdict.admitted, false, verdict.reason);
});

test("a duplicate main deleted is refused when develop still has both", () => {
  const verdict = pathVerdict({
    path: "lib/dup.ts",
    base: "x\nx\ny\n",
    theirs: "x\ny\n",
    ours: "x\nx\ny\nz\n",
  });
  assert.equal(verdict.admitted, false, verdict.reason);
  assert.match(verdict.reason, /resurrect/);
});
