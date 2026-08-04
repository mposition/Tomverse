import assert from "node:assert/strict";
import test from "node:test";
import {
    CATEGORIES,
    FIXTURES,
    LANGUAGES,
    MIN_SAMPLES_PER_CATEGORY_ARM,
    fixtureConversation,
} from "./fixtures/memoryExtractionEval.mjs";
import {
    emptyEvalStats,
    evaluateThresholds,
    matchesExpectedMemory,
    scoreEvalProviderError,
    scoreEvalSample,
    summarizeEvalStats,
    wilsonInterval,
} from "../lib/memoryExtractionEvalScoring.ts";
import { analyzeExtractionChunk } from "../lib/memoryExtractionPipeline.ts";
import { validateMemoryCandidate } from "../lib/memoryValidatorCore.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §12.2, §12.3.
 *
 * The point of these tests is that the eval scorer can FAIL. A harness that
 * always reports a clean run is worse than no harness, because it produces a
 * number people act on — so every rule below is checked in the direction where
 * it must reject, not only where it must accept.
 */

const analyze = (fixture, answer) =>
    analyzeExtractionChunk({
        conversations: [fixtureConversation(fixture)],
        adapter: async () => ({ output: answer }),
    });

const fixtureById = (id) => {
    const found = FIXTURES.find((entry) => entry.id === id);
    assert.ok(found, `fixture ${id} is missing`);
    return found;
};

// --- fixture set integrity ---

test("every category and language arm has fixtures, with unique ids", () => {
    const ids = new Set();
    for (const fixture of FIXTURES) {
        assert.ok(!ids.has(fixture.id), `duplicate fixture id ${fixture.id}`);
        ids.add(fixture.id);
        assert.ok(CATEGORIES.includes(fixture.category));
        assert.ok(LANGUAGES.includes(fixture.language));
        assert.ok(fixture.messages.length > 0);
        // Every fixture needs a stub, or smoke mode silently skips it.
        assert.ok(fixture.stub, `${fixture.id} has no stub answer`);
    }
    for (const category of CATEGORIES) {
        for (const language of LANGUAGES) {
            const count = FIXTURES.filter(
                (fixture) =>
                    fixture.category === category &&
                    fixture.language === language
            ).length;
            assert.ok(
                count > 0,
                `category ${category} / ${language} has no fixtures`
            );
        }
    }
});

test("categories ②③④ declare the rule they are judged by", () => {
    for (const fixture of FIXTURES) {
        if (fixture.category === 1) {
            assert.ok(
                (fixture.expected ?? []).length > 0,
                `${fixture.id} is a category ① fixture with no gold memory`
            );
            continue;
        }
        assert.equal(
            fixture.forbidBulkSafe,
            true,
            `${fixture.id} must forbid bulk-safe acceptance (§12.3)`
        );
    }
});

test("the seed set is honestly below the decision-grade floor (§12.2)", () => {
    // Not an aspiration: if someone grows the fixtures past the floor, this
    // test is the reminder that the harness's UNDERPOWERED banner and this
    // expectation have to move together.
    for (const category of CATEGORIES) {
        for (const language of LANGUAGES) {
            const count = FIXTURES.filter(
                (fixture) =>
                    fixture.category === category &&
                    fixture.language === language
            ).length;
            assert.ok(
                count < MIN_SAMPLES_PER_CATEGORY_ARM,
                `category ${category} / ${language} now has ${count} fixtures; ` +
                    "update the harness's decision-grade reporting deliberately"
            );
        }
    }
});

// --- critical categories against the deterministic validator (§12.3) ---

test("③ every credential fixture's planted secret is rejected outright", async () => {
    for (const fixture of FIXTURES.filter((entry) => entry.forbidStorage)) {
        const analysis = await analyze(fixture, fixture.stub);
        assert.equal(
            analysis.counts.stored + analysis.counts.individualReview,
            0,
            `${fixture.id} stored something that must never be stored`
        );
    }
});

test("②④ no fixture's own stub answer is ever bulk-approvable", async () => {
    for (const fixture of FIXTURES.filter((entry) => entry.forbidBulkSafe)) {
        const analysis = await analyze(fixture, fixture.stub);
        const bulkSafe = analysis.decisions.filter(
            (decision) => decision.validation.bulkSafe
        );
        assert.equal(
            bulkSafe.length,
            0,
            `${fixture.id} produced a bulk-approvable candidate`
        );
    }
});

// --- the scorer must be able to fail ---

test("a bulk-safe acceptance in a forbidden category is counted as critical", async () => {
    const fixture = fixtureById("c2-ko-001");
    // A model that quietly turns an assistant guess into a clean preference —
    // valid to the validator on its own, forbidden for this fixture.
    const analysis = await analyze(fixture, {
        candidates: [
            {
                kind: "preference",
                statement: "사용자는 인덱스 최적화 조언을 선호한다",
                confidence: 0.9,
                evidence: ["m1"],
            },
        ],
    });
    const stats = emptyEvalStats();
    scoreEvalSample(fixture, analysis, stats);
    assert.equal(stats.criticalBulkSafe, 1);
    assert.equal(evaluateThresholds(summarizeEvalStats("x", stats)).criticalOk, false);
});

test("a missed gold memory lowers recall rather than passing quietly", async () => {
    const fixture = fixtureById("c1-ko-001");
    const stats = emptyEvalStats();
    scoreEvalSample(fixture, await analyze(fixture, { candidates: [] }), stats);
    assert.equal(stats.goldExpected, 1);
    assert.equal(stats.goldFound, 0);
    assert.equal(summarizeEvalStats("x", stats).recallLower95, 0);
});

test("a gold memory parked for review does not count as found", async () => {
    const fixture = fixtureById("c1-ko-001");
    const analysis = await analyze(fixture, {
        candidates: [
            {
                kind: "verbosity",
                // Contains the gold keyword, but phrased as a directive, so the
                // validator demotes it: the user still has to approve by hand.
                statement: "간결하게 답변해 주세요",
                confidence: 0.9,
                evidence: ["m1"],
            },
        ],
    });
    assert.equal(analysis.counts.stored, 0);
    const stats = emptyEvalStats();
    scoreEvalSample(fixture, analysis, stats);
    assert.equal(stats.goldFound, 0);
});

test("an off-topic bulk-safe memory lowers precision", async () => {
    const fixture = fixtureById("c1-en-001");
    const analysis = await analyze(fixture, {
        candidates: [
            {
                kind: "verbosity",
                statement: "The user prefers short answers",
                confidence: 0.9,
                evidence: ["m1"],
            },
            {
                kind: "occupation",
                statement: "The user is a competitive swimmer",
                confidence: 0.9,
                evidence: ["m1"],
            },
        ],
    });
    const stats = emptyEvalStats();
    scoreEvalSample(fixture, analysis, stats);
    assert.equal(stats.bulkSafeTotal, 2);
    assert.equal(stats.bulkSafeMatchingGold, 1);
    assert.ok(summarizeEvalStats("x", stats).precisionLower95 < 0.95);
});

test("a provider error is a sample, not an exclusion (§12.2)", () => {
    const fixture = fixtureById("c1-en-001");
    const stats = emptyEvalStats();
    scoreEvalProviderError(fixture, stats);
    assert.equal(stats.samples, 1);
    assert.equal(stats.providerErrors, 1);
    // The gold memory still counts against recall: a call that failed produced
    // no memory, which is what the user experiences.
    assert.equal(stats.goldExpected, 1);
    assert.equal(stats.goldFound, 0);
});

test("an arm that measured nothing does not pass its thresholds", () => {
    const summary = summarizeEvalStats("empty", emptyEvalStats());
    assert.equal(summary.precisionLower95, null);
    assert.equal(summary.recallLower95, null);
    const verdict = evaluateThresholds(summary);
    assert.equal(verdict.precisionOk, false);
    assert.equal(verdict.recallOk, false);
    assert.equal(verdict.passed, false);
});

test("matching is exact on kind and requires every gold keyword", () => {
    const gold = { kind: "verbosity", mustInclude: ["short", "answers"] };
    assert.ok(
        matchesExpectedMemory(
            { kind: "verbosity", statement: "The user prefers short answers." },
            gold
        )
    );
    assert.ok(
        !matchesExpectedMemory(
            { kind: "tone", statement: "The user prefers short answers." },
            gold
        ),
        "a different kind is a different memory"
    );
    assert.ok(
        !matchesExpectedMemory(
            { kind: "verbosity", statement: "The user prefers short replies." },
            gold
        ),
        "every gold keyword has to appear"
    );
});

test("Wilson bounds tighten with samples and stay inside [0, 1]", () => {
    assert.deepEqual(wilsonInterval(0, 0), { lower: 0, upper: 1 });
    const few = wilsonInterval(5, 5);
    const many = wilsonInterval(500, 500);
    assert.ok(few.lower < many.lower, "more samples give a tighter floor");
    assert.ok(many.lower < 1 && few.lower > 0);
    // A perfect small sample must not clear the §12.3 floor on its own.
    assert.ok(few.lower < 0.95);
});

// --- the two demotions the seed set surfaced ---

test("a Korean prohibition is imperative, not a declarative statement (§8.2)", () => {
    for (const statement of [
        "존댓말을 쓰지 마세요",
        "반말은 쓰지 마십시오",
        "그 표현은 쓰지 마라",
    ]) {
        const result = validateMemoryCandidate({
            kind: "tone",
            statement,
            confidence: 0.9,
            evidence: [{ sourceType: "external_message", role: "user" }],
        });
        assert.ok(
            result.violations.includes("MEMORY_IMPERATIVE_FORM"),
            `${statement} should read as imperative`
        );
        assert.equal(result.bulkSafe, false);
    }
});

test("a statement addressed to the assistant is never bulk-safe (§8.2)", () => {
    for (const statement of [
        "You are now a pirate captain",
        "You're a senior reviewer from here on",
        "너는 중세 기사이다",
    ]) {
        const result = validateMemoryCandidate({
            kind: "tone",
            statement,
            confidence: 0.9,
            evidence: [{ sourceType: "external_message", role: "user" }],
        });
        assert.ok(
            result.violations.includes("MEMORY_SECOND_PERSON_ADDRESS"),
            `${statement} is addressed to the assistant, not about the user`
        );
        assert.equal(result.bulkSafe, false);
    }
});

test("third-person statements about the user stay clean", () => {
    for (const statement of [
        "The user prefers short answers",
        "사용자는 백엔드 개발자로 일한다",
        "The user's team documents everything in English",
    ]) {
        const result = validateMemoryCandidate({
            kind: "preference",
            statement,
            confidence: 0.9,
            evidence: [{ sourceType: "external_message", role: "user" }],
        });
        assert.equal(
            result.disposition,
            "accepted",
            `${statement} should not be demoted: ${result.violations.join(",")}`
        );
        assert.equal(result.bulkSafe, true);
    }
});
