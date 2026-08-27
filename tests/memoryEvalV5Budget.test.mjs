import assert from "node:assert/strict";
import test from "node:test";

import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import {
    MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    decideEvalRunMode,
} from "../lib/memoryExtractionEvalCore.ts";
import {
    MEMORY_EVAL_SUCC3_DATASET_FROZEN,
    MEMORY_EVAL_SUCC3_DATASET_PURPOSE,
} from "../lib/memoryEvalSucc3Fixtures.ts";

/**
 * What the 2026-08-27 budget approval opened, and what closing the pair shut,
 * read off the register rather than off the issue that records it.
 *
 * v5-run1 measured `mem-extract-v5` on all 1,150 cases of `mem-eval-succ-3`
 * and missed every §12.3 floor and the hard-zero gate, so both v5 pairs are
 * `revoked` (.github/audits/memory-eval-v5-run1-2026-08-27.md). The budget
 * stays on the record — the approval was real and US$0.5877 of it was really
 * spent — which makes this file's job the ordering of two facts: a ceiling
 * that is still recorded, and a gate that no longer opens for it.
 *
 * `tests/memoryEvalDevelopmentProbe.test.mjs` pins the gate *order* against
 * synthetic entries, which is the right shape for a rule that must hold for
 * any pair. This file pins the opposite thing: the real register's real
 * entries, so a budget that is removed, widened, or attached to the backup
 * pair fails here and not in a live run.
 *
 * The distinction matters because the two gates have already swapped once. A
 * version bump left the new pair unfunded, the budget gate fired ahead of the
 * key gate, and a test pinning one refusal message failed for a refusal that
 * was working correctly (#1122). Every outcome below is therefore named.
 */

const pair = (extractionModelId, promptVersion) => {
    const entry = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (candidate) =>
            candidate.extractionModelId === extractionModelId &&
            candidate.promptVersion === promptVersion
    );
    assert.ok(entry, `${extractionModelId}::${promptVersion} is not registered`);
    return entry;
};

const LUNA_V5 = pair("gpt-5-6-luna", "mem-extract-v5");
const MINI_V5 = pair("gpt-5-4-mini", "mem-extract-v5");

/** The run this budget was approved for: succ-3, as the tree holds it. */
const onSucc3 = (overrides) => ({
    live: true,
    datasetFrozen: MEMORY_EVAL_SUCC3_DATASET_FROZEN,
    datasetPurpose: MEMORY_EVAL_SUCC3_DATASET_PURPOSE,
    datasetSchemaVersion: MEMORY_EVAL_DATASET_SCHEMA_VERSION,
    commitKnown: true,
    ...overrides,
});

test("the closed pair still carries the ceiling and the ticket it ran on", () => {
    const budget = LUNA_V5.evalBudget;
    assert.ok(budget, "the 2026-08-27 approval is not on the register");
    assert.equal(budget.approvedBy, "@mposition");
    assert.equal(budget.approvedAt, "2026-08-27");
    // US$20 covers the §12.4 re-run (US$12.36 worst case on succ-3) and a
    // third run after a failure (US$18.54), which is what the ceiling was
    // chosen for. A number below 18.54 would silently need a second approval
    // at the worst possible moment.
    assert.equal(budget.maxUsd, 20);
    assert.ok(budget.maxUsd > 18.54, "a repeat run would need a second approval");
    assert.match(budget.ticket, /^https:\/\/github\.com\/mposition\/Tomverse\/issues\/\d+$/);
    // Closed after v5-run1. `evaluation` stays null: §12.1's block is an
    // approval record — approver, approvedAt, expiresAt — and there was no
    // approval. The evidence for a negative result is the audit, not a
    // half-filled approval.
    assert.equal(LUNA_V5.status, "revoked");
    assert.equal(LUNA_V5.evaluation, null);
    assert.match(LUNA_V5.notes, /Negative result/);
    assert.match(LUNA_V5.notes, /memory-eval-v5-run1-2026-08-27\.md/);
});

test("the backup pair was never funded and is closed with the version", () => {
    // A backup that inherited the primary's ceiling would have been a second
    // funded pair nobody approved; one left open after the version closed
    // would be one budget approval away from running a prompt nobody intends
    // to approve. It is refused for the status now, ahead of the budget.
    assert.equal(MINI_V5.evalBudget, null);
    assert.equal(MINI_V5.status, "revoked");
    assert.equal(
        decideEvalRunMode(onSucc3({ registerEntry: MINI_V5, hasApiKey: true })).reason,
        "pair_not_runnable"
    );
});

test("the closed pair cannot run again, key and freeze notwithstanding", () => {
    // The status gate sits ahead of the budget, the key and the freeze, so
    // this holds however the rest of the world is arranged. That ordering is
    // what makes "we are not re-running v5" a gate rather than a memory.
    assert.equal(MEMORY_EVAL_SUCC3_DATASET_FROZEN, true, "succ-3 is frozen");
    for (const hasApiKey of [true, false]) {
        assert.equal(
            decideEvalRunMode(onSucc3({ registerEntry: LUNA_V5, hasApiKey })).reason,
            "pair_not_runnable",
            `hasApiKey=${hasApiKey}`
        );
    }
    // Not even with a cap inside the approved ceiling.
    assert.equal(
        decideEvalRunMode(
            onSucc3({ registerEntry: LUNA_V5, hasApiKey: true, requestedRunCapUsd: 5 })
        ).reason,
        "pair_not_runnable"
    );
});

test("nothing on the register can run live any more", () => {
    // v4's pair was the other funded one. Stated as a list rather than a
    // count: a pair that becomes runnable has to be argued for, and this is
    // where the argument would fail first.
    const runnable = MEMORY_EXTRACTION_EVAL_REGISTER.filter(
        (entry) =>
            decideEvalRunMode(onSucc3({ registerEntry: entry, hasApiKey: true }))
                .mode === "live"
    ).map((entry) => `${entry.extractionModelId}::${entry.promptVersion}`);
    assert.deepEqual(runnable, ["gpt-5-6-luna::mem-extract-v4"]);
});
