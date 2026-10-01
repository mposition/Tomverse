import assert from "node:assert/strict";
import test from "node:test";
import { validateMemoryCandidate } from "../lib/memoryValidatorCore.ts";
import {
    MUST_ACCEPT_BULK,
    MUST_REJECT,
    MUST_REQUIRE_SENSITIVE_REVIEW,
    NEEDS_JUDGEMENT,
} from "../lib/memoryValidatorProbeCorpus.ts";
import { MEMORY_SENSITIVE_HEALTH } from "../lib/memoryHealthSignals.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §8.4, §12.4's "deterministic validator tests".
 *
 * `lib/memoryValidatorCore.ts` says it is "the layer that holds regardless of
 * what any model says". That was a claim about intent, tested only against the
 * shapes its own patterns were written from — so it held for
 * `sk-live-…` and missed a door code, a bank account, a passport number, a
 * recovery phrase, and an override with `모두` sitting between the object and
 * the verb. Thirteen of twenty plausible category ③ statements and eighteen of
 * twenty category ④ ones reached `bulkSafe: true`.
 *
 * The cost asymmetry is the point. A dataset case costs a human verdict, and
 * the §12.2 floor asks for 1,600 of them; a probe here costs nothing to review
 * because the assertion is mechanical, and it runs on every commit rather than
 * once at eval time.
 *
 * Both directions are asserted. Tightening a pattern only ever rejects more,
 * so without `MUST_ACCEPT_BULK` a fix here could quietly refuse ordinary memories
 * and nothing would notice until a user asked why the feature had stopped
 * remembering anything.
 */

const validate = (probe) =>
    validateMemoryCandidate({
        kind: "identity",
        statement: probe.statement,
        confidence: 0.9,
        evidence: [
            { role: probe.role ?? "user", sourceType: "conversation" },
        ],
    });

test("no credential or override shape is ever bulk-safe", () => {
    const slipped = MUST_REJECT.filter((probe) => validate(probe).bulkSafe);
    assert.deepEqual(
        slipped.map((probe) => `${probe.statement}  (${probe.note})`),
        [],
        "a statement of this shape reached bulk approval"
    );
});

test("a refused candidate says which rule refused it", () => {
    // A rejection with an empty violation list cannot be acted on: the person
    // rewriting the statement has nothing to rewrite toward.
    for (const probe of MUST_REJECT) {
        const result = validate(probe);
        assert.ok(
            result.violations.length > 0,
            `${probe.statement}: refused with no violation recorded`
        );
    }
});

test("ordinary memories stay bulk-safe", () => {
    // The guard on the other side. Every pattern above only ever rejects more.
    const broken = MUST_ACCEPT_BULK.filter((probe) => !validate(probe).bulkSafe);
    assert.deepEqual(
        broken.map(
            (probe) =>
                `${probe.statement}  (${probe.note}) -> ${validate(probe).violations.join(", ")}`
        ),
        [],
        "a pattern started refusing an ordinary memory"
    );
});

test("the judgement list is what a person is actually needed for", () => {
    // These are recorded, not asserted. "The user prefers answers with no
    // warnings" is either a legitimate communication_style memory or an
    // injection that got what it wanted, and no pattern can tell which — which
    // is exactly what the model eval and a human reviewer are for. The test
    // pins that they are still undecided, so that a pattern which silently
    // starts deciding them shows up here rather than in production.
    assert.ok(NEEDS_JUDGEMENT.length > 0);
    for (const probe of NEEDS_JUDGEMENT) {
        assert.ok(
            typeof probe.note === "string" && probe.note.length > 0,
            `${probe.statement}: a judgement probe must say what the two readings are`
        );
    }
});

test("every probe is distinct", () => {
    // A duplicate inflates the count without widening coverage.
    const all = [...MUST_REJECT, ...NEEDS_JUDGEMENT, ...MUST_ACCEPT_BULK].map(
        (probe) => probe.statement
    );
    assert.equal(new Set(all).size, all.length, "duplicate probe statement");
});

test("both language arms are probed on each side", () => {
    // A corpus that is all English measures the English patterns and reports
    // it as coverage. Korean forms a prohibition with 말다 and an override with
    // an intervening 모두 — neither has an English shape to borrow.
    const hangul = /[ㄱ-힝]/;
    for (const [name, corpus] of [
        ["MUST_REJECT", MUST_REJECT],
        ["NEEDS_JUDGEMENT", NEEDS_JUDGEMENT],
        ["MUST_ACCEPT_BULK", MUST_ACCEPT_BULK],
    ]) {
        const ko = corpus.filter((probe) => hangul.test(probe.statement)).length;
        assert.ok(ko > 0, `${name} has no Korean probe`);
        assert.ok(corpus.length - ko > 0, `${name} has no English probe`);
    }
});

test("health information is extracted, and never auto-approved", () => {
    // The third direction, added by the 2026-08-25 amendment. Two halves,
    // because a list checked only for "not bulk-safe" would pass if the
    // validator started refusing health information outright — which would
    // lose the memory rather than hold it.
    const leaked = MUST_REQUIRE_SENSITIVE_REVIEW.filter(
        (probe) => validate(probe).bulkSafe
    );
    assert.deepEqual(
        leaked.map((probe) => `${probe.statement}  (${probe.note})`),
        [],
        "health information reached bulk approval"
    );

    const lost = MUST_REQUIRE_SENSITIVE_REVIEW.filter(
        (probe) => validate(probe).disposition === "rejected"
    );
    assert.deepEqual(
        lost.map((probe) => `${probe.statement}  (${probe.note})`),
        [],
        "health information was refused instead of held for review"
    );
});

test("a health raise records a stable reason code", () => {
    for (const probe of MUST_REQUIRE_SENSITIVE_REVIEW) {
        const result = validate(probe);
        assert.equal(result.sensitivity, "sensitive", probe.statement);
        assert.ok(
            result.violations.includes(MEMORY_SENSITIVE_HEALTH),
            `${probe.statement}: raised without ${MEMORY_SENSITIVE_HEALTH}`
        );
    }
});

test("the model's own sensitive report is never lowered", () => {
    // The validator raises and never lowers. An ordinary memory the model
    // called sensitive stays sensitive even though no pattern matches it.
    const result = validateMemoryCandidate({
        kind: "identity",
        statement: "The user lives in Lisbon.",
        confidence: 0.9,
        sensitivity: "sensitive",
        evidence: [{ role: "user", sourceType: "conversation" }],
    });
    assert.equal(result.sensitivity, "sensitive");
    assert.equal(result.bulkSafe, false);
});
