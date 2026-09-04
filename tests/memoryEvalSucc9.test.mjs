import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { isCalendarDay } from "../lib/memoryEvalCalendarDay.ts";
import {
    SUCC9_ASSISTANT_ONLY_SUBTYPES,
    SUCC9_SUBTYPE_REVIEW,
    isReviewerHandle,
    subtypeReviewProblems,
    succ9SubtypeProblems,
} from "../lib/memoryEvalSucc9Subtypes.ts";
import {
    MEMORY_EVAL_SUCC9_CASES,
    MEMORY_EVAL_SUCC9_DATASET_FROZEN,
    succ9Problems,
} from "../lib/memoryEvalSucc9.ts";
import { SUCC9_TRANSITION } from "../lib/memoryEvalSucc9Transition.ts";

/**
 * The parts of succ-9 whose failure mode is "the check passed and meant
 * nothing".
 *
 * Everything else about this dataset is asserted by `check:memory-eval-succ9`,
 * which runs in the PR gate and reads the tree as it is. What a script cannot
 * do is put a record into a state the tree is not in — a signature carrying a
 * plausible-looking date that is not a day, a confirmation with nobody's name
 * on it — and those are exactly the states the gate exists to refuse.
 */

/* ------------------------------------------------------- calendar days -- */

test("a date-shaped string is not the same thing as a day", () => {
    // The regex succ-7 and succ-8 carry accepts every one of these.
    for (const value of [
        "2026-99-99",
        "2026-13-01",
        "2026-00-10",
        "2026-02-30",
        "2026-02-29",
        "2026-04-31",
    ]) {
        assert.equal(isCalendarDay(value), false, `${value} was accepted`);
    }
});

test("real days pass, and near-misses of the shape do not", () => {
    for (const value of ["2026-09-04", "2024-02-29", "2000-02-29", "1999-12-31"]) {
        assert.equal(isCalendarDay(value), true, `${value} was rejected`);
    }
    for (const value of [
        "2026-1-01",
        "2026-01-1",
        "26-01-01",
        "2026-01-01T00:00:00Z",
        "",
        " ",
        "soon",
    ]) {
        assert.equal(isCalendarDay(value), false, `${value} was accepted`);
    }
    for (const value of [null, undefined, 20260904, new Date(), {}]) {
        assert.equal(isCalendarDay(value), false);
    }
});

/* --------------------------------------------- the subtype review record -- */

const review = (overrides = {}) => ({
    status: "ai_draft",
    reviewer: null,
    reviewedAt: null,
    method: "read in full",
    ...overrides,
});

test("a confirmation with nobody's name on it is not a confirmation", () => {
    // The hole this closes. Editing one string from `ai_draft` to
    // `human_confirmed`, leaving both other fields null, unlocked the freeze
    // gate — so the whole protection was a word. Both assistant_only arms sit
    // on 38 of a floor of 38, and these three rows are what puts them there.
    const problems = subtypeReviewProblems(review({ status: "human_confirmed" }));
    assert.equal(problems.length, 2, problems.join(" / "));
    assert.match(problems.join(" "), /no reviewer/);
    assert.match(problems.join(" "), /no day it happened/);
});

test("a hyphen is not a name", () => {
    // The one-character-wide version of the same hole. `human_confirmed` with
    // `reviewer: "-"` and a real date passed every check, so a placeholder
    // somebody typed to fill the field counted as a confirmation.
    for (const reviewer of ["-", "--", "-a", "a-", "@-", "@", "", " ", "has space", "@@x", null]) {
        const problems = subtypeReviewProblems(
            review({ status: "human_confirmed", reviewer, reviewedAt: "2026-09-04" })
        );
        assert.equal(problems.length, 1, `${JSON.stringify(reviewer)} was accepted`);
        assert.match(problems[0], /no reviewer/);
    }
    // Hyphens inside a handle are ordinary, and both spellings this repository
    // already uses have to keep working: the frozen subtype table's reviewer
    // is `mposition` and succ-8's approval is `@mposition`.
    for (const reviewer of ["mposition", "@mposition", "a-b", "@a-b-c", "m"]) {
        assert.deepEqual(
            subtypeReviewProblems(
                review({ status: "human_confirmed", reviewer, reviewedAt: "2026-09-04" })
            ),
            [],
            `${reviewer} was rejected`
        );
    }
});

test("a confirmation needs a day that exists, not a date-shaped one", () => {
    assert.deepEqual(
        subtypeReviewProblems(
            review({
                status: "human_confirmed",
                reviewer: "@mposition",
                reviewedAt: "2026-09-04",
            })
        ),
        []
    );
    for (const reviewedAt of ["2026-99-99", "2026-02-30", "", "later"]) {
        const problems = subtypeReviewProblems(
            review({ status: "human_confirmed", reviewer: "@mposition", reviewedAt })
        );
        assert.equal(problems.length, 1, `${reviewedAt}: ${problems.join(" / ")}`);
    }
});

test("a draft carries nobody's name either", () => {
    // The other direction. It costs nothing and it catches a record halfway
    // through being written, where the half that is filled in means something
    // the status denies.
    assert.deepEqual(subtypeReviewProblems(review()), []);
    assert.equal(subtypeReviewProblems(review({ reviewer: "@mposition" })).length, 1);
    assert.equal(subtypeReviewProblems(review({ reviewedAt: "2026-09-04" })).length, 1);
});

test("an unknown status is refused rather than read as a draft", () => {
    // Anything that is not one of the two states has to fail closed. Reading
    // an unknown word as "not confirmed" is right and reading it as
    // "confirmed" is the failure, but neither should happen silently.
    const problems = subtypeReviewProblems(review({ status: "reviewed" }));
    assert.equal(problems.length, 1);
    assert.match(problems[0], /status is unknown/);
});

test("the shipped review record is a confirmation with a name and a day on it", () => {
    // Confirmed 2026-09-04. The assertions are the ones the state has to
    // satisfy rather than the literal it holds: a name that is a name, a day
    // that exists, and no problem reported.
    assert.deepEqual([...subtypeReviewProblems(SUCC9_SUBTYPE_REVIEW)], []);
    assert.equal(SUCC9_SUBTYPE_REVIEW.status, "human_confirmed");
    assert.equal(isCalendarDay(SUCC9_SUBTYPE_REVIEW.reviewedAt), true);
    // The shared judgement, not a second copy of it. The copy that stood here
    // required two characters and so disagreed with `isReviewerHandle()` about
    // a one-letter handle — a test that restates a rule tests its restatement.
    assert.equal(isReviewerHandle(SUCC9_SUBTYPE_REVIEW.reviewer), true);
});

test("confirming the subtype rows did not freeze the dataset", () => {
    // The two are separate approvals and were given separately: the
    // confirmation covers the three subtype rows, and the freeze covers the
    // sample and its digests. `human_confirmed` is what `succ9Problems()`
    // requires *before* a freeze, never a substitute for one.
    assert.equal(MEMORY_EVAL_SUCC9_DATASET_FROZEN, false);
});

test("the reviewer rule lives in one place and both paths use it", () => {
    // Two paths judge a reviewer's name: the subtype review record and the
    // dataset approval. The second kept its own `/^@[A-Za-z0-9-]+$/` after the
    // first was tightened, so `@-`, `@--` and `@a-` signed a dataset while
    // being refused as a subtype confirmation. Whichever spelling is right,
    // having two is what let a fix reach only one of them.
    for (const punctuation of ["@-", "@--", "@a-", "-", "@", "@@", "-@-"]) {
        assert.equal(
            isReviewerHandle(punctuation),
            false,
            `${punctuation} was accepted as a name`
        );
    }
    for (const name of ["@mposition", "mposition", "a-b", "m"]) {
        assert.equal(isReviewerHandle(name), true, `${name} was rejected`);
    }

    // And structurally: nothing in succ-9's own files defines a second one.
    // Read as source, because the branch that judges the dataset approval only
    // runs once all five signature fields are filled, and the tree is unsigned
    // — a test that could only observe it after a signature is a test that
    // arrives too late to prevent one.
    const files = [
        "scripts/check-memory-eval-succ9.mjs",
        "lib/memoryEvalSucc9.ts",
        "lib/memoryEvalSucc9Subtypes.ts",
    ];
    let definitions = 0;
    for (const path of files) {
        const source = readFileSync(path, "utf8");
        for (const line of source.split("\n")) {
            // The rule's own definition is the one line allowed to spell it.
            if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) {
                continue;
            }
            if (/\[A-Za-z0-9-\]/.test(line)) definitions += 1;
        }
    }
    assert.equal(definitions, 1, `${definitions} handle patterns across ${files.join(", ")}`);
    assert.match(
        readFileSync("scripts/check-memory-eval-succ9.mjs", "utf8"),
        /isReviewerHandle\(MEMORY_EVAL_SUCC9_APPROVAL\.approvedBy\)/,
        "the dataset approval does not use the shared rule"
    );
});

/* ------------------------------------------------------ grounds and rows -- */

test("every declared ground is a span of a user turn in its own case", () => {
    assert.deepEqual([...succ9SubtypeProblems(MEMORY_EVAL_SUCC9_CASES)], []);
    // Red-before-green: the same check against cases whose text is gone.
    const withoutText = MEMORY_EVAL_SUCC9_CASES.map((testCase) =>
        SUCC9_ASSISTANT_ONLY_SUBTYPES[testCase.id]
            ? { ...testCase, conversations: [] }
            : testCase
    );
    assert.equal(
        succ9SubtypeProblems(withoutText).length,
        Object.keys(SUCC9_ASSISTANT_ONLY_SUBTYPES).length
    );
});

/* -------------------------------------------------------------- repairs -- */

test("exactly one transition is a repair, and it states what it repairs", () => {
    const repairs = SUCC9_TRANSITION.filter((row) => row.transitionType === "repair");
    assert.equal(repairs.length, 1);
    assert.equal(repairs[0].replacement, "succ-durable-ko-701");
    assert.match(repairs[0].repairs ?? "", /exhaustive/);
    // And every same_boundary row states none, so the field cannot drift into
    // prose everybody writes and nobody reads.
    for (const row of SUCC9_TRANSITION) {
        if (row.transitionType === "same_boundary") assert.equal(row.repairs, null);
    }
});

test("the repaired case carries the gold its original was missing", () => {
    const ko701 = MEMORY_EVAL_SUCC9_CASES.find(
        (testCase) => testCase.id === "succ-durable-ko-701"
    );
    assert.equal(ko701.goldCompleteness, "exhaustive");
    assert.equal(ko701.expected.length, 3);
    assert.deepEqual(
        ko701.expected.map((gold) => `${gold.kind}/${gold.polarity}`).sort(),
        ["expertise/affirmed", "expertise/negated", "long_term_goal/affirmed"]
    );
    // The affirmed one is the repair: it claims the fact the user's own turn
    // states and no gold used to.
    const affirmed = ko701.expected.find(
        (gold) => gold.kind === "expertise" && gold.polarity === "affirmed"
    );
    const turn = ko701.conversations[0].messages.find(
        (message) => message.externalMessageId === affirmed.evidence.evidenceMessageId
    );
    assert.equal(turn.role, "user");
    assert.ok(turn.content.includes(affirmed.evidence.evidenceQuote));
    for (const value of affirmed.factValueAll) {
        assert.ok(turn.content.includes(value), `${value} is not in its own turn`);
    }
});

test("the dataset as shipped has no structural problems", () => {
    assert.deepEqual([...succ9Problems()], []);
});
