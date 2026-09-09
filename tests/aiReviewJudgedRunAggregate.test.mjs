// Run-level aggregation of judged AI Review cases.
//
// The metric definitions this implements were approved on 2026-09-09
// (.github/audits/ai-review-judged-metric-definitions-2026-09-09.md). What
// these cover is the two halves that can each be right while the other is
// wrong: whether a run may be aggregated at all, and what the numbers are
// once it may.
//
// The first half is where every defect in the earlier prototype lived -- a
// duplicated plan row counted twice, a plan joined to evidence by a caller's
// label, a deleted record vanishing instead of blocking. Each of those is a
// case here, because each of them passed once.
//
// No provider is called.

import assert from "node:assert/strict";
import test from "node:test";

import {
  AI_REVIEW_SCORING_CONTRACT_VERSION,
  buildScoringArtifact,
  judgedSourceCaseDigest,
  observationRefFor,
} from "../lib/aiReviewEvalJudgement.ts";
import { aggregateJudgedRun } from "../lib/aiReviewJudgedRunAggregate.ts";

const SIGNER = "TEST (not a person)";
const AT = "2026-09-09T00:00:00.000Z";
const REQ = "deadline";

/**
 * One case, built end to end so the aggregator sees what a real run gives it.
 *
 * `submissions` are the reviewer's findings fields; `claims` are the
 * judgements about them, with the boilerplate filled in.
 */
const buildCase = ({
  id,
  phenomenon = "omission",
  gold = { missingPoints: [{ requirementId: REQ, targetLabel: "c" }] },
  goldCompleteness = { missingPoints: true },
  submissions = {},
  claims = [],
  answer = "cc",
}) => {
  const sourceCase = {
    id,
    question: `[TEST] ${id}`,
    responses: [
      { label: "a", content: "aa" },
      { label: "b", content: "bb" },
      { label: "c", content: answer },
    ],
  };
  const findings = {
    contradictions: submissions.contradictions ?? [],
    missingPoints: submissions.missingPoints ?? [],
    differences: submissions.differences ?? [],
  };
  const allText = [
    ...findings.contradictions,
    ...findings.missingPoints,
    ...findings.differences,
  ].join("\n");
  const observation = {
    findings,
    allText,
    reviewerProse: allText,
    totalQuotes: 0,
    matchedQuotes: 0,
    schemaValid: true,
  };
  const testCase = {
    caseId: id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    sourceCaseDigest: judgedSourceCaseDigest(sourceCase),
    responseLabels: ["a", "b", "c"],
    requirements: [
      { id: REQ, description: "the deadline" },
      { id: "fee-amount", description: "the fee" },
    ],
    gold,
    goldCompleteness,
  };
  const record = {
    caseId: id,
    contractVersion: AI_REVIEW_SCORING_CONTRACT_VERSION,
    observationRef: observationRefFor(observation),
    reviewedBy: SIGNER,
    reviewedAt: AT,
    sourceCaseDigest: testCase.sourceCaseDigest,
    claims: claims.map((claim) => ({
      assertion: "missing",
      speechAct: "finding",
      ...claim,
      evidenceQuote: findings[claim.submittedAs][claim.sourceIndex],
      status: "confirmed",
      confirmedBy: SIGNER,
      confirmedAt: AT,
    })),
  };
  const artifact = buildScoringArtifact({ testCase, record, observation, scoredAt: AT });
  return {
    entry: { testCase, observation, record, artifact },
    plan: { caseId: id, observationRef: record.observationRef },
    journal: { caseId: id, observation },
    datasetCase: { ...sourceCase, phenomenon },
  };
};

/** The reviewer names the planted requirement. */
const found = (id, over = {}) =>
  buildCase({
    id,
    submissions: { missingPoints: [`[TEST] ${id}: c omits the deadline`] },
    claims: [
      { submittedAs: "missingPoints", sourceIndex: 0, targetLabel: "c", requirementId: REQ },
    ],
    ...over,
  });

/** The reviewer says nothing at all. */
const silent = (id, over = {}) => buildCase({ id, ...over });

const run = (built, over = {}) => {
  const plan = over.plan ?? built.map((item) => item.plan);
  const entries = over.entries ?? built.map((item) => item.entry);
  return aggregateJudgedRun({
    plan,
    entries,
    runInputs: {
      journal: over.journal ?? built.map((item) => item.journal),
      dataset: over.dataset ?? { cases: built.map((item) => item.datasetCase) },
    },
  });
};

// ---------------------------------------------------------------------------
// Aggregability
// ---------------------------------------------------------------------------

test("a run is refused before any number exists", async (t) => {
  await t.test("a plan row repeated is refused, not deduplicated", () => {
    const built = [found("dup")];
    const result = run(built, { plan: [built[0].plan, built[0].plan] });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /lists this case and output twice/);
  });

  await t.test("no plan and no evidence are different refusals", () => {
    const empty = aggregateJudgedRun({
      plan: [],
      entries: [],
      runInputs: { journal: [], dataset: { cases: [] } },
    });
    assert.equal(empty.aggregable, false);
    assert.match(empty.blockers.join("\n"), /planned no cases/);
    assert.doesNotMatch(empty.blockers.join("\n"), /nothing in it was judged/);

    const built = [found("planned")];
    const unjudged = run(built, { entries: [] });
    assert.equal(unjudged.aggregable, false);
    assert.match(unjudged.blockers.join("\n"), /nothing in it was judged/);
  });

  await t.test("a deleted record blocks the run rather than shrinking it", () => {
    // Three planned, two judged. The prototype aggregated the two.
    const built = [found("a1"), found("a2"), found("a3")];
    const result = run(built, { entries: built.slice(0, 2).map((item) => item.entry) });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /a3: planned in the run and never judged/);
  });

  await t.test("evidence with no plan row is a blocker too", () => {
    const built = [found("b1"), found("b2")];
    const result = run(built, { plan: [built[0].plan] });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /b2: judged, but the run's plan has no such/);
  });

  await t.test("identity comes from the artifact, not the plan's label", () => {
    // The plan says `c1`; the bundle handed over is `c2`'s, untouched and
    // internally sound. Joining on the caller's label passed this.
    const one = found("c1");
    const two = found("c2");
    const result = run([one], { entries: [two.entry] });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /c1: planned in the run and never judged/);
  });

  await t.test("ineligible evidence blocks: a refusal is not a result", () => {
    const built = [found("d1")];
    // Move the text under the judgement. The artifact stays sound about
    // files that no longer describe the dataset.
    const moved = {
      ...built[0].datasetCase,
      responses: built[0].datasetCase.responses.map((response) =>
        response.label === "c" ? { ...response, content: "moved" } : response
      ),
    };
    const result = run(built, { dataset: { cases: [moved] } });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /d1: /);
  });

  await t.test("the run's journal and dataset are required, not optional", () => {
    const built = [found("e1")];
    const result = aggregateJudgedRun({
      plan: built.map((item) => item.plan),
      entries: built.map((item) => item.entry),
      runInputs: { journal: undefined, dataset: undefined },
    });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /checked against each other and against no run/);
  });

  await t.test("a case with no known phenomenon blocks both denominators", () => {
    const built = [found("f1")];
    const nameless = { ...built[0].datasetCase };
    delete nameless.phenomenon;
    const missing = run(built, { dataset: { cases: [nameless] } });
    assert.equal(missing.aggregable, false);
    assert.match(missing.blockers.join("\n"), /does not give this case a known phenomenon/);

    const wrong = run(built, {
      dataset: { cases: [{ ...built[0].datasetCase, phenomenon: "vibes" }] },
    });
    assert.equal(wrong.aggregable, false);
    assert.match(wrong.blockers.join("\n"), /known phenomenon/);
  });
});

// ---------------------------------------------------------------------------
// missedEveryPlantedIssueRate  (A1)
// ---------------------------------------------------------------------------

test("missedEveryPlantedIssueRate counts cases where nothing planted was reported", async (t) => {
  await t.test("found is not missed; silent is", () => {
    const result = run([found("g1"), silent("g2")]);
    assert.equal(result.aggregable, true);
    const metric = result.metrics.missedEveryPlantedIssueRate;
    assert.equal(metric.numerator, 1);
    assert.equal(metric.denominator, 2);
    assert.equal(metric.rate, 0.5);
  });

  await t.test("an insufficient finding is not a report, and is flagged", () => {
    const vague = buildCase({
      id: "g3",
      submissions: { missingPoints: ["[TEST] c's procedural advice feels thin"] },
      claims: [
        {
          submittedAs: "missingPoints",
          sourceIndex: 0,
          targetLabel: "c",
          requirementId: REQ,
          sufficiency: "insufficient",
        },
      ],
    });
    const result = run([vague]);
    assert.equal(result.aggregable, true);
    assert.equal(result.metrics.missedEveryPlantedIssueRate.numerator, 1);
    // And the diagnostic keeps "aimed and named nothing" distinguishable from
    // "said nothing at all".
    assert.equal(result.metrics.missedEveryPlantedIssueAimedAt, 1);
  });

  await t.test("a negative case and a case with nothing planted are out of the denominator", () => {
    const built = [
      silent("g4", { phenomenon: "no_issue", gold: {}, goldCompleteness: {} }),
      silent("g5", { gold: {}, goldCompleteness: {} }),
    ];
    const result = run(built);
    assert.equal(result.aggregable, true);
    const metric = result.metrics.missedEveryPlantedIssueRate;
    assert.equal(metric.denominator, 0);
    // Not 0%. Nothing here measures it.
    assert.equal(metric.rate, null);
    assert.equal(metric.wilsonUpper, null);
    assert.match(metric.insufficientEvidence, /denominator is zero/);
  });
});

// ---------------------------------------------------------------------------
// inventedFindingRate  (B2)
// ---------------------------------------------------------------------------

/** A case whose reviewer reports something the gold does not contain. */
const invents = (id, extra = {}, over = {}) =>
  buildCase({
    id,
    submissions: {
      missingPoints: [`[TEST] ${id}: c omits the deadline`],
      contradictions: [`[TEST] ${id}: a and b disagree about the fee`],
    },
    claims: [
      { submittedAs: "missingPoints", sourceIndex: 0, targetLabel: "c", requirementId: REQ },
      {
        submittedAs: "contradictions",
        sourceIndex: 0,
        targetLabel: "a",
        requirementId: "fee-amount",
        outsideGoldVerdict: "false_finding",
        ...extra,
      },
    ],
    ...over,
  });

test("inventedFindingRate counts cases carrying a finding judged invented", async (t) => {
  await t.test("the denominator is every scored case, not only the negative ones", () => {
    const result = run([invents("h1"), found("h2")]);
    assert.equal(result.aggregable, true);
    const metric = result.metrics.inventedFindingRate;
    assert.equal(metric.numerator, 1);
    assert.equal(metric.denominator, 2);
  });

  await t.test("a case counts once however many it invented", () => {
    const many = buildCase({
      id: "h3",
      submissions: {
        contradictions: ["[TEST] one", "[TEST] two", "[TEST] three"],
      },
      claims: [0, 1, 2].map((index) => ({
        submittedAs: "contradictions",
        sourceIndex: index,
        targetLabel: "a",
        requirementId: `made-up-${index}`,
        outsideGoldVerdict: "false_finding",
      })),
    });
    const result = run([many]);
    assert.equal(result.aggregable, true);
    assert.equal(result.metrics.inventedFindingRate.numerator, 1);
    // The findings are still visible, beside the rate rather than inside it.
    assert.equal(result.metrics.inventedFindingCount, 3);
  });

  await t.test("supporting material and quotations are not findings put forward", () => {
    // The support claim sits inside the SAME submitted item as a real
    // finding -- that is what makes it supporting material.
    const support = buildCase({
      id: "h4",
      submissions: { missingPoints: ["[TEST] c omits the deadline; the fee also differs"] },
      claims: [
        { submittedAs: "missingPoints", sourceIndex: 0, targetLabel: "c", requirementId: REQ },
        {
          submittedAs: "missingPoints",
          sourceIndex: 0,
          targetLabel: "a",
          requirementId: "fee-amount",
          role: "support",
          outsideGoldVerdict: "false_finding",
        },
      ],
    });
    const quoted = invents("h5", { speechAct: "quotation" });
    const result = run([support, quoted]);
    assert.equal(result.aggregable, true, JSON.stringify(result.blockers));
    assert.equal(result.metrics.inventedFindingRate.numerator, 0);
    assert.equal(result.metrics.inventedFindingCount, 0);
  });

  await t.test("a lone support claim is judged by the same three conditions", () => {
    const alone = buildCase({
      id: "h6",
      phenomenon: "no_issue",
      gold: {},
      goldCompleteness: {},
      submissions: { contradictions: ["[TEST] a and b disagree about the fee"] },
      claims: [
        {
          submittedAs: "contradictions",
          sourceIndex: 0,
          targetLabel: "a",
          requirementId: "fee-amount",
          role: "support",
          outsideGoldVerdict: "false_finding",
        },
      ],
    });
    const result = run([alone]);
    assert.equal(result.aggregable, true);
    assert.equal(result.metrics.inventedFindingRate.numerator, 1);
  });

  await t.test("a finding a person ruled correct is the gold's defect, not an invention", () => {
    const gap = invents("h7", { outsideGoldVerdict: "gold_incomplete" }, {
      goldCompleteness: { missingPoints: false },
    });
    const result = run([gap]);
    assert.equal(result.aggregable, true);
    assert.equal(result.metrics.inventedFindingRate.numerator, 0);
  });

  await t.test("the negative subset restricts BOTH sides", () => {
    // One negative case that invented, two negative that did not, and one
    // positive case that invented. Whole numerator over the negative
    // denominator would read 2/3; the subset is 1/3.
    const built = [
      buildCase({
        id: "h8",
        phenomenon: "no_issue",
        gold: {},
        goldCompleteness: {},
        submissions: { contradictions: ["[TEST] h8: a and b disagree about the fee"] },
        claims: [
          {
            submittedAs: "contradictions",
            sourceIndex: 0,
            targetLabel: "a",
            requirementId: "fee-amount",
            outsideGoldVerdict: "false_finding",
          },
        ],
      }),
      silent("h9", { phenomenon: "no_issue", gold: {}, goldCompleteness: {} }),
      silent("h10", { phenomenon: "genuine_consensus", gold: {}, goldCompleteness: {} }),
      invents("h11"),
    ];
    const result = run(built);
    assert.equal(result.aggregable, true, JSON.stringify(result.blockers));
    assert.equal(result.metrics.inventedFindingRate.numerator, 2);
    assert.equal(result.metrics.inventedFindingRate.denominator, 4);
    const subset = result.metrics.inventedFindingRateNegativeSubset;
    assert.equal(subset.numerator, 1);
    assert.equal(subset.denominator, 3);
  });

  await t.test("a run with no negative case reports insufficient evidence, not zero", () => {
    const result = run([found("h12")]);
    assert.equal(result.aggregable, true);
    const subset = result.metrics.inventedFindingRateNegativeSubset;
    assert.equal(subset.denominator, 0);
    assert.equal(subset.rate, null);
    assert.match(subset.insufficientEvidence, /denominator is zero/);
  });
});
