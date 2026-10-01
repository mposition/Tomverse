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
import { datasetDigest, freezeDrift } from "../lib/aiReviewEvalRun.ts";
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
  language = "ko",
  taskType = "safety_sensitive",
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
    // A real evaluation-set case, not the two fields this file happens to
    // read. The aggregator admits the run's dataset with the set's own
    // validator, so a fixture that skips the rest is not a dataset.
    datasetCase: {
      id,
      language,
      taskType,
      phenomenon,
      mode: "balanced",
      question: sourceCase.question,
      responses: sourceCase.responses.map((response) => ({
        ...response,
        modelId: "test",
        provider: "test",
      })),
      gold: { missingPoints: [{ id: REQ, anyOf: ["deadline"], description: "the deadline" }] },
      goldCompleteness: { missingPoints: true },
      status: "adopted",
      adoptedBy: "TEST",
      adoptedAt: AT,
    },
  };
};

/**
 * A frozen decision set holding exactly these cases.
 *
 * The freeze record is computed rather than typed, because the aggregator
 * recomputes it: a fixture carrying a stale digest would be refused, which is
 * the behaviour being relied on everywhere else in this file.
 */
const frozenDataset = (cases) => ({
  version: "test-v1",
  schemaVersion: 1,
  purpose: "decision",
  frozenAt: AT,
  frozenBy: "TEST",
  frozenDigest: datasetDigest({ cases }),
  cases,
});

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

/**
 * The digest a run of these cases would have recorded.
 *
 * Taken from the cases the fixture built, NOT from whatever dataset a test
 * then hands over -- deriving it from the dataset under test would write a
 * comparison that cannot fail, which is the defect the manifest exists to
 * close.
 */
const manifestFor = (built) => ({
  datasetDigest: datasetDigest({ cases: built.map((item) => item.datasetCase) }),
});

const run = (built, over = {}) => {
  const plan = over.plan ?? built.map((item) => item.plan);
  const entries = over.entries ?? built.map((item) => item.entry);
  return aggregateJudgedRun({
    plan,
    entries,
    runInputs: {
      journal: over.journal ?? built.map((item) => item.journal),
      dataset: over.dataset ?? frozenDataset(built.map((item) => item.datasetCase)),
    },
    manifest: over.manifest ?? manifestFor(built),
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
      runInputs: { journal: [], dataset: frozenDataset([]) },
      manifest: { datasetDigest: datasetDigest({ cases: [] }) },
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
    const result = run(built, {
      dataset: frozenDataset([moved]),
      manifest: { datasetDigest: datasetDigest({ cases: [moved] }) },
    });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /d1: /);
  });

  await t.test("the run's journal and dataset are required, not optional", () => {
    const built = [found("e1")];
    const result = aggregateJudgedRun({
      plan: built.map((item) => item.plan),
      entries: built.map((item) => item.entry),
      runInputs: { journal: undefined, dataset: undefined },
      manifest: manifestFor(built),
    });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /the run's dataset: the dataset file is not an object/);

    // And a dataset that is present but not bound to the run is still not a
    // run: the per-case check says so in its own words.
    const noJournal = aggregateJudgedRun({
      plan: built.map((item) => item.plan),
      entries: built.map((item) => item.entry),
      runInputs: {
        journal: undefined,
        dataset: frozenDataset(built.map((item) => item.datasetCase)),
      },
      manifest: manifestFor(built),
    });
    assert.equal(noJournal.aggregable, false);
    assert.match(noJournal.blockers.join("\n"), /checked against each other and against no run/);
  });

  await t.test("a case with no usable phenomenon never reaches a denominator", () => {
    const built = [found("f1")];
    const nameless = { ...built[0].datasetCase };
    delete nameless.phenomenon;
    const missing = run(built, {
      dataset: frozenDataset([nameless]),
      manifest: { datasetDigest: datasetDigest({ cases: [nameless] }) },
    });
    assert.equal(missing.aggregable, false);
    assert.match(missing.blockers.join("\n"), /phenomenon undefined is not supported/);

    const wrongCases = [{ ...built[0].datasetCase, phenomenon: "vibes" }];
    const wrong = run(built, {
      dataset: frozenDataset(wrongCases),
      manifest: { datasetDigest: datasetDigest({ cases: wrongCases }) },
    });
    assert.equal(wrong.aggregable, false);
    assert.match(wrong.blockers.join("\n"), /phenomenon vibes is not supported/);
  });
});

// ---------------------------------------------------------------------------
// The run's dataset, admitted as a whole
//
// Each of these produced a number before the dataset was admitted: the
// aggregate read the dataset a second time, on its own terms, and the second
// reading did not agree with the first.
// ---------------------------------------------------------------------------

test("the run's dataset is admitted before anything reads through it", async (t) => {
  await t.test("a repeated case id is refused, and does not move a denominator", () => {
    const built = [found("i1"), silent("i2")];
    const cases = built.map((item) => item.datasetCase);
    const clean = run(built);
    assert.equal(clean.aggregable, true);
    assert.equal(clean.metrics.missedEveryPlantedIssueRate.denominator, 2);

    // A second row for `i2`, appended. The shared check reads the FIRST row
    // with an id and this file used to build its map from the LAST, so this
    // moved `i2` out of the denominator while every judgement stayed valid.
    const shadowed = [...cases, { ...cases[1], question: "different", phenomenon: "no_issue" }];
    const result = run(built, {
      dataset: { ...frozenDataset(shadowed), frozenDigest: datasetDigest({ cases: shadowed }) },
    });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /i2: duplicate id/);
  });

  await t.test("an unfrozen set is not a frozen set", () => {
    const built = [found("i3")];
    const cases = built.map((item) => item.datasetCase);
    const unfrozen = run(built, {
      dataset: { version: "test-v1", schemaVersion: 1, purpose: "decision", cases },
    });
    assert.equal(unfrozen.aggregable, false);
    assert.match(unfrozen.blockers.join("\n"), /carries no freeze record/);

    // One thing wrong at a time. Breaking the date AND the digest together
    // passed on the digest alone, so a freeze time of "not-a-date" went
    // unnoticed: the test could not tell which check had caught it.
    const wrongDigest = run(built, {
      dataset: { ...frozenDataset(cases), frozenDigest: "sha256:wrong" },
    });
    assert.equal(wrongDigest.aggregable, false);
    assert.match(wrongDigest.blockers.join("\n"), /has changed since it was frozen/);

    const wrongDate = run(built, {
      // The digest is correct. Only the moment the contents are pinned to is
      // not a moment.
      dataset: { ...frozenDataset(cases), frozenAt: "not-a-date" },
    });
    assert.equal(wrongDate.aggregable, false);
    assert.match(wrongDate.blockers.join("\n"), /"not-a-date", which is not a time/);
    assert.doesNotMatch(wrongDate.blockers.join("\n"), /has changed since it was frozen/);
  });

  await t.test("another frozen set is not this run's frozen set", () => {
    // Everything the run produced is untouched: the plan, the journal, the
    // judgements and the artifacts. Only the dataset is swapped -- for one
    // that is internally consistent, correctly re-frozen, and different.
    const built = [found("i7"), silent("i8")];
    const clean = run(built);
    assert.equal(clean.aggregable, true);
    assert.equal(clean.metrics.missedEveryPlantedIssueRate.numerator, 1);
    assert.equal(clean.metrics.missedEveryPlantedIssueRate.denominator, 2);

    const edited = built.map((item) =>
      item.datasetCase.id === "i8"
        ? { ...item.datasetCase, phenomenon: "no_issue" }
        : item.datasetCase
    );
    const refrozen = {
      version: "test-v1",
      schemaVersion: 1,
      purpose: "decision",
      frozenAt: AT,
      frozenBy: "TEST",
      // Re-frozen, so the file agrees with its own record and `freezeDrift()`
      // has nothing to say.
      frozenDigest: datasetDigest({ cases: edited }),
      cases: edited,
    };
    assert.equal(freezeDrift(refrozen), null);

    // The run's own manifest is what refuses it. Without this the swap
    // aggregated, and the failing case left the denominator: 1/2 became 0/1.
    const result = run(built, { dataset: refrozen });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /another frozen set is not this one/);
  });

  await t.test("a run that recorded no dataset digest is not bound to one", () => {
    const built = [found("i9")];
    for (const manifest of [{}, { datasetDigest: "" }]) {
      const result = run(built, { manifest });
      assert.equal(result.aggregable, false);
      assert.match(result.blockers.join("\n"), /recorded no dataset digest/);
    }
  });

  await t.test("a phenomenon edited to another legal value is drift, not a rate", () => {
    // `sourceCaseDigest` covers the question and the answers by design, so it
    // cannot see this -- and the phenomenon is what decides two denominators.
    // The run's own freeze digest is what catches it.
    const built = [found("i4"), silent("i5")];
    const cases = built.map((item) => item.datasetCase);
    const edited = cases.map((item) => ({ ...item, phenomenon: "no_issue" }));
    const result = run(built, {
      dataset: { ...frozenDataset(cases), cases: edited },
    });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /has changed since it was frozen/);
  });

  await t.test("a malformed case is reported, not thrown", () => {
    const built = [found("i6")];
    const cases = [...built.map((item) => item.datasetCase), null];
    const result = run(built, {
      dataset: { ...frozenDataset(cases.slice(0, 1)), cases },
    });
    assert.equal(result.aggregable, false);
    assert.match(result.blockers.join("\n"), /case\[1\]: not an object/);
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

// ---------------------------------------------------------------------------
// Arms
//
// The gate applies the language-gap rule and the task-type shortfall rule to
// every metric it reads, so a judged metric reaching the gate needs per-arm
// numbers to exist. These cover the part that can go wrong silently: an arm
// computed by dividing the aggregate rather than over its own cases.
// ---------------------------------------------------------------------------

test("arms are computed over their own cases, not split out of the aggregate", async (t) => {
  await t.test("each arm carries its own numerator and denominator", () => {
    // ko: one found, one silent -> 1/2. en: one found -> 0/1.
    const built = [
      found("j1", { language: "ko" }),
      silent("j2", { language: "ko" }),
      found("j3", { language: "en" }),
    ];
    const result = run(built);
    assert.equal(result.aggregable, true, JSON.stringify(result.blockers));
    assert.equal(result.metrics.missedEveryPlantedIssueRate.numerator, 1);
    assert.equal(result.metrics.missedEveryPlantedIssueRate.denominator, 3);

    const byArm = new Map(result.byLanguage.map((arm) => [arm.arm, arm]));
    assert.deepEqual([...byArm.keys()], ["ko", "en"]);
    assert.equal(byArm.get("ko").cases, 2);
    assert.equal(byArm.get("ko").metrics.missedEveryPlantedIssueRate.numerator, 1);
    assert.equal(byArm.get("ko").metrics.missedEveryPlantedIssueRate.denominator, 2);
    assert.equal(byArm.get("en").cases, 1);
    assert.equal(byArm.get("en").metrics.missedEveryPlantedIssueRate.numerator, 0);
    assert.equal(byArm.get("en").metrics.missedEveryPlantedIssueRate.denominator, 1);
    // Splitting the aggregate would have given ko 2/3 of 1 and en 1/3 of 1.
    // Every arm denominator sums to the aggregate's only because every case
    // here is in the denominator; the numbers above are each arm's own.
  });

  await t.test("an arm with no measurable case reads insufficient evidence", () => {
    // The English arm holds one negative case, so it has cases but nothing in
    // the missed-everything denominator.
    const built = [
      found("j4", { language: "ko" }),
      silent("j5", {
        language: "en",
        phenomenon: "no_issue",
        gold: {},
        goldCompleteness: {},
      }),
    ];
    const result = run(built);
    assert.equal(result.aggregable, true, JSON.stringify(result.blockers));
    const english = result.byLanguage.find((arm) => arm.arm === "en");
    assert.equal(english.cases, 1);
    const metric = english.metrics.missedEveryPlantedIssueRate;
    assert.equal(metric.denominator, 0);
    assert.equal(metric.rate, null);
    assert.match(metric.insufficientEvidence, /denominator is zero/);
    // And that arm DOES have a negative subset, where the aggregate's is 1/1.
    assert.equal(english.metrics.inventedFindingRateNegativeSubset.denominator, 1);
  });

  await t.test("an arm the run holds no case in is omitted, not zeroed", () => {
    const built = [found("j6", { taskType: "planning_decision" })];
    const result = run(built);
    assert.equal(result.aggregable, true, JSON.stringify(result.blockers));
    assert.deepEqual(
      result.byTaskType.map((arm) => arm.arm),
      ["planning_decision"]
    );
    assert.deepEqual(result.byLanguage.map((arm) => arm.arm), ["ko"]);
  });

  await t.test("task-type arms are reported in the vocabulary's order", () => {
    const built = [
      found("j7", { taskType: "business_writing" }),
      found("j8", { taskType: "factual_current_information" }),
    ];
    const result = run(built);
    assert.equal(result.aggregable, true, JSON.stringify(result.blockers));
    // `factual_current_information` comes first in AI_REVIEW_EVAL_TASK_TYPES,
    // whatever order the cases arrived in.
    assert.deepEqual(
      result.byTaskType.map((arm) => arm.arm),
      ["factual_current_information", "business_writing"]
    );
  });

  await t.test("nothing here applies a gap or a shortfall", () => {
    // Two arms as far apart as the fixture can make them. No threshold is
    // approved, so the aggregator reports and does not judge.
    const built = [
      found("j9", { language: "ko" }),
      silent("j10", { language: "en" }),
    ];
    const result = run(built);
    assert.equal(result.aggregable, true, JSON.stringify(result.blockers));
    assert.equal(
      result.byLanguage.find((arm) => arm.arm === "ko").metrics
        .missedEveryPlantedIssueRate.rate,
      0
    );
    assert.equal(
      result.byLanguage.find((arm) => arm.arm === "en").metrics
        .missedEveryPlantedIssueRate.rate,
      1
    );
    assert.ok(!("gap" in result), "the aggregator must not compute an arm gap");
    assert.ok(!("shortfalls" in result));
  });
});
