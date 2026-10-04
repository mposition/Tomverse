// Which claims may be counted as findings the reviewer invented.
//
// Two layers, and they fail for different reasons.
//
// `judgedScoredClaims()` is contract: the population `scoreJudgedCase()`
// scores. Anything counting a property of "the findings this reviewer put
// forward" has to read that same population, or two numbers about one record
// disagree with nothing to say which is wrong.
//
// The composition on top of it -- submitted, independent, a `finding` speech
// act, confirmed, and ruled `false_finding` -- is the proposal in
// .github/audits/ai-review-judged-metric-definitions-2026-09-09.md, and it
// lives in exactly one place: the experiment that prints it. Reading the raw
// `claims` array instead counted an explanation excluded as supporting
// material, and a quotation filed into a findings field, as inventions. Both
// are excluded in the document's own table.
//
// No provider is called.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  AI_REVIEW_SCORING_CONTRACT_VERSION,
  judgedScoredClaims,
  scoreJudgedCase,
} from "../lib/aiReviewEvalJudgement.ts";

const SIGNER = "TEST (not a person)";
const AT = "2026-09-09T00:00:00.000Z";

const claim = (over) => ({
  targetLabel: "a",
  requirementId: "fee-amount",
  assertion: "missing",
  speechAct: "finding",
  submittedAs: "contradictions",
  sourceIndex: 0,
  evidenceQuote: "a and b disagree about the fee",
  status: "confirmed",
  confirmedBy: SIGNER,
  confirmedAt: AT,
  ...over,
});

const record = (claims) => ({
  caseId: "t",
  contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
  observationRef: "sha256:0",
  reviewedBy: SIGNER,
  reviewedAt: AT,
  sourceCaseDigest: "sha256:0",
  claims,
});

test("judgedScoredClaims is the population the scorer scores", async (t) => {
  await t.test("prose is not a submitted finding", () => {
    const only = record([claim({ submittedAs: "prose", sourceIndex: null })]);
    assert.equal(judgedScoredClaims(only).length, 0);
  });

  await t.test("support beside an independent sibling drops out", () => {
    const both = record([
      claim({ requirementId: "deadline" }),
      claim({ role: "support" }),
    ]);
    const scored = judgedScoredClaims(both);
    assert.equal(scored.length, 1);
    assert.equal(scored[0].requirementId, "deadline");
  });

  await t.test("support with nothing beside it is the submission, and stays", () => {
    const alone = record([claim({ role: "support" })]);
    assert.equal(judgedScoredClaims(alone).length, 1);
  });

  await t.test("beside means the same item, not the same kind", () => {
    // A finding at index 1 does not make index 0 an explanation of it.
    const apart = record([
      claim({ requirementId: "deadline", sourceIndex: 1 }),
      claim({ role: "support", sourceIndex: 0 }),
    ]);
    assert.equal(judgedScoredClaims(apart).length, 2);
  });

  await t.test("the scorer reads it too, so the two cannot drift", () => {
    const testCase = {
      caseId: "t",
      contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
      sourceCaseDigest: "sha256:0",
      responseLabels: ["a", "b", "c"],
      requirements: [{ id: "fee-amount", description: "the fee" }],
      gold: { contradictions: [{ requirementId: "fee-amount", targetLabel: "a" }] },
      goldCompleteness: { contradictions: true },
    };
    const outcome = scoreJudgedCase(
      testCase,
      record([claim({}), claim({ requirementId: "deadline", role: "support" })])
    );
    assert.equal(outcome.scored, true);
    assert.equal(outcome.byKind.contradictions.truePositives, 1);
    assert.equal(outcome.byKind.contradictions.supportClaims, 1);
    // The support claim is neither credited nor penalised.
    assert.equal(outcome.byKind.contradictions.falsePositives, 0);
  });
});

test("the invented-finding count reads only what the reviewer put forward", () => {
  // The composition lives in the experiment, so the experiment is what is
  // read here. Duplicating the filter in this file would leave two lists to
  // disagree, which is the defect this pins.
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/experiments/ai-review-judged-metric-definitions-experiment.mjs",
    ],
    { encoding: "utf8", env: process.env }
  );
  assert.equal(result.status, 0, result.stderr);

  /** `false_finding` and the naive count, from that case's row. */
  const counts = (id) => {
    const row = new RegExp(`^  ${id}\\s+(.*)$`, "m").exec(result.stdout);
    assert.ok(row, `no row for ${id}:\n${result.stdout}`);
    const cells = row[1].trim().split(/\s+/);
    // ... 음성 심은 TP 불충분 FP goldGap falseFinding naive 제출
    return { counted: Number(cells[6]), naive: Number(cells[7]) };
  };

  // An explanation excluded as supporting material is not a finding put
  // forward, however it was ruled.
  assert.deepEqual(counts("syn-08-support-verdict"), { counted: 0, naive: 1 });
  // Nor is a quotation filed into a findings field. It is a false positive,
  // and false positives are not what this measures.
  assert.deepEqual(counts("syn-09-quotation-verdict"), { counted: 0, naive: 1 });
  // A lone support claim IS the submission, and the contract scores it.
  assert.deepEqual(counts("syn-10-lone-support"), { counted: 1, naive: 1 });
  // And the ordinary case is unchanged by any of this.
  assert.deepEqual(counts("syn-05-negative-invented"), { counted: 1, naive: 1 });
  assert.deepEqual(counts("syn-01-named"), { counted: 0, naive: 0 });
});

test("a negative case's false positives are zero because of its gold, not its phenomenon", () => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/experiments/ai-review-judged-metric-definitions-experiment.mjs",
    ],
    { encoding: "utf8", env: process.env }
  );
  assert.equal(result.status, 0, result.stderr);
  const falsePositives = (id) => {
    const row = new RegExp(`^  ${id}\\s+(.*)$`, "m").exec(result.stdout);
    assert.ok(row, `no row for ${id}`);
    return Number(row[1].trim().split(/\s+/)[4]);
  };
  // Same phenomenon, same submission, same verdict; the difference is that
  // one case declares its empty gold exhaustive and the other does not.
  assert.equal(falsePositives("syn-05-negative-invented"), 0);
  assert.equal(falsePositives("syn-11-negative-exhaustive"), 1);
});
