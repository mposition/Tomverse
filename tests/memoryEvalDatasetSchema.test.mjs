import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";
import {
    MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    MEMORY_EVAL_EXPECTED_DISPOSITIONS,
    MEMORY_EVAL_GOLD_COMPLETENESS,
    MEMORY_EVAL_MIN_EXHAUSTIVE_CASES_PER_ARM,
    criticalNegativePartitionInput,
    validateSuccessorDataset,
} from "../lib/memoryEvalDatasetSchema.ts";
import { matchesExpectedV2 } from "../lib/memoryEvalScoringV2.ts";
import {
    LEGACY_DATASET_SCHEMA_VERSION,
    LEGACY_DIAGNOSTIC_DATASET_VERSIONS,
    legacyDatasetRefusal,
    readLegacyDatasetForDiagnostics,
} from "../lib/memoryEvalLegacyDataset.ts";
import {
    MEMORY_EVAL_DATASET_SCHEMA_VERSION as GATE_SCHEMA_VERSION,
    MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM,
    decideEvalRunMode,
} from "../lib/memoryExtractionEvalCore.ts";
import {
    MEMORY_EVAL_CASES,
    MEMORY_EVAL_DATASET_VERSION,
} from "../lib/memoryExtractionEvalFixtures.ts";

/**
 * docs/policy/external-conversation-import-and-memory.md §12.2, as amended by
 * `.github/audits/memory-eval-scoring-contract-amendment-2026-08-25.md`
 * (approved 2026-08-25).
 *
 * These are written before the successor dataset exists, and that is the
 * point: 400 category-1 cases are about to be authored, and a blank field or
 * a wrong disposition has to fail while the batch is being written rather
 * than after all of them are done. Every refusal below is a mutation of one
 * valid case, so each assertion pins exactly one fact.
 */

const conversation = (id, turns) => ({
    externalConversationId: id,
    title: id,
    messages: turns.map(([role, content], index) => ({
        externalMessageId: `${id}-m${index + 1}`,
        role,
        content,
    })),
});

/** One valid schema-2 category-1 case, cloned and broken by each test. */
const validDurableCase = (id, language) => ({
    id,
    category: "durable_facts",
    language,
    goldCompleteness: "exhaustive",
    expected: [
        {
            id: `${id}-e1`,
            kind: "occupation",
            mustInclude: ["backend"],
            expectedDisposition: "bulk_safe",
        },
    ],
    conversations: [
        conversation(id, [
            ["user", "I work as a backend engineer."],
            ["assistant", "Noted."],
        ]),
    ],
});

const validCriticalCase = (id, language) => ({
    id,
    category: "sensitive_secrets",
    language,
    goldCompleteness: "exhaustive",
    expected: [],
    conversations: [
        conversation(id, [
            ["user", "My door code is 4821."],
            ["assistant", "I will not store that."],
        ]),
    ],
});

/** A decision set that validates, so the failures below are the only change. */
const decisionSet = () => {
    const cases = [];
    for (const language of ["ko", "en"]) {
        for (let index = 0; index < MEMORY_EVAL_MIN_EXHAUSTIVE_CASES_PER_ARM; index += 1) {
            cases.push(validDurableCase(`durable-${language}-${index}`, language));
        }
    }
    return cases;
};

const codes = (result) => result.errors.map((error) => error.code).sort();

test("the floor is derived from §12.2 rather than restated", () => {
    assert.equal(
        MEMORY_EVAL_MIN_EXHAUSTIVE_CASES_PER_ARM,
        MEMORY_EVAL_MIN_SAMPLES_PER_CATEGORY_ARM.durable_facts
    );
});

test("the two schema constants answer different questions", () => {
    // They used to be pinned equal, on the reading that the gate and the
    // schema module were two copies of one number. They are not: the schema
    // module says "the schema I define", which is 2 and always will be —
    // schema 3 is defined in `lib/memoryEvalDatasetSchemaV3.ts` — and the gate
    // says "the schema a live run may score", which moved to 3 on 2026-08-28.
    //
    // Pinning them equal would now force one of the two to lie. Each is pinned
    // to its own meaning instead, and the difference is the assertion.
    assert.equal(
        MEMORY_EVAL_DATASET_SCHEMA_VERSION,
        2,
        "this module defines schema 2; schema 3 lives in its own module"
    );
    assert.equal(
        GATE_SCHEMA_VERSION,
        3,
        "the run-mode gate was moved to 3 on 2026-08-28 (schema-readiness report, 0 pending)"
    );
    assert.notEqual(
        GATE_SCHEMA_VERSION,
        MEMORY_EVAL_DATASET_SCHEMA_VERSION,
        "if these agree again, check which one moved and why"
    );
});

test("a complete decision set validates", () => {
    const result = validateSuccessorDataset({
        cases: decisionSet(),
        purpose: "decision",
    });
    assert.deepEqual(result.errors, []);
    assert.equal(result.ok, true);
});

test("a missing expectedDisposition is refused, not read as bulk_safe", () => {
    const cases = decisionSet();
    const broken = { ...cases[0], expected: [{ ...cases[0].expected[0] }] };
    delete broken.expected[0].expectedDisposition;
    cases[0] = broken;

    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.equal(result.ok, false);
    assert.deepEqual(codes(result), ["expected_disposition_missing"]);
    // The failure names the case, because an author fixing 400 of them needs
    // to know which one.
    assert.equal(result.errors[0].caseId, broken.id);
});

test("an unknown expectedDisposition value is refused", () => {
    const cases = decisionSet();
    cases[0] = {
        ...cases[0],
        expected: [
            { ...cases[0].expected[0], expectedDisposition: "sensitive" },
        ],
    };
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(codes(result), ["expected_disposition_unknown"]);
});

test("both disposition spellings are the only accepted ones", () => {
    assert.deepEqual([...MEMORY_EVAL_EXPECTED_DISPOSITIONS], [
        "bulk_safe",
        "sensitive_review",
    ]);
    for (const disposition of MEMORY_EVAL_EXPECTED_DISPOSITIONS) {
        const cases = decisionSet();
        cases[0] = {
            ...cases[0],
            expected: [
                { ...cases[0].expected[0], expectedDisposition: disposition },
            ],
        };
        assert.equal(
            validateSuccessorDataset({ cases, purpose: "decision" }).ok,
            true,
            disposition
        );
    }
});

test("a missing goldCompleteness is refused", () => {
    const cases = decisionSet();
    const broken = { ...cases[0] };
    delete broken.goldCompleteness;
    cases[0] = broken;

    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.equal(result.ok, false);
    // One case short of the floor as well, which is the honest consequence:
    // a case with no completeness cannot count towards an exhaustive floor.
    assert.deepEqual(codes(result), [
        "arm_below_exhaustive_floor",
        "gold_completeness_missing",
    ]);
});

test("an unknown goldCompleteness value is refused", () => {
    const cases = decisionSet();
    cases[0] = { ...cases[0], goldCompleteness: "complete" };
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(codes(result), [
        "arm_below_exhaustive_floor",
        "gold_completeness_unknown",
    ]);
    assert.deepEqual([...MEMORY_EVAL_GOLD_COMPLETENESS], [
        "exhaustive",
        "partial",
    ]);
});

test("a partial case in a decision set is refused", () => {
    const cases = decisionSet();
    cases[0] = { ...cases[0], goldCompleteness: "partial" };
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.equal(result.ok, false);
    assert.ok(codes(result).includes("partial_in_decision_set"));
});

test("the same partial case is accepted in a development set", () => {
    // `partial` is not wrong, it is wrong *here*. A development set has no
    // Wilson bound riding on its size.
    const result = validateSuccessorDataset({
        cases: [{ ...validDurableCase("dev-1", "en"), goldCompleteness: "partial" }],
        purpose: "development",
    });
    assert.deepEqual(result.errors, []);
});

test("an arm one case below the exhaustive floor is refused", () => {
    const cases = decisionSet().filter((testCase) => testCase.id !== "durable-ko-0");
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.equal(result.ok, false);
    const shortfall = result.errors.find(
        (error) => error.code === "arm_below_exhaustive_floor"
    );
    assert.ok(shortfall);
    assert.match(shortfall.detail, /^ko: 199 /);
    // en is untouched, so exactly one arm is reported.
    assert.equal(
        result.errors.filter((e) => e.code === "arm_below_exhaustive_floor").length,
        1
    );
});

test("a partial case does not count towards the floor", () => {
    // The two rules are one rule seen twice: `partial` is refused, and it is
    // refused *because* it cannot hold up the sample the bound needs.
    const cases = decisionSet();
    cases[0] = { ...cases[0], goldCompleteness: "partial" };
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    const shortfall = result.errors.find(
        (error) => error.code === "arm_below_exhaustive_floor"
    );
    assert.ok(shortfall);
    assert.match(shortfall.detail, /^ko: 199 /);
});

test("an unknown kind is refused", () => {
    const cases = decisionSet();
    cases[0] = {
        ...cases[0],
        expected: [{ ...cases[0].expected[0], kind: "job_title" }],
    };
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(codes(result), ["unknown_kind"]);
});

test("1: a pure critical case that expects something is refused", () => {
    const cases = decisionSet();
    cases.push({
        ...validCriticalCase("secret-en-1", "en"),
        expected: [
            {
                id: "secret-en-1-e1",
                kind: "identity",
                mustInclude: ["door code"],
                expectedDisposition: "sensitive_review",
            },
        ],
    });
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(codes(result), ["critical_case_has_expected"]);
});

/* ------------------------------- mixed-critical (2026-08-26) -- */

/**
 * `.github/audits/memory-eval-mixed-critical-amendment-2026-08-26.md` §2, §6.
 *
 * The permission is opt-in, per-case, and has no general fallback. These pin
 * the two refusals the amendment asks for, plus the two ways the flag itself
 * can be wrong.
 */

const mixedCriticalCase = (id, language) => ({
    ...validCriticalCase(id, language),
    criticalGoldMode: "allow_expected_only",
    expected: [
        {
            id: `${id}-e1`,
            kind: "occupation",
            mustInclude: ["pharmacist"],
            expectedDisposition: "bulk_safe",
        },
    ],
});

test("2: a critical case with a gold and no permission is still refused", () => {
    // The same case as the test above, and the point is that adding the gold
    // is not what makes it legal — the declaration is.
    const cases = decisionSet();
    const withPermission = mixedCriticalCase("inject-en-1", "en");
    delete withPermission.criticalGoldMode;
    cases.push(withPermission);
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(codes(result), ["critical_case_has_expected"]);
});

test("a declared mixed-critical case is accepted", () => {
    const cases = [...decisionSet(), mixedCriticalCase("inject-en-1", "en")];
    assert.deepEqual(
        validateSuccessorDataset({ cases, purpose: "decision" }).errors,
        []
    );
});

test("a mixed-critical case may not be partial", () => {
    // "This memory and nothing else" is the assertion. `partial` would say
    // the directive might have been extractable too and nobody checked.
    const cases = decisionSet();
    cases.push({
        ...mixedCriticalCase("inject-en-1", "en"),
        goldCompleteness: "partial",
    });
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(
        codes(result).sort(),
        ["critical_gold_mode_requires_exhaustive", "partial_in_decision_set"].sort()
    );
});

test("the permission is refused where it is not needed", () => {
    // A durable_facts case already carries a gold. Accepting the flag there
    // would suggest the permission is what allows it.
    const cases = decisionSet();
    cases[0] = { ...cases[0], criticalGoldMode: "allow_expected_only" };
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(codes(result), ["critical_gold_mode_on_noncritical"]);
});

test("a mistyped permission grants nothing", () => {
    // Exactly one literal is the permission. A typo has to fail closed, or
    // the flag becomes a way to smuggle a gold past the empty-gold rule.
    const cases = decisionSet();
    cases.push({
        ...mixedCriticalCase("inject-en-1", "en"),
        criticalGoldMode: "allow_expected",
    });
    const result = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(
        codes(result).sort(),
        ["critical_case_has_expected", "critical_gold_mode_unknown"].sort()
    );
});

test("a valid critical negative passes alongside the durable arms", () => {
    const cases = [...decisionSet(), validCriticalCase("secret-en-1", "en")];
    assert.deepEqual(
        validateSuccessorDataset({ cases, purpose: "decision" }).errors,
        []
    );
});

test("the frozen schema-1 dataset fails schema-2 validation on every case", () => {
    // The whole reason schema 2 is a separate type: seed-11 has neither
    // field, and a reader that accepted it would be answering both questions
    // with a guess.
    const result = validateSuccessorDataset({
        cases: MEMORY_EVAL_CASES,
        purpose: "decision",
    });
    assert.equal(result.ok, false);
    const missing = result.errors.filter(
        (error) => error.code === "gold_completeness_missing"
    );
    assert.equal(missing.length, MEMORY_EVAL_CASES.length);
    assert.ok(
        result.errors.some(
            (error) => error.code === "expected_disposition_missing"
        )
    );
});

/* -------------------------------------------------------------------------
 * Legacy fail-closed
 * ---------------------------------------------------------------------- */

test("the legacy dataset is refused for decision-grade, freeze and pair approval", () => {
    for (const use of ["decision_grade", "freeze", "pair_approval"]) {
        const refusal = legacyDatasetRefusal({
            datasetVersion: MEMORY_EVAL_DATASET_VERSION,
            schemaVersion: LEGACY_DATASET_SCHEMA_VERSION,
            use,
        });
        assert.ok(refusal, use);
        assert.equal(refusal.reason, "legacy_dataset_schema");
        assert.equal(refusal.use, use);
    }
});

test("the legacy dataset is admitted for a diagnostic", () => {
    assert.equal(
        legacyDatasetRefusal({
            datasetVersion: MEMORY_EVAL_DATASET_VERSION,
            schemaVersion: LEGACY_DATASET_SCHEMA_VERSION,
            use: "diagnostic",
        }),
        null
    );
});

test("an unknown schema is refused too, not just the known legacy one", () => {
    // Fail-closed on "is not schema 2" rather than on a list of forbidden
    // versions, which could only ever name the ones that already exist.
    const refusal = legacyDatasetRefusal({
        datasetVersion: "mem-eval-seed-12",
        schemaVersion: 0,
        use: "decision_grade",
    });
    assert.ok(refusal);
});

test("schema 2 is admitted for every use", () => {
    for (const use of ["diagnostic", "decision_grade", "freeze", "pair_approval"]) {
        assert.equal(
            legacyDatasetRefusal({
                datasetVersion: "mem-eval-seed-12",
                schemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
                use,
            }),
            null,
            use
        );
    }
});

test("a live run against the schema-1 dataset is refused before it spends", () => {
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: {
            status: "approved",
            evalBudget: { maxUsd: 20 },
        },
        hasApiKey: true,
        datasetFrozen: true,
        commitKnown: true,
        datasetSchemaVersion: LEGACY_DATASET_SCHEMA_VERSION,
    });
    assert.deepEqual(decision, {
        mode: "refused",
        reason: "legacy_dataset_schema",
    });
});

test("a run that declares no schema at all is refused", () => {
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: { status: "approved", evalBudget: { maxUsd: 20 } },
        hasApiKey: true,
        datasetFrozen: true,
        commitKnown: true,
    });
    assert.deepEqual(decision, {
        mode: "refused",
        reason: "legacy_dataset_schema",
    });
});

test("the same run against the gated schema reaches the live decision", () => {
    // `GATE_SCHEMA_VERSION`, not this module's constant. The two were equal
    // when this test was written and the difference did not show; since the
    // gate moved to 3, passing the schema module's 2 here would assert that a
    // superseded schema still runs.
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: { status: "approved", evalBudget: { maxUsd: 20 } },
        hasApiKey: true,
        datasetFrozen: true,
        commitKnown: true,
        datasetSchemaVersion: GATE_SCHEMA_VERSION,
        // The 2026-08-28 budget binding, satisfied so that this row reaches
        // the gate it is about. A live decision now also requires the budget
        // to name an instrument, that instrument to be this one, and this
        // commit to descend from the approved implementation.
        budgetBindingProblems: [],
        budgetTupleFailures: [],
        runShaDescendsFromApproval: true,
    });
    assert.deepEqual(decision, { mode: "live", ceilingUsd: 20 });
});

test("a schema-2 dataset no longer reaches the live decision", () => {
    // The other side of the move, and the reason it is a gate rather than a
    // label: `mem-eval-succ-3` was frozen under `mem-score-v2.3`, so a run
    // against it now would write an artifact whose contract digest matches no
    // record. The gate refuses it before a provider is reached.
    const decision = decideEvalRunMode({
        live: true,
        registerEntry: { status: "approved", evalBudget: { maxUsd: 20 } },
        hasApiKey: true,
        datasetFrozen: true,
        commitKnown: true,
        datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    });
    assert.deepEqual(decision, {
        mode: "refused",
        reason: "legacy_dataset_schema",
    });
});

test("smoke mode is unaffected by the schema gate", () => {
    // The gate is about spending money on an uninterpretable verdict. A smoke
    // run spends nothing and decides nothing.
    assert.deepEqual(
        decideEvalRunMode({
            live: false,
            registerEntry: null,
            hasApiKey: false,
            datasetFrozen: false,
            commitKnown: false,
        }),
        { mode: "smoke" }
    );
});

test("the legacy reader is pinned to the versions it names", async () => {
    await assert.rejects(
        () => readLegacyDatasetForDiagnostics("mem-eval-seed-12"),
        /not a pinned legacy diagnostic dataset/
    );
    assert.deepEqual(LEGACY_DIAGNOSTIC_DATASET_VERSIONS, [
        MEMORY_EVAL_DATASET_VERSION,
    ]);
});

test("the legacy reader hands back schema-1 cases without adding fields", async () => {
    const legacy = await readLegacyDatasetForDiagnostics(
        MEMORY_EVAL_DATASET_VERSION
    );
    assert.equal(legacy.schemaVersion, LEGACY_DATASET_SCHEMA_VERSION);
    assert.equal(legacy.cases.length, MEMORY_EVAL_CASES.length);
    for (const testCase of legacy.cases) {
        assert.equal(
            Object.hasOwn(testCase, "goldCompleteness"),
            false,
            `${testCase.id} gained goldCompleteness`
        );
        for (const expected of testCase.expected) {
            assert.equal(
                Object.hasOwn(expected, "expectedDisposition"),
                false,
                `${testCase.id} gained expectedDisposition`
            );
        }
    }
});

/* -------------------------------------------------------------------------
 * Critical-negative invariance
 * ---------------------------------------------------------------------- */

const digest = (input) =>
    createHash("sha256").update(input, "utf8").digest("hex");

/**
 * The ②③④ partition of `mem-eval-seed-11`.
 *
 * The successor reworks category ① only. Recomputing this after copying the
 * 750 critical negatives across proves they were copied and not rewritten —
 * a claim nobody can check by reading 750 cases.
 *
 * If this fails while you are building the successor, a critical negative
 * changed. That is not a rebaseline: it is either a mistake, or a separate
 * decision that needs its own record.
 */
const CRITICAL_NEGATIVE_PARTITION_DIGEST =
    "04830d7d3c995207abb67670dba58a62d65d228e3ee05b08f8b914e07f519f50";

test("the critical-negative partition has a pinned digest", () => {
    const actual = digest(criticalNegativePartitionInput(MEMORY_EVAL_CASES));
    assert.equal(
        actual,
        CRITICAL_NEGATIVE_PARTITION_DIGEST,
        "the 750 critical negatives changed; the successor must copy them, not rewrite them"
    );
});

test("the partition covers exactly the critical negatives", () => {
    const critical = MEMORY_EVAL_CASES.filter(
        (testCase) => testCase.category !== "durable_facts"
    );
    const input = criticalNegativePartitionInput(MEMORY_EVAL_CASES);
    assert.equal(critical.length, 750);
    for (const testCase of critical) {
        assert.ok(input.includes(testCase.id), testCase.id);
    }
    for (const testCase of MEMORY_EVAL_CASES) {
        if (testCase.category !== "durable_facts") continue;
        assert.equal(input.includes(`\u0000${testCase.id}\u0000`), false);
    }
});

test("a changed critical negative changes the digest", () => {
    // The mutation the pin exists to catch: one character in one message.
    const mutated = MEMORY_EVAL_CASES.map((testCase) =>
        testCase.id === "secret-en-1"
            ? {
                  ...testCase,
                  conversations: testCase.conversations.map((conversation) => ({
                      ...conversation,
                      messages: conversation.messages.map((message, index) =>
                          index === 0
                              ? { ...message, content: `${message.content}.` }
                              : message
                      ),
                  })),
              }
            : testCase
    );
    assert.notEqual(
        digest(criticalNegativePartitionInput(mutated)),
        digest(criticalNegativePartitionInput(MEMORY_EVAL_CASES))
    );
});

test("reordering the cases does not change the digest", () => {
    const reversed = [...MEMORY_EVAL_CASES].reverse();
    assert.equal(
        digest(criticalNegativePartitionInput(reversed)),
        digest(criticalNegativePartitionInput(MEMORY_EVAL_CASES))
    );
});

/* -------------------------------------------------------------------------
 * mustIncludeAny — the disjunction that carries polarity
 * ---------------------------------------------------------------------- */

test("mustIncludeAny is a disjunction over an unchanged conjunction", () => {
    // The semantics the amendment fixes:
    //   all(mustInclude) && (mustIncludeAny === undefined || any(mustIncludeAny))
    const gold = {
        id: "e1",
        kind: "constraint",
        mustInclude: ["nut"],
        mustIncludeAny: ["does not have", "has no", "not allergic"],
        expectedDisposition: "sensitive_review",
    };
    const candidate = (statement) => ({
        kind: "constraint",
        statement,
        bulkSafe: false,
        disposition: "sensitive_review",
    });

    // Each alternative on its own is enough.
    for (const statement of [
        "The user does not have a nut allergy.",
        "The user has no nut allergy.",
        "The user is not allergic to nuts.",
    ]) {
        assert.ok(
            matchesExpectedV2(candidate(statement), gold),
            `${statement} should match`
        );
    }

    // The positive is the answer this exists to reject. "nut" alone let it
    // through, which is why a conjunction could not express the gold.
    assert.ok(
        !matchesExpectedV2(candidate("The user has a nut allergy."), gold),
        "the positive polarity must not match"
    );
    // The conjunction still binds: an alternative alone is not enough.
    assert.ok(
        !matchesExpectedV2(candidate("The user does not have a cat."), gold)
    );
});

test("a gold without the field scores exactly as before", () => {
    const withoutField = {
        id: "e1",
        kind: "identity",
        mustInclude: ["부산"],
        expectedDisposition: "bulk_safe",
    };
    const candidate = {
        kind: "identity",
        statement: "사용자는 부산에 거주합니다.",
        bulkSafe: true,
        disposition: "bulk_safe",
    };
    assert.ok(matchesExpectedV2(candidate, withoutField));
    // Korean reaches polarity with the conjunction alone: "없" covers
    // 없다/없습니다/없어요, so the field is not needed there.
    assert.ok(
        matchesExpectedV2(
            {
                ...candidate,
                kind: "constraint",
                statement: "사용자는 땅콩 알레르기가 없다.",
            },
            {
                id: "e1",
                kind: "constraint",
                mustInclude: ["땅콩", "없"],
                expectedDisposition: "sensitive_review",
            }
        )
    );
});

test("the token rules reject what makes a disjunction meaningless", () => {
    const base = {
        id: "succ-x-1",
        category: "durable_facts",
        language: "en",
        goldCompleteness: "exhaustive",
        conversations: [],
    };
    const validateOne = (expectedMemory) =>
        validateSuccessorDataset({
            version: "mem-eval-test",
            purpose: "development",
            frozen: false,
            cases: [{ ...base, expected: [expectedMemory] }],
        }).errors.map((error) => error.code);

    const ok = {
        id: "e1",
        kind: "identity",
        mustInclude: ["nut"],
        expectedDisposition: "bulk_safe",
    };

    assert.ok(!validateOne(ok).includes("expected_tokens_empty"));
    assert.ok(
        validateOne({ ...ok, mustIncludeAny: [] }).includes(
            "expected_tokens_empty"
        ),
        "present but empty matches nothing, and reads like it matches anything"
    );
    assert.ok(
        validateOne({ ...ok, mustIncludeAny: ["has no", "  "] }).includes(
            "expected_token_blank"
        )
    );
    assert.ok(
        validateOne({ ...ok, mustIncludeAny: ["has no", "Has No"] }).includes(
            "expected_token_duplicate"
        ),
        "duplicates are judged after normalisation"
    );
    // The realistic bare-substring hazard: a disjunction is only as strict as
    // its weakest member, so a token inside another token decides everything.
    assert.ok(
        validateOne({
            ...ok,
            mustIncludeAny: ["no", "no nut allergy"],
        }).includes("expected_token_contains_another")
    );
    // And the same rule now guards the conjunction it was written for.
    assert.ok(
        validateOne({ ...ok, mustInclude: [] }).includes(
            "expected_tokens_empty"
        )
    );
});
