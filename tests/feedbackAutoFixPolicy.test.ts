import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTOFIX_CHANGE_LIMITS,
  evaluateAutoFixChangePolicy,
  evaluateRedGreenProof,
  FORBIDDEN_ADDED_LINE_PATTERNS,
  type AutoFixChangedFile,
} from "../lib/feedbackAutoFixPolicy";

/**
 * Phase 3 change policy: what an automated fix may touch, how big it may be,
 * and what counts as a Red→Green proof. The server re-validates all of this
 * on the result endpoint, so these rules are the contract for both sides.
 */

const file = (
  path: string,
  overrides: Partial<AutoFixChangedFile> = {}
): AutoFixChangedFile => ({
  path,
  addedLines: 10,
  removedLines: 2,
  changeKind: "modified",
  ...overrides,
});

const okChange = [
  file("lib/webSearchStreamTrailer.ts"),
  file("tests/webSearchStreamTrailer.test.ts", { changeKind: "added" }),
];

test("a small fix with a test passes the policy", () => {
  const outcome = evaluateAutoFixChangePolicy(okChange);
  assert.equal(outcome.allowed, true);
});

test("a change without a new or extended test is refused", () => {
  const outcome = evaluateAutoFixChangePolicy([
    file("lib/webSearchStreamTrailer.ts"),
  ]);
  assert.equal(outcome.allowed, false);
  assert.ok(
    !outcome.allowed &&
      outcome.violations.some((entry) => entry.includes("no test"))
  );
});

test("deleting a test is refused", () => {
  const outcome = evaluateAutoFixChangePolicy([
    ...okChange,
    file("tests/feedbackPolicy.test.mjs", { changeKind: "deleted" }),
  ]);
  assert.equal(outcome.allowed, false);
});

test("file and line limits are enforced", () => {
  const tooMany = Array.from({ length: AUTOFIX_CHANGE_LIMITS.maxFiles + 1 },
    (_, index) => file(`lib/module${index}.ts`));
  assert.equal(evaluateAutoFixChangePolicy(tooMany).allowed, false);

  const tooBig = [
    file("lib/webSearchStreamTrailer.ts", { addedLines: 400 }),
    file("tests/webSearchStreamTrailer.test.ts", { changeKind: "added" }),
  ];
  assert.equal(evaluateAutoFixChangePolicy(tooBig).allowed, false);

  assert.equal(evaluateAutoFixChangePolicy([]).allowed, false);
});

test("excluded areas are refused, including the pipeline itself", () => {
  for (const path of [
    ".github/workflows/pr-fast-gate.yml",
    "prisma/schema.prisma",
    "package.json",
    "lib/chatCostGuardrails.ts",
    "lib/creditLedger.ts",
    "lib/planChangeService.ts",
    "app/api/billing/checkout/route.ts",
    "app/api/internal/feedback-autofix/result/route.ts",
    "lib/feedbackAutoFixPolicy.ts",
    "lib/errorReportToken.ts",
    "docs/policy/trace-feedback-automation.md",
    "scripts/feedback-autofix-policy-check.mjs",
    "AGENTS.md",
  ]) {
    const outcome = evaluateAutoFixChangePolicy([
      file(path),
      file("tests/some.test.ts", { changeKind: "added" }),
    ]);
    assert.equal(outcome.allowed, false, path);
  }
  // Tests for excluded modules stay allowed -- the product path does not.
  const testOnly = evaluateAutoFixChangePolicy([
    file("lib/webSearchExecutionNormalizer.ts"),
    file("tests/chatCostGuardrails.test.ts", { changeKind: "modified" }),
  ]);
  assert.equal(testOnly.allowed, true);
});

test("path traversal shapes are refused", () => {
  const outcome = evaluateAutoFixChangePolicy([
    file("../outside.ts"),
    file("tests/some.test.ts", { changeKind: "added" }),
  ]);
  assert.equal(outcome.allowed, false);
});

test("test-weakening added lines are pinned as forbidden patterns", () => {
  const weakeners = [
    "test.skip(\"x\", () => {})",
    "describe.only(\"y\", () => {})",
    "expect(value).toMatchSnapshot()",
  ];
  for (const line of weakeners) {
    assert.ok(
      FORBIDDEN_ADDED_LINE_PATTERNS.some((pattern) => pattern.test(line)),
      line
    );
  }
  assert.ok(
    !FORBIDDEN_ADDED_LINE_PATTERNS.some((pattern) =>
      pattern.test("test(\"honest test\", () => {})")
    )
  );
});

// --- Red→Green ---------------------------------------------------------------

const proof = {
  testPath: "tests/webSearchStreamTrailer.test.ts",
  baseSha: "a".repeat(40),
  headSha: "b".repeat(40),
  red: { exitCode: 1, assertionFailure: true },
  green: { exitCode: 0 },
};

test("a genuine red-then-green proof is accepted", () => {
  assert.deepEqual(evaluateRedGreenProof(proof, okChange), { proven: true });
});

test("a test that already passes on the base is not a proof", () => {
  const verdict = evaluateRedGreenProof(
    { ...proof, red: { exitCode: 0, assertionFailure: false } },
    okChange
  );
  assert.equal(verdict.proven, false);
  assert.ok(!verdict.proven && verdict.reason.includes("already passes"));
});

test("a syntax or import failure does not count as red", () => {
  const verdict = evaluateRedGreenProof(
    { ...proof, red: { exitCode: 1, assertionFailure: false } },
    okChange
  );
  assert.equal(verdict.proven, false);
  assert.ok(!verdict.proven && verdict.reason.includes("assertion"));
});

test("a still-failing green run is not a proof", () => {
  const verdict = evaluateRedGreenProof(
    { ...proof, green: { exitCode: 1 } },
    okChange
  );
  assert.equal(verdict.proven, false);
});

test("the proven test must live inside the change set, on distinct commits", () => {
  assert.equal(
    evaluateRedGreenProof(
      { ...proof, testPath: "tests/unrelated.test.ts" },
      okChange
    ).proven,
    false
  );
  assert.equal(
    evaluateRedGreenProof({ ...proof, headSha: proof.baseSha }, okChange)
      .proven,
    false
  );
  assert.equal(
    evaluateRedGreenProof(
      { ...proof, testPath: "lib/notATest.ts" },
      [...okChange, file("lib/notATest.ts")]
    ).proven,
    false
  );
});
