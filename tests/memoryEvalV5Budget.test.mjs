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
 * What the 2026-08-27 budget approval actually opened, read off the register
 * rather than off the issue that records it.
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

test("the approved pair carries the ceiling and the ticket it was approved on", () => {
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
    assert.equal(LUNA_V5.status, "candidate", "a budget is not an approval of the pair");
    assert.equal(LUNA_V5.evaluation, null);
});

test("the backup pair is still unfunded", () => {
    // A backup that inherited the primary's ceiling would be a second funded
    // pair nobody approved. v4's backup carries no budget either.
    assert.equal(MINI_V5.evalBudget, null);
    assert.equal(
        decideEvalRunMode(onSucc3({ registerEntry: MINI_V5, hasApiKey: true })).reason,
        "no_eval_budget"
    );
});

test("the budget is no longer what blocks a live run — the freeze is", () => {
    // The claim the approval issue makes, checked rather than asserted.
    assert.equal(
        decideEvalRunMode(onSucc3({ registerEntry: LUNA_V5, hasApiKey: true })).reason,
        MEMORY_EVAL_SUCC3_DATASET_FROZEN ? undefined : "dataset_not_frozen"
    );
    // And without a key the key gate speaks first, because it sits ahead of
    // the freeze gate. Named so that a reader of the issue's table can see
    // where the number came from.
    assert.equal(
        decideEvalRunMode(onSucc3({ registerEntry: LUNA_V5, hasApiKey: false })).reason,
        "no_api_key"
    );
});

test("once succ-3 is frozen the run is live at exactly the approved ceiling", () => {
    // `datasetFrozen: true` is passed explicitly rather than waiting for the
    // constant: this is the assertion that says what filling the last §7.1
    // field will do, and it must hold before that happens rather than after.
    const decision = decideEvalRunMode(
        onSucc3({ registerEntry: LUNA_V5, hasApiKey: true, datasetFrozen: true })
    );
    assert.equal(decision.mode, "live");
    assert.equal(decision.ceilingUsd, LUNA_V5.evalBudget.maxUsd);
});

test("a per-run cap may narrow the ceiling and never widen it", () => {
    const narrowed = decideEvalRunMode(
        onSucc3({
            registerEntry: LUNA_V5,
            hasApiKey: true,
            datasetFrozen: true,
            requestedRunCapUsd: 5,
        })
    );
    assert.equal(narrowed.mode, "live");
    assert.equal(narrowed.ceilingUsd, 5);

    assert.equal(
        decideEvalRunMode(
            onSucc3({
                registerEntry: LUNA_V5,
                hasApiKey: true,
                datasetFrozen: true,
                requestedRunCapUsd: LUNA_V5.evalBudget.maxUsd + 1,
            })
        ).reason,
        "run_cap_above_approved_ceiling",
        "a flag that could widen an approved ceiling would make the approval meaningless"
    );
});
