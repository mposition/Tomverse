/**
 * Superseding an adopted batch, checked at the level the registry decides.
 *
 * `deriveAdoptedBatchSuccessor` rejects a malformed successor at module load —
 * a moved digest, a typo'd exclusion, a duplicate, an empty list. What it
 * cannot see is the registry: whether the original and its successor both
 * appear, whether the exclusions across all successors add up to the 99 the
 * regression corpus claims, whether a survivor was copied instead of kept.
 * Those are here.
 *
 * `.github/audits/memory-eval-kind-boundary-amendment-2026-08-27.md` and its
 * correction fix the move set at 99.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
    adoptedBatchDigest,
    deriveAdoptedBatchSuccessor,
} from "../lib/memoryEvalAdoptedBatchSuccession.ts";
import { SUCCESSOR_ADOPTED_BATCHES } from "../lib/memoryEvalSuccessorAdopted/index.ts";
import { TRANCHE_1_SUCCESSORS } from "../lib/memoryEvalSuccessorAdopted/tranche1Successors.ts";
import { MEMORY_EVAL_REGRESSION_PROVENANCE } from "../lib/memoryEvalRegressionCorpus/index.ts";

const originals = new Map(SUCCESSOR_ADOPTED_BATCHES.map((b) => [b.id, b]));

test("a successor keeps its survivors by identity, not by copy", () => {
    // The whole reason for deriving rather than restating: 768 cases across
    // the full migration are never retyped, so no transcription error is
    // possible and the reviewable diff is the exclusion list.
    for (const successor of TRANCHE_1_SUCCESSORS) {
        const source = originals.get(successor.replacesBatchId);
        assert.ok(source, `${successor.replacesBatchId} is not in the registry`);
        assert.equal(
            successor.cases.length,
            source.cases.length - successor.excludedCaseIds.length
        );
        for (const testCase of successor.cases) {
            assert.ok(
                source.cases.includes(testCase),
                `${successor.id} rebuilt ${testCase.id} instead of keeping it`
            );
        }
    }
});

test("a successor drops exactly what it says, and nothing else", () => {
    for (const successor of TRANCHE_1_SUCCESSORS) {
        const source = originals.get(successor.replacesBatchId);
        const kept = new Set(successor.cases.map((c) => c.id));
        for (const excluded of successor.excludedCaseIds)
            assert.ok(!kept.has(excluded), `${successor.id} kept ${excluded}`);
        for (const testCase of source.cases) {
            if (successor.excludedCaseIds.includes(testCase.id)) continue;
            assert.ok(
                kept.has(testCase.id),
                `${successor.id} dropped ${testCase.id} without saying so`
            );
        }
    }
});

test("every exclusion is a case the corpus is taking", () => {
    // The check that keeps this from being the silent filter the corpus split
    // rejected: an exclusion nobody recorded is a case that vanished.
    const claimed = new Set(
        MEMORY_EVAL_REGRESSION_PROVENANCE.map((entry) => entry.originalId)
    );
    for (const successor of TRANCHE_1_SUCCESSORS) {
        for (const excluded of successor.excludedCaseIds) {
            assert.ok(
                claimed.has(excluded),
                `${successor.id} drops ${excluded}, which no provenance entry claims`
            );
        }
    }
});

test("no exclusion is claimed by two successors", () => {
    const seen = new Map();
    for (const successor of TRANCHE_1_SUCCESSORS) {
        for (const excluded of successor.excludedCaseIds) {
            assert.ok(
                !seen.has(excluded),
                `${excluded} is excluded by both ${seen.get(excluded)} and ${successor.id}`
            );
            seen.set(excluded, successor.id);
        }
    }
});

test("the pinned digests are the originals' current digests", () => {
    // Restated here as well as in the helper, because the helper runs at
    // import time and a test that never imports it would not notice.
    for (const successor of TRANCHE_1_SUCCESSORS) {
        const source = originals.get(successor.replacesBatchId);
        assert.equal(
            adoptedBatchDigest(source.cases),
            successor.sourceDigest,
            `${successor.replacesBatchId} moved under ${successor.id}`
        );
    }
});

test("the helper refuses every way a successor can be wrong", () => {
    // A guard that cannot fail is not a guard, so each rejection is exercised
    // rather than assumed. These are the four the helper owns; the registry
    // ones are the tests above.
    const source = originals.get("batch-115").cases;
    const digest = adoptedBatchDigest(source);
    const base = {
        id: "batch-test",
        replacesBatchId: "batch-115",
        sourceDigest: digest,
        source,
        excludedCaseIds: ["succ-injection-ko-1"],
    };
    assert.doesNotThrow(() => deriveAdoptedBatchSuccessor(base));

    assert.throws(
        () =>
            deriveAdoptedBatchSuccessor({
                ...base,
                sourceDigest: `${digest.slice(0, -1)}0`,
            }),
        /now digests to/,
        "a moved original must not be superseded against a stale pin"
    );
    assert.throws(
        () =>
            deriveAdoptedBatchSuccessor({
                ...base,
                excludedCaseIds: ["succ-injection-ko-999"],
            }),
        /is not in batch-115/
    );
    assert.throws(
        () =>
            deriveAdoptedBatchSuccessor({
                ...base,
                excludedCaseIds: ["succ-injection-ko-1", "succ-injection-ko-1"],
            }),
        /excluded twice/
    );
    assert.throws(
        () => deriveAdoptedBatchSuccessor({ ...base, excludedCaseIds: [] }),
        /excludes nothing/
    );
});

test("a digest mismatch names both digests in full", () => {
    // Truncated to sixteen characters, a pair that differs in its last byte
    // reads as identical — which is what the first version of this message
    // did, on a real mismatch.
    const source = originals.get("batch-115").cases;
    const digest = adoptedBatchDigest(source);
    const stale = `${digest.slice(0, -1)}${digest.endsWith("0") ? "1" : "0"}`;
    try {
        deriveAdoptedBatchSuccessor({
            id: "batch-test",
            replacesBatchId: "batch-115",
            sourceDigest: stale,
            source,
            excludedCaseIds: ["succ-injection-ko-1"],
        });
        assert.fail("expected a refusal");
    } catch (error) {
        assert.ok(error.message.includes(digest), "the actual digest in full");
        assert.ok(error.message.includes(stale), "the pinned digest in full");
    }
});
