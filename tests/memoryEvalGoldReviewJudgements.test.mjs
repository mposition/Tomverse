// `v3-unfixable-evidence-not-a-gold`, and the digests the v3.3 bump moved.
//
// Two things are being held here. The rule is enforced by a record rather than
// a classifier, so the tests that matter are the ones where the record is
// wrong -- a gold nobody judged, a gold judged unfixable and left in the set,
// a register naming a gold that does not exist. And the contract bump must
// move exactly one digest: v3.2's is a frozen fact and v3.3's is a new one.

import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";

import {
    MEMORY_EVAL_GOLD_REVIEW_JUDGEMENTS,
    MEMORY_EVAL_UNFIXABLE_GOLDS,
    goldReviewCoverage,
    goldReviewFailures,
} from "../lib/memoryEvalGoldReviewJudgements.ts";
import {
    MEMORY_EVAL_SCORING_CONTRACT_VERSION,
    MEMORY_EVAL_SCORING_RULES,
    memoryEvalScoringContractPromptPending,
    memoryEvalScoringContractReadiness,
    scoringContractDescriptorInput,
} from "../lib/memoryEvalScoringContractDigest.ts";
import {
    MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS,
    verifyScoringContractManifest,
} from "../lib/memoryEvalDatasetManifests.ts";
import { MEMORY_EVAL_SUCC4_CASES } from "../lib/memoryEvalSucc4Dataset.ts";
import { MEMORY_EVAL_SUCC4_MANIFEST } from "../lib/memoryEvalSucc4Manifest.ts";
import {
    SUCC4_DRAFT_REJECTIONS,
    succ4DraftRejectionTally,
} from "../lib/memoryEvalSucc4DraftRejections.ts";

const succ4Golds = () => {
    const keys = [];
    const polarityByKey = new Map();
    for (const testCase of MEMORY_EVAL_SUCC4_CASES) {
        for (const gold of testCase.expected) {
            const key = `${testCase.id}:${gold.id}`;
            keys.push(key);
            polarityByKey.set(key, gold.polarity);
        }
    }
    return { keys, polarityByKey };
};

/* -------------------------------------------------------- the judgement */

test("the judgement is a closed set of three", () => {
    assert.deepEqual([...MEMORY_EVAL_GOLD_REVIEW_JUDGEMENTS], [
        "affirmed",
        "negated",
        "unfixable",
    ]);
});

test("every succ-4 gold carries exactly one judgement", () => {
    const { keys, polarityByKey } = succ4Golds();
    const coverage = goldReviewCoverage({
        decisionSetGoldKeys: keys,
        polarityByKey,
    });
    assert.equal(coverage.judgements.size, keys.length);
    assert.deepEqual(goldReviewFailures(coverage), []);
});

test("the unfixable register is empty, and that is the recorded state", () => {
    assert.deepEqual([...MEMORY_EVAL_UNFIXABLE_GOLDS], []);
});

test("a gold nobody judged refuses the freeze", () => {
    const { keys, polarityByKey } = succ4Golds();
    const thinned = new Map(polarityByKey);
    thinned.delete(keys[0]);
    const failures = goldReviewFailures(
        goldReviewCoverage({ decisionSetGoldKeys: keys, polarityByKey: thinned })
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0], /no review judgement/);
    assert.match(failures[0], new RegExp(keys[0]));
});

test("a gold judged unfixable and left in the decision set refuses the freeze", () => {
    const { keys, polarityByKey } = succ4Golds();
    const coverage = goldReviewCoverage({
        decisionSetGoldKeys: keys,
        polarityByKey,
        register: [
            {
                key: keys[3],
                shape: "unresolved-correction",
                reason: "the correction is never settled",
                auditRef: "test",
            },
        ],
    });
    assert.equal(coverage.judgements.get(keys[3]), "unfixable");
    const failures = goldReviewFailures(coverage);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /judged unfixable are in the decision set/);
});

test("an unfixable gold outside the decision set is fine, and is still checked", () => {
    const { keys, polarityByKey } = succ4Golds();
    const register = [
        {
            key: "succ-durable-ko-109:e1",
            shape: "conditional",
            reason: "moved out of the decision set at succ-4",
            auditRef: "test",
        },
    ];
    // It is a real gold of the superseded corpus, so it is "known" but not in
    // the set: no failure.
    const ok = goldReviewCoverage({
        decisionSetGoldKeys: keys,
        polarityByKey,
        knownGoldKeys: [...keys, "succ-durable-ko-109:e1"],
        register,
    });
    assert.deepEqual(goldReviewFailures(ok), []);

    // Named as unfixable but no such gold anywhere: a register that has drifted.
    const drifted = goldReviewCoverage({
        decisionSetGoldKeys: keys,
        polarityByKey,
        register,
    });
    const failures = goldReviewFailures(drifted);
    assert.equal(failures.length, 1);
    assert.match(failures[0], /do not exist/);
});

test("a label that is neither polarity nor a register entry is not guessed at", () => {
    const { keys, polarityByKey } = succ4Golds();
    const bent = new Map(polarityByKey);
    bent.set(keys[1], "probably affirmed");
    const failures = goldReviewFailures(
        goldReviewCoverage({ decisionSetGoldKeys: keys, polarityByKey: bent })
    );
    assert.equal(failures.length, 1);
    assert.match(failures[0], /judged more than one way/);
});

test("the same gold twice in the register is a conflict", () => {
    const { keys, polarityByKey } = succ4Golds();
    const entry = {
        key: keys[2],
        shape: "double-negative",
        reason: "x",
        auditRef: "test",
    };
    const failures = goldReviewFailures(
        goldReviewCoverage({
            decisionSetGoldKeys: keys,
            polarityByKey,
            register: [entry, { ...entry, reason: "y" }],
        })
    );
    assert.ok(failures.some((line) => /judged more than one way/.test(line)));
});

/* ------------------------------------------------------- the v3.3 bump */

test("the rule is split, and each half says whose it is", () => {
    const byId = new Map(MEMORY_EVAL_SCORING_RULES.map((rule) => [rule.id, rule]));
    const model = byId.get("v3-unfixable-evidence-emits-nothing");
    const gold = byId.get("v3-unfixable-evidence-not-a-gold");
    assert.ok(model, "the model half lost its id");
    assert.ok(gold, "the gold-authoring half was never added");
    assert.equal(model.enforcement, "prompt_pending");
    assert.equal(gold.enforcement, "gold_review");
    assert.ok(
        !model.statement.includes("gold"),
        "the model half still claims the authoring rule"
    );
});

test("a dataset freeze waits on nothing; the prompt rule stays visible", () => {
    assert.deepEqual([...memoryEvalScoringContractReadiness()], []);
    assert.deepEqual(
        [...memoryEvalScoringContractPromptPending()],
        ["v3-unfixable-evidence-emits-nothing"]
    );
});

test("v3.2's digest is untouched and v3.3's is new", () => {
    const byVersion = new Map(
        MEMORY_EVAL_SCORING_CONTRACT_MANIFESTS.map((entry) => [entry.version, entry])
    );
    const v32 = byVersion.get("mem-score-v3.2");
    const v33 = byVersion.get("mem-score-v3.3");
    assert.ok(v32 && v33);
    assert.equal(
        v32.descriptorDigest,
        "8d6dfef8537cf910a40d175e0bb315bdfaa4e47fa5e89ea3c4bfbc032d9b6e1b",
        "v3.2 was frozen and its digest is a fact, not a value to recompute"
    );
    assert.notEqual(v33.descriptorDigest, v32.descriptorDigest);
    assert.deepEqual([...v32.pendingRules], ["v3-unfixable-evidence-emits-nothing"]);
    assert.deepEqual([...v33.pendingRules], []);
});

test("the live contract recomputes to its recorded digest", () => {
    // v3.4 since 2026-08-28. The version is not pinned here — it moves
    // whenever a contract is corrected, and this file is about the gold-review
    // rules rather than about which version carries them. What must hold is
    // that whatever is live has a record and recomputes to it.
    assert.equal(MEMORY_EVAL_SCORING_CONTRACT_VERSION, "mem-score-v3.4");
    const result = verifyScoringContractManifest();
    assert.ok(result.entry);
    assert.deepEqual([...result.mismatches], []);
    assert.equal(
        createHash("sha256")
            .update(scoringContractDescriptorInput(), "utf8")
            .digest("hex"),
        result.entry.descriptorDigest
    );
});

test("succ-4's manifest carries v3.3, and its dataset digest did not move", () => {
    assert.equal(
        MEMORY_EVAL_SUCC4_MANIFEST.scoringContractVersion,
        "mem-score-v3.3"
    );
    // The contract moved; the sample did not. A bump that moved the dataset
    // digest would mean the two were entangled.
    assert.equal(
        MEMORY_EVAL_SUCC4_MANIFEST.datasetDigest,
        "0a516821da60669da6763528a414d0433e11e38db8eca56c690667cc7b2a18f0"
    );
    assert.equal(
        MEMORY_EVAL_SUCC4_MANIFEST.composition.transitionManifestDigest,
        "44bc58bad215ed572f1accd74979b19b6708453f37e474734940953edf51a325"
    );
});

/* ------------------------------------------------- the rejection tally */

test("every rejection names a real replacement, in its own tranche", () => {
    const byTranche = new Map(
        MEMORY_EVAL_SUCC4_MANIFEST.composition.replacementTranches.map((t) => [
            t.trancheId,
            t,
        ])
    );
    const ids = new Set(MEMORY_EVAL_SUCC4_CASES.map((c) => c.id));
    const seen = new Set();
    for (const rejection of SUCC4_DRAFT_REJECTIONS) {
        assert.ok(
            byTranche.has(rejection.trancheId),
            `${rejection.trancheId} is not a tranche`
        );
        assert.ok(
            ids.has(rejection.replacementId),
            `${rejection.replacementId} is not in the decision set`
        );
        assert.ok(
            !seen.has(rejection.replacementId),
            `${rejection.replacementId} is listed twice`
        );
        seen.add(rejection.replacementId);
    }
});

test("no tranche reports more rejections than it has cases", () => {
    const { byTranche, total } = succ4DraftRejectionTally(
        MEMORY_EVAL_SUCC4_MANIFEST.composition.replacementTranches
    );
    for (const row of byTranche) {
        assert.ok(
            row.rejected <= row.cases,
            `${row.trancheId} rejected ${row.rejected} of ${row.cases}`
        );
    }
    assert.equal(total.cases, 103);
    assert.equal(total.rejected, SUCC4_DRAFT_REJECTIONS.length);
});

test("the record quotes the tally the code computes", () => {
    const { total } = succ4DraftRejectionTally(
        MEMORY_EVAL_SUCC4_MANIFEST.composition.replacementTranches
    );
    assert.equal(total.rejected, 21);
    assert.equal(total.rate, 20.4);
});
