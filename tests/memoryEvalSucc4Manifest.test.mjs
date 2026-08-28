// succ-4's freeze, and the three conditions that keep the regression corpus
// out of its digest.
//
// The last of those is the reason this file avoids the obvious test. Editing a
// regression fixture from inside a test and re-reading the digest would prove
// the point for exactly one edit, leave the tree dirty if it threw halfway,
// and pass just as well if the digest were computed over nothing at all. The
// three conditions below are stronger and cost nothing: the decision set
// cannot reach the regression corpus, the digest's input is the canonical case
// list and only that, and the two id sets do not intersect -- so there is no
// path by which regression content could reach the number.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";

import {
    MEMORY_EVAL_SUCC4_MANIFEST,
    buildSucc4Manifest,
    buildSucc4Composition,
    verifySucc4Manifest,
    succ4DatasetDigest,
    succ4TransitionManifestDigest,
    succ4ScoringContractDigest,
} from "../lib/memoryEvalSucc4Manifest.ts";
import {
    MEMORY_EVAL_SUCC4_CASES,
    MEMORY_EVAL_SUCC4_REPLACEMENT_CASES,
} from "../lib/memoryEvalSucc4Dataset.ts";
import { SUCC4_REGRESSION_CORPUS } from "../lib/memoryEvalSucc4Regression.ts";
import {
    SUCC4_TRANSITIONS,
    succ4TransitionFingerprintInput,
} from "../lib/memoryEvalSucc4Transition.ts";
import { datasetFingerprintInputV3 } from "../lib/memoryEvalDatasetSchemaV3.ts";
import { datasetFingerprintInput } from "../lib/memoryExtractionEvalCore.ts";
import { evalDatasetManifest } from "../lib/memoryEvalDatasetManifests.ts";
import { MEMORY_EVAL_SCORING_CONTRACT_VERSION } from "../lib/memoryEvalScoringContractDigest.ts";

/* -------------------------------------------------------------- the freeze */

test("the recorded manifest still recomputes from the tree", () => {
    assert.deepEqual(verifySucc4Manifest(MEMORY_EVAL_SUCC4_MANIFEST), []);
});

test("the composition adds up to the dataset it claims", () => {
    const { composition, caseCount } = MEMORY_EVAL_SUCC4_MANIFEST;
    const inherited = composition.inheritedComponents.reduce(
        (total, component) => total + component.caseCount,
        0
    );
    const replaced = composition.replacementTranches.reduce(
        (total, tranche) => total + tranche.caseCount,
        0
    );
    assert.equal(inherited, 1047);
    assert.equal(replaced, 103);
    assert.equal(inherited + replaced, caseCount);
    assert.equal(caseCount, MEMORY_EVAL_SUCC4_CASES.length);
    assert.equal(composition.inheritedUnbatched, null);
});

test("a source batch digest is provenance, never reused as the schema-3 one", () => {
    // The two answer different questions -- where did this come from, and what
    // did the transition make of it -- and a component where they were equal
    // would be claiming the relabelling changed nothing.
    for (const component of MEMORY_EVAL_SUCC4_MANIFEST.composition
        .inheritedComponents) {
        assert.notEqual(
            component.sourceBatchDigest,
            component.schema3ComponentDigest,
            `${component.sourceBatchId} pins the same digest twice`
        );
    }
});

test("the source digest is succ-3's own recorded one", () => {
    assert.equal(
        MEMORY_EVAL_SUCC4_MANIFEST.composition.sourceDatasetDigest,
        evalDatasetManifest("mem-eval-succ-3").datasetDigest
    );
});

test("the contract version is the one succ-4 was authored under", () => {
    assert.equal(
        MEMORY_EVAL_SUCC4_MANIFEST.scoringContractVersion,
        MEMORY_EVAL_SCORING_CONTRACT_VERSION
    );
    assert.equal(
        MEMORY_EVAL_SUCC4_MANIFEST.scoringContractDigest,
        succ4ScoringContractDigest()
    );
});

/* ------------------------------------------------- schema 1 and 2 untouched */

test("the schema-1 and schema-2 serialization is what it was frozen under", () => {
    // succ-3's recorded digest was computed by `datasetFingerprintInput()`, so
    // a schema-3 branch added *inside* that function would have moved every
    // frozen manifest before succ-4. The format is pinned here against a
    // synthetic pair rather than against the corpus, so it keeps saying
    // something even after every dataset has been replaced.
    const sample = [
        {
            id: "pin-2",
            category: "durable_facts",
            language: "en",
            expected: [{ kind: "identity", mustInclude: ["b", "a"] }],
            conversations: [
                {
                    externalConversationId: "pin-2-c",
                    title: "pin",
                    messages: [
                        { externalMessageId: "pin-2-m1", role: "user", content: "two" },
                    ],
                },
            ],
        },
        {
            id: "pin-1",
            category: "durable_facts",
            language: "ko",
            expected: [
                { kind: "constraint", mustInclude: ["x"] },
                { kind: "tone", mustInclude: ["y"] },
            ],
            conversations: [
                {
                    externalConversationId: "pin-1-c",
                    title: "pin",
                    messages: [
                        { externalMessageId: "pin-1-m1", role: "user", content: "one" },
                        {
                            externalMessageId: "pin-1-m2",
                            role: "assistant",
                            content: "ok",
                        },
                    ],
                },
            ],
        },
    ];

    const records = datasetFingerprintInput(sample).split("\u0001");
    assert.equal(records.length, 2, "the record separator changed");
    assert.deepEqual(records[0].split("\u0000"), [
        "pin-1",
        "durable_facts",
        "ko",
        "constraint:x;tone:y",
        "user:one\nassistant:ok",
    ]);
    assert.deepEqual(records[1].split("\u0000"), [
        "pin-2",
        "durable_facts",
        "en",
        "identity:b|a",
        "user:two",
    ]);
});

test("the schema-3 fingerprint covers every field that can move a score", () => {
    const [sample] = MEMORY_EVAL_SUCC4_REPLACEMENT_CASES;
    const input = datasetFingerprintInputV3([sample]);
    for (const fragment of [
        `id=${sample.id}`,
        `category=${sample.category}`,
        `language=${sample.language}`,
        `completeness=${sample.goldCompleteness}`,
        `criticalGoldMode=${sample.criticalGoldMode ?? "-"}`,
    ]) {
        assert.ok(input.includes(fragment), `the fingerprint drops ${fragment}`);
    }
    for (const gold of sample.expected) {
        for (const fragment of [
            `gold=${gold.id}`,
            `kind=${gold.kind}`,
            `polarity=${gold.polarity}`,
            `disposition=${gold.expectedDisposition}`,
            `all=${gold.factValueAll.join("|")}`,
            `anchorId=${gold.evidence.evidenceMessageId}`,
            `anchorQuote=${gold.evidence.evidenceQuote}`,
        ]) {
            assert.ok(input.includes(fragment), `the fingerprint drops ${fragment}`);
        }
    }
    for (const conversation of sample.conversations) {
        for (const message of conversation.messages) {
            assert.ok(
                input.includes(
                    `${message.externalMessageId}:${message.role}:${message.content}`
                ),
                `the fingerprint drops message ${message.externalMessageId}`
            );
        }
    }
});

test("an absent factValueAny and an empty one fingerprint differently", () => {
    const base = MEMORY_EVAL_SUCC4_REPLACEMENT_CASES[0];
    const withGold = (factValueAny) => ({
        ...base,
        expected: [{ ...base.expected[0], factValueAny }],
    });
    assert.notEqual(
        datasetFingerprintInputV3([withGold(undefined)]),
        datasetFingerprintInputV3([withGold([])])
    );
});

test("reordering cases or golds is not a dataset change", () => {
    assert.equal(
        datasetFingerprintInputV3(MEMORY_EVAL_SUCC4_CASES),
        datasetFingerprintInputV3([...MEMORY_EVAL_SUCC4_CASES].reverse())
    );
});

test("the message order inside a conversation is a dataset change", () => {
    // An anchor in the third turn of a correction says something the same
    // sentence in the first turn does not, so the order is content.
    const multiTurn = MEMORY_EVAL_SUCC4_CASES.find(
        (testCase) => testCase.conversations[0].messages.length > 2
    );
    assert.ok(multiTurn, "no multi-turn case to check against");
    const shuffled = {
        ...multiTurn,
        conversations: [
            {
                ...multiTurn.conversations[0],
                messages: [...multiTurn.conversations[0].messages].reverse(),
            },
        ],
    };
    assert.notEqual(
        datasetFingerprintInputV3([multiTurn]),
        datasetFingerprintInputV3([shuffled])
    );
});

/* ------------------------------------------- the transition pairing freezes */

test("the transition digest changes when a pairing does", () => {
    const [first, second] = SUCC4_TRANSITIONS;
    const swapped = [
        { ...first, replacementId: second.replacementId },
        { ...second, replacementId: first.replacementId },
        ...SUCC4_TRANSITIONS.slice(2),
    ];
    assert.notEqual(
        succ4TransitionFingerprintInput(SUCC4_TRANSITIONS),
        succ4TransitionFingerprintInput(swapped),
        "two replacements could swap originals without moving the digest"
    );
    assert.equal(
        MEMORY_EVAL_SUCC4_MANIFEST.composition.transitionManifestDigest,
        succ4TransitionManifestDigest()
    );
});

test("reordering the transition rows is not a change", () => {
    assert.equal(
        succ4TransitionFingerprintInput(SUCC4_TRANSITIONS),
        succ4TransitionFingerprintInput([...SUCC4_TRANSITIONS].reverse())
    );
});

/* ----------------------------------- the regression corpus moves no digest */

const REPO = path.resolve(import.meta.dirname, "..");

test("condition 1: the digest module does not import the regression corpus", () => {
    // The full graph walk lives in memoryEvalSucc4Dataset.test.mjs. Here it is
    // enough that the manifest module names it nowhere: the digest is computed
    // in this module's own file, so a direct import is the only way regression
    // content could reach it without going through the dataset.
    const source = readFileSync(
        path.join(REPO, "lib/memoryEvalSucc4Manifest.ts"),
        "utf8"
    );
    assert.ok(
        !source.includes("memoryEvalSucc4Regression"),
        "the manifest module imports the regression corpus"
    );
});

test("condition 2: the digest's input is the canonical case list and nothing else", () => {
    assert.equal(succ4DatasetDigest(), MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest);
    assert.equal(
        MEMORY_EVAL_SUCC4_CASES.length,
        MEMORY_EVAL_SUCC4_MANIFEST.caseCount
    );
});

test("condition 3: regression ids and decision ids do not intersect", () => {
    const decision = new Set(MEMORY_EVAL_SUCC4_CASES.map((c) => c.id));
    const regression = new Set(
        SUCC4_REGRESSION_CORPUS.map((entry) => entry.supersededCase.id)
    );
    assert.equal(regression.size, 103);
    for (const id of regression) {
        assert.ok(!decision.has(id), `${id} is in both corpora`);
    }
});

test("condition 3: the fingerprint does read cases, so its silence is meaningful", () => {
    // Condition 3 only says something if the fingerprint would notice
    // regression content were it ever added. This adds all 103 superseded
    // cases -- what a careless loader would do -- and requires the input to
    // change, then requires the frozen digest not to have moved.
    const canonical = datasetFingerprintInputV3(MEMORY_EVAL_SUCC4_CASES);
    const firstMessageOf = (testCase) =>
        testCase.conversations[0].messages[0];
    const contaminated = datasetFingerprintInputV3([
        ...MEMORY_EVAL_SUCC4_CASES,
        ...SUCC4_REGRESSION_CORPUS.map((entry) => ({
            ...entry.supersededCase,
            expected: entry.supersededCase.expected.map((gold) => ({
                id: gold.id,
                kind: gold.kind,
                polarity: "affirmed",
                factValueAll: gold.mustInclude,
                evidence: {
                    evidenceMessageId: firstMessageOf(entry.supersededCase)
                        .externalMessageId,
                    evidenceQuote: firstMessageOf(entry.supersededCase).content,
                },
                expectedDisposition: gold.expectedDisposition,
            })),
        })),
    ]);
    assert.notEqual(
        canonical,
        contaminated,
        "adding 103 superseded cases did not move the fingerprint, so it is not reading them"
    );
    assert.equal(
        succ4DatasetDigest(),
        MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest,
        "the frozen digest moved while this test was running"
    );
});

test("the composition names no superseded case", () => {
    const serialised = JSON.stringify(buildSucc4Composition());
    for (const entry of SUCC4_REGRESSION_CORPUS) {
        assert.ok(
            !serialised.includes(entry.supersededCase.id),
            `the composition names the superseded ${entry.supersededCase.id}`
        );
    }
    assert.deepEqual(buildSucc4Composition(), buildSucc4Manifest().composition);
});
