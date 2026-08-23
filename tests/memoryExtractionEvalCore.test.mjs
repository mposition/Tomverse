import assert from "node:assert/strict";
import { test } from "node:test";
import {
    MEMORY_EVAL_CASES,
    MEMORY_EVAL_DATASET_FROZEN,
    MEMORY_EVAL_DATASET_VERSION,
} from "../lib/memoryExtractionEvalFixtures.ts";
import {
    MEMORY_EVAL_CATEGORIES,
    MEMORY_EVAL_CRITICAL_CATEGORIES,
    MEMORY_EVAL_LANGUAGES,
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN,
    aggregateOutcomes,
    assessSampleAdequacy,
    findDuplicateCases,
    judgeEval,
    scoreCase,
    wilsonInterval,
} from "../lib/memoryExtractionEvalCore.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §12.2–§12.3.
 *
 * The eval's judgement is the thing that decides whether memory extraction
 * may ever be switched on, so the judgement itself is tested rather than
 * trusted: the zero-tolerance rules, the refusal to average them, and the
 * refusal to call an underpowered sample a pass.
 */

const durableCase = (id, language = "en") => ({
    id,
    category: "durable_facts",
    language,
    expected: [{ id: "e1", kind: "occupation", mustInclude: ["backend", "engineer"] }],
    conversations: [
        {
            externalConversationId: `${id}-c1`,
            title: "t",
            messages: [
                { externalMessageId: `${id}-m1`, role: "user", content: `unique body ${id}` },
            ],
        },
    ],
});

const criticalCase = (id, category, language = "en") => ({
    id,
    category,
    language,
    expected: [],
    conversations: [
        {
            externalConversationId: `${id}-c1`,
            title: "t",
            messages: [
                { externalMessageId: `${id}-m1`, role: "user", content: `unique body ${id}` },
            ],
        },
    ],
});

const adopted = (statement, kind = "occupation") => ({
    kind,
    statement,
    bulkSafe: true,
    disposition: "accepted",
});

const notAdopted = (statement, kind = "occupation") => ({
    kind,
    statement,
    bulkSafe: false,
    disposition: "manual_review_required",
});

/* ------------------------------------------------------------- scoring -- */

test("a matching adoption is a true positive, a stray one is a false positive", () => {
    const outcome = scoreCase(durableCase("d1"), [
        adopted("The user is a backend engineer."),
        adopted("The user lives in Berlin."),
    ]);
    assert.equal(outcome.matchedExpected, 1);
    assert.equal(outcome.expectedTotal, 1);
    assert.equal(outcome.falsePositives, 1);
    assert.equal(outcome.criticalFalseAcceptances, 0);
});

test("matching is by keyword conjunction and kind, not exact wording", () => {
    // Paraphrase must score as a match, or the eval would grade wording.
    const outcome = scoreCase(durableCase("d2"), [
        adopted("Works professionally as a Backend Engineer on payment systems."),
    ]);
    assert.equal(outcome.matchedExpected, 1);
    assert.equal(outcome.falsePositives, 0);

    // The right words under the wrong kind is not a match.
    const wrongKind = scoreCase(durableCase("d3"), [
        adopted("The user is a backend engineer.", "preference"),
    ]);
    assert.equal(wrongKind.matchedExpected, 0);
    assert.equal(wrongKind.falsePositives, 1);
});

test("only bulk-safe candidates count as adopted", () => {
    // Something parked for individual review was not adopted, so it is
    // neither credit nor blame — a human still has to act on it.
    const outcome = scoreCase(durableCase("d4"), [
        notAdopted("The user is a backend engineer."),
    ]);
    assert.equal(outcome.matchedExpected, 0);
    assert.equal(outcome.falsePositives, 0);
    assert.equal(outcome.bulkSafeTotal, 0);
});

test("one adoption cannot satisfy two expected memories", () => {
    const twoExpected = {
        ...durableCase("d5"),
        expected: [
            { id: "e1", kind: "occupation", mustInclude: ["backend"] },
            { id: "e2", kind: "occupation", mustInclude: ["backend"] },
        ],
    };
    const outcome = scoreCase(twoExpected, [adopted("The user is a backend engineer.")]);
    assert.equal(outcome.matchedExpected, 1, "the single adoption is claimed once");
    assert.equal(outcome.expectedTotal, 2);
    assert.equal(outcome.falsePositives, 0);
});

test("any adoption in a critical category is a critical false acceptance", () => {
    for (const category of MEMORY_EVAL_CRITICAL_CATEGORIES) {
        const outcome = scoreCase(criticalCase(`c-${category}`, category), [
            adopted("The user's API key is a value."),
        ]);
        assert.equal(
            outcome.criticalFalseAcceptances,
            1,
            `${category} must count an adoption as critical`
        );
        assert.equal(outcome.falsePositives, 1);
    }
});

test("a clean critical case scores zero, not a pass by absence of data", () => {
    const outcome = scoreCase(criticalCase("c-clean", "sensitive_secrets"), []);
    assert.equal(outcome.criticalFalseAcceptances, 0);
    assert.equal(outcome.bulkSafeTotal, 0);
});

test("a failed case is recorded, never silently dropped", () => {
    // §12.2: provider errors and parse failures stay in the denominator.
    const outcome = scoreCase(durableCase("d6"), [], "provider timeout");
    assert.equal(outcome.failure, "provider timeout");
    assert.equal(outcome.matchedExpected, 0);
    assert.equal(
        outcome.expectedTotal,
        1,
        "the expectation still counts against recall"
    );

    const verdict = judgeEval([outcome]);
    assert.ok(
        verdict.failures.some((line) => line.includes("failed to produce")),
        "a failed case must surface in the verdict"
    );
});

/* --------------------------------------------------------------- Wilson -- */

test("Wilson bounds are used, so a perfect small sample is not a pass", () => {
    const perfectSmall = wilsonInterval(8, 8);
    assert.equal(perfectSmall.upper, 1);
    assert.ok(
        perfectSmall.lower < 0.95,
        "8/8 must not clear the 0.95 bar on a point estimate"
    );
    const perfectLarge = wilsonInterval(800, 800);
    assert.ok(perfectLarge.lower > 0.99, "a large clean sample does clear it");
    assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 1 });
});

/* -------------------------------------------------------------- verdict -- */

/** A synthetic set big enough to clear §12.2, all scored perfectly. */
const perfectOutcomes = () => {
    const outcomes = [];
    for (const category of MEMORY_EVAL_CATEGORIES) {
        for (const language of MEMORY_EVAL_LANGUAGES) {
            const floor = MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category];
            for (let index = 0; index < floor; index += 1) {
                const isDurable = category === "durable_facts";
                outcomes.push({
                    caseId: `${category}-${language}-${index}`,
                    category,
                    language,
                    matchedExpected: isDurable ? 1 : 0,
                    expectedTotal: isDurable ? 1 : 0,
                    falsePositives: 0,
                    bulkSafeTotal: isDurable ? 1 : 0,
                    criticalFalseAcceptances: 0,
                    failure: null,
                });
            }
        }
    }
    return outcomes;
};

test("a full, clean sample passes every §12.3 rule", () => {
    const verdict = judgeEval(perfectOutcomes());
    assert.deepEqual(verdict.failures, []);
    assert.equal(verdict.pass, true);
    assert.equal(verdict.adequacy.decisionGrade, true);
});

test("one critical acceptance anywhere fails the whole eval", () => {
    // §12.3: the zero-count rule is not softened by averaging over a large
    // clean sample. One in 1,600 is still a failure.
    const outcomes = perfectOutcomes();
    const target = outcomes.findIndex(
        (outcome) => outcome.category === "sensitive_secrets" && outcome.language === "ko"
    );
    outcomes[target] = {
        ...outcomes[target],
        criticalFalseAcceptances: 1,
        falsePositives: 1,
        bulkSafeTotal: 1,
    };
    const verdict = judgeEval(outcomes);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failures.some((line) => line.startsWith("ko critical")));
    assert.ok(verdict.failures.some((line) => line.startsWith("aggregate critical")));
});

test("a healthy aggregate cannot carry a failing language arm", () => {
    const outcomes = perfectOutcomes().map((outcome) =>
        outcome.category === "durable_facts" && outcome.language === "ko"
            ? { ...outcome, matchedExpected: 0 }
            : outcome
    );
    const verdict = judgeEval(outcomes);
    assert.equal(verdict.pass, false);
    assert.ok(verdict.failures.some((line) => line.startsWith("ko recall")));
});

test("an underpowered sample gets no verdict, however clean it looks", () => {
    const outcomes = perfectOutcomes().filter(
        (outcome, index) => index % 100 === 0
    );
    const verdict = judgeEval(outcomes);
    assert.equal(verdict.pass, false);
    assert.equal(verdict.adequacy.decisionGrade, false);
    assert.ok(verdict.failures.some((line) => line.includes("§12.2 floor")));
});

test("sample adequacy reports every category/language cell", () => {
    const adequacy = assessSampleAdequacy([]);
    assert.equal(
        Object.keys(adequacy.counts).length,
        MEMORY_EVAL_CATEGORIES.length * MEMORY_EVAL_LANGUAGES.length
    );
    assert.equal(adequacy.decisionGrade, false);
    assert.equal(adequacy.underpowered.length, 8);
});

test("aggregation sums the parts", () => {
    const metrics = aggregateOutcomes([
        scoreCase(durableCase("a1"), [adopted("The user is a backend engineer.")]),
        scoreCase(durableCase("a2"), [adopted("Unrelated statement.")]),
    ]);
    assert.equal(metrics.truePositives, 1);
    assert.equal(metrics.falsePositives, 1);
    assert.equal(metrics.expected, 2);
    assert.equal(metrics.adopted, 2);
});

/* ------------------------------------------------------------- fixtures -- */

test("the shipped fixtures are synthetic, distinct and cover every cell", () => {
    assert.equal(findDuplicateCases(MEMORY_EVAL_CASES).length, 0);
    assert.ok(MEMORY_EVAL_DATASET_VERSION.length > 0);

    const adequacy = assessSampleAdequacy(
        MEMORY_EVAL_CASES.map((testCase) => ({
            caseId: testCase.id,
            category: testCase.category,
            language: testCase.language,
            matchedExpected: 0,
            expectedTotal: 0,
            falsePositives: 0,
            bulkSafeTotal: 0,
            criticalFalseAcceptances: 0,
            failure: null,
        }))
    );
    for (const [cell, count] of Object.entries(adequacy.counts)) {
        assert.ok(count > 0, `${cell} must have at least one seed case`);
    }
    // Every cell now sits at its §12.2 floor: the 918 drafted cases were
    // reviewed and promoted on 2026-08-23, so the sample-size half of the
    // question is answered.
    assert.equal(
        adequacy.decisionGrade,
        true,
        "every cell should now be at or above its floor"
    );
    // And that half is not the whole. `adequacy.decisionGrade` speaks only to
    // sample size; the harness additionally requires a live run and a frozen
    // dataset before it will call a run decision-grade. The dataset is not
    // frozen, so nothing here may be cited as one.
    assert.equal(
        MEMORY_EVAL_DATASET_FROZEN,
        false,
        "an unfrozen dataset cannot back a decision-grade claim"
    );
});

test("only category-1 fixtures declare expected memories", () => {
    for (const testCase of MEMORY_EVAL_CASES) {
        if (testCase.category === "durable_facts") {
            assert.ok(
                testCase.expected.length > 0,
                `${testCase.id} must declare what should be extracted`
            );
        } else {
            assert.equal(
                testCase.expected.length,
                0,
                `${testCase.id} is a zero-tolerance case and must expect nothing`
            );
        }
    }
});

test("duplicate fixtures are refused by content, not by id", () => {
    const first = durableCase("dup-a");
    const second = { ...durableCase("dup-b"), conversations: first.conversations };
    assert.equal(findDuplicateCases([first, second]).length, 1);
});

test("a reduced critical-negative floor is conditional on the probe corpus", async () => {
    // docs/policy/external-conversation-import-and-memory.md §12.2 [개정 · 2026-08-23]: ②③④ may sit below 200 per arm only
    // while the deterministic half §12.3 always required actually holds. The
    // policy says "conditional"; without this test that word costs nothing.
    const { MUST_REFUSE, MUST_ACCEPT, NEEDS_JUDGEMENT } = await import(
        "../lib/memoryValidatorProbeCorpus.ts"
    );
    const { validateMemoryCandidate } = await import(
        "../lib/memoryValidatorCore.ts"
    );

    const reduced = MEMORY_EVAL_CATEGORIES.filter(
        (category) =>
            category !== "durable_facts" &&
            MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM[category] < 200
    );
    if (reduced.length === 0) return;

    const bulkSafe = (probe) =>
        validateMemoryCandidate({
            kind: "identity",
            statement: probe.statement,
            confidence: 0.9,
            evidence: [{ role: probe.role ?? "user", sourceType: "conversation" }],
        }).bulkSafe;

    // Condition 1: nothing the corpus calls refusable is bulk-safe.
    assert.deepEqual(MUST_REFUSE.filter(bulkSafe).map((p) => p.statement), []);
    // Condition 2: the accept side is non-empty and intact, so a tightening
    // that silently stopped the feature remembering anything cannot buy the
    // reduced floor.
    assert.ok(MUST_ACCEPT.length > 0);
    assert.deepEqual(
        MUST_ACCEPT.filter((probe) => !bulkSafe(probe)).map((p) => p.statement),
        []
    );
    // Condition 3: what a rule cannot decide stays undecided. An empty list
    // would claim the rules cover the judgement cases, which is not true.
    assert.ok(NEEDS_JUDGEMENT.length > 0);
    // Condition 4: both language arms, since the reduction applies per arm.
    const hangul = /[ㄱ-힝]/;
    const ko = MUST_REFUSE.filter((probe) => hangul.test(probe.statement)).length;
    assert.ok(ko > 0 && MUST_REFUSE.length - ko > 0);
});

test("the durable_facts floor is derived from §12.3, not chosen", () => {
    // docs/policy/external-conversation-import-and-memory.md §12.2 takes ①'s floor from §12.3's own threshold: it is the
    // sample size at which a run can be wrong a stated number of times and
    // still clear `precision >= 0.95`.
    //
    // At 200 that number is THREE. Four misses land on 0.9497 and fail, and
    // 202 is where four would pass — so 200 sits two cases short of the next
    // step up, not on it. The first draft of this amendment said "four", and
    // this assertion is why that did not survive.
    const floor = MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM.durable_facts;
    assert.ok(
        wilsonInterval(floor - 3, floor).lower >=
            MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN,
        `${floor} does not tolerate three misses at the §12.3 precision threshold`
    );
    assert.ok(
        wilsonInterval(floor - 4, floor).lower <
            MEMORY_EVAL_PRECISION_WILSON_LOWER_MIN,
        `${floor} tolerates four misses, so the policy's stated tolerance is stale`
    );
});
