import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_EVAL_REPLACEMENT_PLAN } from "../lib/memoryEvalSuccessorAdopted/replacementPlan.ts";
import { MEMORY_EVAL_REGRESSION_PROVENANCE } from "../lib/memoryEvalRegressionCorpus/provenance.ts";
import { MEMORY_EVAL_SUCCESSOR_CASES } from "../lib/memoryEvalSuccessorFixtures.ts";
import { SUCCESSOR_ADOPTED_BATCHES } from "../lib/memoryEvalSuccessorAdopted/index.ts";
import { TRANCHE_1_SUCCESSORS } from "../lib/memoryEvalSuccessorAdopted/tranche1Successors.ts";
import { TRANCHE_2_SUCCESSORS } from "../lib/memoryEvalSuccessorAdopted/tranche2Successors.ts";
import { validateSuccessorDataset } from "../lib/memoryEvalDatasetSchema.ts";
import {
    assessSampleAdequacy,
    findDuplicateCases,
} from "../lib/memoryExtractionEvalCore.ts";
import { nearDuplicatePairs } from "../lib/memoryEvalNearDuplicates.ts";
import { buildExtractionPrompt } from "../lib/memoryExtractionPrompt.ts";
import { BATCH_133_INJECTION_KO } from "../lib/memoryEvalSuccessorAdopted/batch133InjectionKo.ts";
import { BATCH_134_INJECTION_EN } from "../lib/memoryEvalSuccessorAdopted/batch134InjectionEn.ts";
import { BATCH_135_SECRET_KO } from "../lib/memoryEvalSuccessorAdopted/batch135SecretKo.ts";
import { BATCH_136_SECRET_EN } from "../lib/memoryEvalSuccessorAdopted/batch136SecretEn.ts";
import { BATCH_162_DURABLE_KO } from "../lib/memoryEvalSuccessorAdopted/batch162DurableKo.ts";
import { BATCH_163_DURABLE_EN } from "../lib/memoryEvalSuccessorAdopted/batch163DurableEn.ts";
import { BATCH_164_ASSISTANT_KO } from "../lib/memoryEvalSuccessorAdopted/batch164AssistantKo.ts";
import { BATCH_165_ASSISTANT_EN } from "../lib/memoryEvalSuccessorAdopted/batch165AssistantEn.ts";

/**
 * `mem-eval-succ-3`, checked before it is wired.
 *
 * None of this is in the canonical registry yet, and that is deliberate: an
 * incomplete succ-3 must not exist as a valid dataset even briefly. What these
 * tests do is prove the pieces compose into a set that would pass every check
 * the registry applies — so the wiring, when it happens, is a swap rather than
 * a discovery.
 */

const REPLACEMENT_BATCHES = [
    BATCH_133_INJECTION_KO,
    BATCH_134_INJECTION_EN,
    BATCH_135_SECRET_KO,
    BATCH_136_SECRET_EN,
    BATCH_162_DURABLE_KO,
    BATCH_163_DURABLE_EN,
    BATCH_164_ASSISTANT_KO,
    BATCH_165_ASSISTANT_EN,
];
const REPLACEMENTS = REPLACEMENT_BATCHES.flat();
const SUCCESSORS = [...TRANCHE_1_SUCCESSORS, ...TRANCHE_2_SUCCESSORS];

const succ2ById = new Map(MEMORY_EVAL_SUCCESSOR_CASES.map((c) => [c.id, c]));
const replacementById = new Map(REPLACEMENTS.map((c) => [c.id, c]));
const cellOf = (testCase) => `${testCase.category}:${testCase.language}`;

/** succ-3 as it would be: successors where one exists, plus the replacements. */
const composeSucc3 = () => {
    const byReplaced = new Map(SUCCESSORS.map((s) => [s.replacesBatchId, s]));
    return [
        ...SUCCESSOR_ADOPTED_BATCHES.flatMap(
            (batch) => (byReplaced.get(batch.id) ?? batch).cases
        ),
        ...REPLACEMENTS,
    ];
};

/* ------------------------------------------------------------- the plan -- */

test("the plan covers exactly the 99 cases that move, once each", () => {
    assert.equal(MEMORY_EVAL_REPLACEMENT_PLAN.length, 99);

    const planned = MEMORY_EVAL_REPLACEMENT_PLAN.map((e) => e.originalId);
    const moving = MEMORY_EVAL_REGRESSION_PROVENANCE.map((e) => e.originalId);
    assert.deepEqual(
        [...planned].sort(),
        [...moving].sort(),
        "the plan and the provenance disagree about which cases move"
    );
    assert.equal(new Set(planned).size, 99, "an original is planned twice");

    const replacements = MEMORY_EVAL_REPLACEMENT_PLAN.map((e) => e.replacementId);
    assert.equal(new Set(replacements).size, 99, "a replacement is used twice");
});

test("every planned id is a full case id, never a batch-local shorthand", () => {
    // `ko-79` is unambiguous inside a durable_facts:ko file and ambiguous
    // anywhere else. Reading one for the other has already produced a wrong
    // count once.
    for (const entry of MEMORY_EVAL_REPLACEMENT_PLAN) {
        for (const id of [entry.originalId, entry.replacementId]) {
            assert.match(
                id,
                /^succ-(durable|assistant|secret|injection)-(ko|en)-\d+$/,
                `${id} is not a full case id`
            );
        }
    }
});

test("each replacement exists, is new, and sits in its original's cell", () => {
    for (const { originalId, replacementId } of MEMORY_EVAL_REPLACEMENT_PLAN) {
        const original = succ2ById.get(originalId);
        assert.ok(original, `${originalId} is not in succ-2`);

        const replacement = replacementById.get(replacementId);
        assert.ok(replacement, `${replacementId} is not in a replacement batch`);

        assert.ok(
            !succ2ById.has(replacementId),
            `${replacementId} collides with a succ-2 case id`
        );
        assert.equal(
            cellOf(replacement),
            cellOf(original),
            `${replacementId} would move ${cellOf(original)} below its floor`
        );
    }
    assert.equal(REPLACEMENTS.length, 99, "there are replacements nobody planned");
});

test("provenance stays unfilled until the wiring happens", () => {
    // The separation test reads `replacementId !== null` as "this case has
    // left the decision set". Filling it in early would claim a migration
    // that has not happened, and the two checks would disagree about the
    // state of the corpus.
    const filled = MEMORY_EVAL_REGRESSION_PROVENANCE.filter(
        (entry) => entry.replacementId !== null
    );
    assert.deepEqual(
        filled.map((entry) => entry.originalId),
        [],
        "a provenance entry claims a replacement while its case is still in the decision set"
    );
});

/* ------------------------------------------------------- the successors -- */

test("one successor per affected batch, and only for affected batches", () => {
    assert.equal(SUCCESSORS.length, 25);
    const targets = SUCCESSORS.map((s) => s.replacesBatchId);
    assert.equal(new Set(targets).size, 25, "two successors claim one batch");

    const moving = new Set(
        MEMORY_EVAL_REGRESSION_PROVENANCE.map((e) => e.originalId)
    );
    const affected = SUCCESSOR_ADOPTED_BATCHES.filter((batch) =>
        batch.cases.some((testCase) => moving.has(testCase.id))
    ).map((batch) => batch.id);
    assert.deepEqual([...targets].sort(), [...affected].sort());
});

test("successors drop exactly the moving cases and keep the rest by identity", () => {
    const moving = new Set(
        MEMORY_EVAL_REGRESSION_PROVENANCE.map((e) => e.originalId)
    );
    const byId = new Map(SUCCESSOR_ADOPTED_BATCHES.map((b) => [b.id, b]));
    let survivors = 0;
    for (const successor of SUCCESSORS) {
        const source = byId.get(successor.replacesBatchId);
        assert.ok(source, `${successor.id} names an unknown batch`);

        const dropped = source.cases.filter((c) => moving.has(c.id));
        assert.deepEqual(
            [...successor.excludedCaseIds].sort(),
            dropped.map((c) => c.id).sort(),
            `${successor.id} drops the wrong cases`
        );
        for (const testCase of successor.cases) {
            // The same object, not an equal one: nothing was transcribed.
            assert.ok(
                source.cases.includes(testCase),
                `${successor.id} rebuilt ${testCase.id} instead of keeping it`
            );
            survivors += 1;
        }
    }
    // The 25 affected batches hold 867 cases between them; 99 leave and 768
    // stay. Stated as both numbers so a successor that silently dropped an
    // extra case cannot satisfy the identity check alone.
    const affectedTotal = SUCCESSORS.reduce(
        (n, successor) => n + byId.get(successor.replacesBatchId).cases.length,
        0
    );
    assert.equal(affectedTotal, 867);
    assert.equal(survivors, 768);
    assert.equal(survivors + 99, affectedTotal);
});

/* -------------------------------------------------- the composed dataset -- */

test("succ-3 composes to 1,150 cases with every moved case gone", () => {
    const cases = composeSucc3();
    assert.equal(cases.length, 1150);

    const ids = new Set(cases.map((c) => c.id));
    assert.equal(ids.size, 1150, "a case id appears twice");

    const stillHere = MEMORY_EVAL_REGRESSION_PROVENANCE.map((e) => e.originalId).filter(
        (id) => ids.has(id)
    );
    assert.deepEqual(stillHere, [], "a rule-authoring case would measure its own rule");

    for (const { replacementId } of MEMORY_EVAL_REPLACEMENT_PLAN) {
        assert.ok(ids.has(replacementId), `${replacementId} is missing from succ-3`);
    }
});

test("succ-3 passes the schema and holds every §12.2 floor", () => {
    const cases = composeSucc3();
    const validation = validateSuccessorDataset({ cases, purpose: "decision" });
    assert.deepEqual(validation.errors, []);
    assert.equal(validation.ok, true);

    const adequacy = assessSampleAdequacy(
        cases.map((c) => ({ caseId: c.id, category: c.category, language: c.language }))
    );
    assert.deepEqual(adequacy.underpowered, []);
});

test("no replacement duplicates a conversation, in either set", () => {
    assert.deepEqual(findDuplicateCases(composeSucc3()), []);
    // Against succ-2 as well: a replacement equal to a case that stays would
    // be a duplicate the moment the two sets were compared.
    assert.deepEqual(
        findDuplicateCases([...MEMORY_EVAL_SUCCESSOR_CASES, ...REPLACEMENTS]),
        []
    );
});

test("a replacement changes the situation rather than the wording", () => {
    // A replacement that only swaps a noun leaves `mem-extract-v5` answering
    // the sentence it was written from. The originals leave the decision set,
    // so nothing mechanical would catch it — this is the check that does.
    const newIds = new Set(REPLACEMENTS.map((c) => c.id));
    const worst = nearDuplicatePairs([...MEMORY_EVAL_SUCCESSOR_CASES, ...REPLACEMENTS])
        .filter((pair) => newIds.has(pair.a) !== newIds.has(pair.b))
        .filter((pair) => pair.token > 0.45);
    assert.deepEqual(
        worst.map((p) => `${p.a}/${p.b} token ${p.token.toFixed(2)}`),
        [],
        "a replacement is a paraphrase of a succ-2 case"
    );

    const internal = nearDuplicatePairs(REPLACEMENTS).filter((p) => p.token > 0.45);
    assert.deepEqual(
        internal.map((p) => `${p.a}/${p.b} token ${p.token.toFixed(2)}`),
        [],
        "two replacements repeat one template"
    );
});

test("a critical replacement carries a gold only with the permission for it", () => {
    const critical = new Set([
        "assistant_only",
        "sensitive_secrets",
        "injection_directives",
    ]);
    let withGold = 0;
    for (const testCase of REPLACEMENTS) {
        if (!critical.has(testCase.category)) {
            assert.equal(
                testCase.criticalGoldMode,
                undefined,
                `${testCase.id} does not need the permission`
            );
            continue;
        }
        const expectsSomething = testCase.expected.length > 0;
        assert.equal(
            testCase.criticalGoldMode === "allow_expected_only",
            expectsSomething,
            `${testCase.id}: the gold and the permission disagree`
        );
        if (expectsSomething) withGold += 1;
    }
    // §4.1's fifteen conditional durable facts, minus the seven whose
    // originals are durable_facts cases: eight in ko, seven in en.
    assert.equal(withGold, 15);
});

test("no replacement utterance is already quoted in the v5 prompt", () => {
    // `tests/memoryEvalPromptDatasetSeparation.test.mjs` runs this over the
    // decision set, which does not contain these cases yet. Running it here
    // too means the wiring cannot be the moment a leak is discovered — and a
    // leak found then would be unfixable in the honest direction, because the
    // prompt is frozen and the case would have to be rewritten to hide it.
    const normalise = (value) =>
        value
            .toLowerCase()
            .replace(/[^\p{L}\p{N}\s]/gu, " ")
            .replace(/\s+/g, " ")
            .trim();
    const RUN_LENGTH = 5;
    const built = buildExtractionPrompt({
        conversations: [
            {
                label: "c1",
                title: "t",
                messages: [{ label: "m1", role: "user", content: "hello" }],
            },
        ],
    });
    const prompt = normalise(`${built.system}\n${built.user}`);

    const leaks = [];
    let compared = 0;
    for (const testCase of REPLACEMENTS) {
        for (const conversation of testCase.conversations) {
            for (const message of conversation.messages) {
                if (message.role !== "user") continue;
                const words = normalise(message.content).split(" ");
                for (let at = 0; at + RUN_LENGTH <= words.length; at += 1) {
                    compared += 1;
                    const run = words.slice(at, at + RUN_LENGTH).join(" ");
                    if (!prompt.includes(run)) continue;
                    leaks.push(`${testCase.id}: "${run}"`);
                    at = words.length;
                }
            }
        }
    }
    // A comparison that ran over nothing would pass silently.
    assert.ok(compared > 500, `only ${compared} runs compared`);
    assert.deepEqual(leaks, [], leaks.join("\n  "));
});
