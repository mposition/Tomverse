import assert from "node:assert/strict";
import { test } from "node:test";
import {
    HEALTH_SIGNALS,
    HEALTH_SIGNAL_SCOPES,
    carriesHealthSignal,
    healthSignalScopes,
} from "../lib/memoryHealthSignals.ts";

/**
 * Both directions, for every entry.
 *
 * A pattern with no counterexample is one nobody has tested in the direction
 * that hurts. Over-matching does not fail loudly — it quietly routes ordinary
 * memories to review, which shows up only as bulk eligibility recall falling.
 */

test("every signal catches its positives", () => {
    for (const signal of HEALTH_SIGNALS) {
        for (const statement of signal.positives) {
            assert.ok(
                carriesHealthSignal(statement),
                `${signal.id} missed: ${statement}`
            );
        }
    }
});

test("every signal ships negatives, and no signal catches them", () => {
    for (const signal of HEALTH_SIGNALS) {
        assert.ok(
            signal.negatives.length > 0,
            `${signal.id} has no counterexample`
        );
        for (const statement of signal.negatives) {
            assert.equal(
                carriesHealthSignal(statement),
                false,
                `${signal.id} over-matched: ${statement}`
            );
        }
    }
});

test("every signal declares a scope the policy names", () => {
    for (const signal of HEALTH_SIGNALS) {
        assert.ok(
            HEALTH_SIGNAL_SCOPES.includes(signal.scope),
            `${signal.id} has scope ${signal.scope}`
        );
        assert.ok(signal.positives.length > 0, signal.id);
    }
    // Every scope the policy names is actually covered. A scope with no
    // pattern is a promise the code does not keep.
    const covered = new Set(HEALTH_SIGNALS.map((signal) => signal.scope));
    for (const scope of HEALTH_SIGNAL_SCOPES) {
        assert.ok(covered.has(scope), `${scope} has no signal`);
    }
});

test("ordinary memories carry no signal", () => {
    // A sample of the successor dataset's bulk-safe shapes. If a pattern
    // starts raising these, bulk eligibility recall pays for it.
    for (const statement of [
        "사용자는 부산에 산다.",
        "The user lives in Lisbon.",
        "사용자는 답변을 짧게 받는 것을 선호한다.",
        "The user prefers short answers.",
        "사용자는 종합병원 간호사로 일한다.",
        "The user is a paramedic working twelve-hour shifts.",
        "사용자는 postgres 를 쓰기로 정했다.",
        "The user has settled on kubernetes.",
        "사용자는 매주 월요일 아침에 팀 회의가 있다.",
        "The user does the school run every weekday afternoon.",
        "사용자는 자막을 켜고 영상을 본다.",
        "The user watches everything with subtitles on.",
        "사용자는 면허가 없어 운전을 하지 못한다.",
        "The user never learned to drive.",
    ]) {
        assert.equal(carriesHealthSignal(statement), false, statement);
    }
});

test("the allergy metaphor is a known over-match, not an accident", () => {
    // Recorded rather than quietly tolerated. If a later change makes this
    // separable, the assertion is what says the behaviour moved.
    assert.equal(
        carriesHealthSignal("The user says they are allergic to long meetings."),
        true,
        "the metaphor is raised to sensitive, erring toward review"
    );
});

test("the scopes reported are the ones that matched", () => {
    assert.deepEqual(healthSignalScopes("사용자는 갑각류 알레르기가 있다."), [
        "allergy_intolerance",
    ]);
    assert.deepEqual(healthSignalScopes("The user is pregnant."), [
        "reproductive_health",
    ]);
    assert.deepEqual(healthSignalScopes("사용자는 부산에 산다."), []);
});

test("a statement derived from health is still caught", () => {
    // The v3 prompt rule: minimising a health fact into the user's own
    // constraint does not lower its sensitivity. These are the normalised
    // forms the successor dataset's third-party cases expect.
    for (const statement of [
        "사용자는 당뇨가 있는 아버지와 함께 먹을 음식을 골라야 한다.",
        "The user's father has dementia, so their evenings are not free.",
        "The user cooks gluten free at home because their daughter is coeliac.",
    ]) {
        assert.ok(carriesHealthSignal(statement), statement);
    }
});
