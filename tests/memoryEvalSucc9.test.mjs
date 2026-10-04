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
    MEMORY_EVAL_SUCC9_APPROVAL,
    MEMORY_EVAL_SUCC9_CASES,
    MEMORY_EVAL_SUCC9_DATASET_FROZEN,
    MEMORY_EVAL_SUCC9_MANIFEST,
    buildSucc9Manifest,
    freezePreconditionProblems,
    succ9Problems,
    succ9SignatureProblems,
    verifySucc9Manifest,
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

test("a freeze standing on a draft subtype reading is refused", () => {
    // The refusal that matters, and the one nothing exercised until now: the
    // earlier version of this test asserted the tree's two states and called
    // the dependency between them "the assertion that matters" without ever
    // running it. Both conditions read module constants, so the only reachable
    // combination was the good one — and a rule you can only observe passing
    // is a rule you have not tested.
    //
    // Both `assistant_only` arms sit on 38 of a floor of 38, so the three
    // subtype rows decide whether succ-9 meets
    // docs/ops/memory-extraction-eval-dataset.md §3.3 at all. Freezing on an
    // AI's reading of them is the state this refuses.
    const frozenOnDraft = freezePreconditionProblems({
        frozen: true,
        subtypeReviewStatus: "ai_draft",
        approvedBy: "@mposition",
    });
    assert.equal(frozenOnDraft.length, 1, frozenOnDraft.join(" / "));
    assert.match(frozenOnDraft[0], /frozen while the subtype reading is still ai_draft/);

    // An unknown status is refused too — reading a word nobody defined as
    // "confirmed" is the failure, and it must not be reachable by typo.
    assert.equal(
        freezePreconditionProblems({
            frozen: true,
            subtypeReviewStatus: "reviewed",
            approvedBy: "@mposition",
        }).length,
        1
    );

    // A freeze with nobody's name on it, and both defects together.
    assert.match(
        freezePreconditionProblems({
            frozen: true,
            subtypeReviewStatus: "human_confirmed",
            approvedBy: null,
        })[0],
        /frozen with nobody's name on it/
    );
    assert.equal(
        freezePreconditionProblems({
            frozen: true,
            subtypeReviewStatus: "ai_draft",
            approvedBy: null,
        }).length,
        2
    );

    // The state the tree is actually in, and the state it passed through to
    // get here. Unfrozen is unchecked in either direction: a draft reading on
    // an unfrozen dataset is the ordinary way to this point.
    assert.deepEqual(
        [
            ...freezePreconditionProblems({
                frozen: true,
                subtypeReviewStatus: "human_confirmed",
                approvedBy: "@mposition",
            }),
        ],
        []
    );
    for (const subtypeReviewStatus of ["ai_draft", "human_confirmed"]) {
        for (const approvedBy of [null, "@mposition"]) {
            assert.deepEqual(
                [...freezePreconditionProblems({ frozen: false, subtypeReviewStatus, approvedBy })],
                []
            );
        }
    }
});

test("a complete signature over an unfrozen dataset is refused", () => {
    // The other half of the coupling, and the half that stayed unreachable
    // after the first was fixed: `frozen` was read from the module here, so
    // the combination could not be built. It is the direction a tree does not
    // stay in for long — five fields filled, `frozen` still false — and that
    // is exactly why nothing would have noticed it going unchecked.
    //
    // What it costs: the digests a signature names stop meaning anything the
    // next time a case moves, and nothing in the record would say so.
    const problems = succ9SignatureProblems(
        MEMORY_EVAL_SUCC9_APPROVAL,
        MEMORY_EVAL_SUCC9_MANIFEST,
        false
    );
    assert.equal(problems.length, 1, problems.join(" / "));
    assert.match(problems[0], /complete and the dataset is not frozen/);

    // Frozen with an empty approval, the mirror image, also reachable now.
    const empty = {
        ...MEMORY_EVAL_SUCC9_APPROVAL,
        approvedBy: null,
        approvedAt: null,
        approvedCommit: null,
        signedDatasetDigest: null,
        signedManifestDigest: null,
    };
    assert.match(
        succ9SignatureProblems(empty, MEMORY_EVAL_SUCC9_MANIFEST, true)[0],
        /frozen and the approval is empty/
    );

    // And the two legitimate states, both ways round.
    assert.deepEqual(
        [...succ9SignatureProblems(empty, MEMORY_EVAL_SUCC9_MANIFEST, false)],
        [],
        "unsigned and unfrozen is the ordinary state before an approval"
    );
    assert.deepEqual(
        [
            ...succ9SignatureProblems(
                MEMORY_EVAL_SUCC9_APPROVAL,
                MEMORY_EVAL_SUCC9_MANIFEST,
                true
            ),
        ],
        [],
        "signed and frozen is the tree's own state"
    );
});

test("the confirmation and the freeze are separate approvals", () => {
    // They were given separately: the confirmation covers the three subtype
    // rows, the freeze covers the sample and its two digests. Both are present
    // now, and `succ9Problems()` carries the dependency between them into the
    // tree's own values.
    assert.equal(SUCC9_SUBTYPE_REVIEW.status, "human_confirmed");
    assert.equal(MEMORY_EVAL_SUCC9_DATASET_FROZEN, true);
    assert.deepEqual([...succ9Problems()], []);
    // A well-formed draft is a legitimate state on its own — it is the freeze
    // that it cannot support.
    const draftReview = {
        ...SUCC9_SUBTYPE_REVIEW,
        status: "ai_draft",
        reviewer: null,
        reviewedAt: null,
    };
    assert.deepEqual([...subtypeReviewProblems(draftReview)], []);
});

/* --------------------------------------------------------- the freeze -- */

test("the pinned manifest is this tree's, and hashes to its own digest", () => {
    assert.deepEqual([...verifySucc9Manifest()], []);
    // Not two builder calls agreeing with each other: the literal is compared
    // with what the tree computes, and it is the literal a signature names.
    const built = buildSucc9Manifest();
    assert.equal(MEMORY_EVAL_SUCC9_MANIFEST.datasetDigest, built.datasetDigest);
    assert.equal(MEMORY_EVAL_SUCC9_MANIFEST.manifestDigest, built.manifestDigest);
    assert.equal(MEMORY_EVAL_SUCC9_MANIFEST.subtypeDigest, built.subtypeDigest);
    assert.equal(MEMORY_EVAL_SUCC9_MANIFEST.caseCount, 1150);
});

test("a pinned field edited without its digest is caught", () => {
    // succ-7 shipped `caseCount: 999` verifying clean, because the check
    // compared digest strings and a digest string is not the record.
    const tampered = { ...MEMORY_EVAL_SUCC9_MANIFEST, caseCount: 999 };
    const problems = verifySucc9Manifest(tampered);
    assert.ok(problems.some((line) => /does not hash to its own manifestDigest/.test(line)));
    assert.ok(problems.some((line) => /caseCount: recorded 999/.test(line)));
});

test("the signature is complete, and names this record's digests", () => {
    assert.deepEqual([...succ9SignatureProblems()], []);
    assert.equal(
        MEMORY_EVAL_SUCC9_APPROVAL.signedDatasetDigest,
        MEMORY_EVAL_SUCC9_MANIFEST.datasetDigest
    );
    assert.equal(
        MEMORY_EVAL_SUCC9_APPROVAL.signedManifestDigest,
        MEMORY_EVAL_SUCC9_MANIFEST.manifestDigest
    );
    assert.equal(isCalendarDay(MEMORY_EVAL_SUCC9_APPROVAL.approvedAt), true);
    assert.match(MEMORY_EVAL_SUCC9_APPROVAL.approvedCommit ?? "", /^[0-9a-f]{40}$/);
});

test("a partial signature is refused rather than read as mostly signed", () => {
    for (const field of [
        "approvedBy",
        "approvedAt",
        "approvedCommit",
        "signedDatasetDigest",
        "signedManifestDigest",
    ]) {
        for (const value of [null, "", "   "]) {
            const problems = succ9SignatureProblems(
                { ...MEMORY_EVAL_SUCC9_APPROVAL, [field]: value },
                MEMORY_EVAL_SUCC9_MANIFEST
            );
            assert.equal(problems.length, 1, `${field}=${JSON.stringify(value)}`);
            assert.match(problems[0], /partly filled \(4 of 5 fields\)/);
        }
    }
});

test("a signature over a digest that is not the pinned one is refused", () => {
    // The failure the literal exists to make visible: a signature that agrees
    // with a recomputed value agrees with whatever the tree says today.
    const zero = "0".repeat(64);
    assert.match(
        succ9SignatureProblems(
            { ...MEMORY_EVAL_SUCC9_APPROVAL, signedDatasetDigest: zero },
            MEMORY_EVAL_SUCC9_MANIFEST
        )[0],
        /signedDatasetDigest is not the pinned record's/
    );
    assert.match(
        succ9SignatureProblems(
            { ...MEMORY_EVAL_SUCC9_APPROVAL, signedManifestDigest: zero },
            MEMORY_EVAL_SUCC9_MANIFEST
        )[0],
        /signedManifestDigest is not the pinned record's/
    );
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

    // The dataset approval path, exercised directly. It reached the same
    // judgement through a copy of the pattern that accepted `@-`, and the fix
    // was to have one rule; this asserts the path, not the spelling.
    const signed = { ...MEMORY_EVAL_SUCC9_APPROVAL };
    for (const approvedBy of ["@-", "@--", "@a-", "-", "@"]) {
        const problems = succ9SignatureProblems(
            { ...signed, approvedBy },
            MEMORY_EVAL_SUCC9_MANIFEST
        );
        assert.equal(problems.length, 1, `${approvedBy}: ${problems.join(" / ")}`);
        assert.match(problems[0], /approvedBy is not a handle/);
    }
    for (const approvedBy of ["@mposition", "mposition"]) {
        assert.deepEqual(
            succ9SignatureProblems({ ...signed, approvedBy }, MEMORY_EVAL_SUCC9_MANIFEST),
            [],
            `${approvedBy} was rejected`
        );
    }

    // And structurally: nothing in succ-9's own files defines a second one.
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
