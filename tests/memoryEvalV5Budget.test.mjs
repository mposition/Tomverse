import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { MEMORY_EXTRACTION_EVAL_REGISTER } from "../lib/memoryExtractionEvalRegister.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";
import { evalBudgetBindingProblems } from "../lib/memoryEvalBudgetBinding.ts";
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
 * and missed every docs/policy/external-conversation-import-and-memory.md
 * §12.3 floor and the hard-zero gate, so both v5 pairs are `revoked`
 * (.github/audits/memory-eval-v5-run1-2026-08-27.md). The budget
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
    // Closed after v5-run1. `evaluation` stays null: docs/policy/external-conversation-import-and-memory.md
    // §12.1's block is an
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

test("only the pair whose binding is satisfied can run live", () => {
    // Stated as a list rather than a count: a pair that becomes runnable has
    // to be argued for, and this is where the argument would fail first.
    //
    // The input satisfies the 2026-08-28 budget binding, so this asks the
    // register's own question — which entries are open and funded — rather
    // than the binding's. Without that, every entry would refuse for the
    // binding and the list would say nothing about the register.
    //
    // Two names, and which two has changed twice.
    // `gpt-5-6-luna::mem-extract-v6` is not one of them: it was
    // funded on 2026-08-28, ran on 2026-08-29 and was revoked the same day
    // for missing every §12.3 floor
    // (.github/audits/memory-eval-v6-succ5-run1-2026-08-29.md §7).
    //
    // v4 is here and cannot fund a run anyway, for the reason the next test
    // gives. v7 was funded on 2026-08-31
    // (.github/audits/memory-eval-v7-budget-approval-2026-08-31.md) and is
    // the one entry where the register and the binding both say yes — which
    // is what a funded pair is supposed to look like, and why the approval
    // separates funding a run from starting one.
    const runnable = MEMORY_EXTRACTION_EVAL_REGISTER.filter(
        (entry) =>
            decideEvalRunMode(
                onSucc3({
                    registerEntry: entry,
                    hasApiKey: true,
                    budgetBindingProblems: [],
                    budgetTupleFailures: [],
                    runShaDescendsFromApproval: true,
                    runOrdinal: 1,
                })
            ).mode === "live"
    ).map((entry) => `${entry.extractionModelId}::${entry.promptVersion}`);
    // It was one entry from 2026-09-02: v7 was revoked after run 1 came back
    // an admissible §12.3 failure, so it refuses on the status ahead of its
    // budget exactly as the v5 pairs do
    // (.github/audits/memory-eval-v7-run1-blind-review-2026-09-01.md). Its
    // approved US$6.39 x 2 is still on the record and would still cover a
    // second run; that is precisely why the status, not the ceiling, is what
    // closes it.
    //
    // Two again since 2026-09-05: `mem-extract-v8` was funded at US$7.00 x 2
    // (.github/audits/memory-eval-v8-budget-proposal-2026-09-05.md) and is now
    // the entry where the register and the binding both say yes. v4 is still
    // here and still cannot fund a run, for the reason the next test gives —
    // which is why this list is "the register would allow it", not "this would
    // run".
    assert.deepEqual(runnable, [
        "gpt-5-6-luna::mem-extract-v4",
        "gpt-5-6-luna::mem-extract-v8",
    ]);
});

test("v4's budget cannot fund a run, because it names no instrument", () => {
    // The other half, and the reason the list above is not the whole answer.
    // v4's budget predates instrument binding: a ceiling with no dataset,
    // contract or prompt digest. The harness computes that and refuses.
    const v4 = MEMORY_EXTRACTION_EVAL_REGISTER.find(
        (entry) =>
            entry.extractionModelId === "gpt-5-6-luna" &&
            entry.promptVersion === "mem-extract-v4"
    );
    const problems = evalBudgetBindingProblems(v4.evalBudget);
    assert.ok(problems.length > 0, "v4's budget looks bound, and is not");
    assert.deepEqual(
        decideEvalRunMode(
            onSucc3({
                registerEntry: v4,
                hasApiKey: true,
                budgetBindingProblems: problems,
            })
        ),
        { mode: "refused", reason: "budget_not_bound" }
    );
});

/* ------------------------------------------- the gate, end to end ------- */

// This file used to drive the real harness with `--live` and a key, on the
// reasoning that whichever pair it selected was unfunded and would refuse
// before reaching an adapter. The 2026-08-28 budget made that false, so the
// invocation is gone rather than guarded: a test that dispatches to a provider
// in order to assert that it does not is the wrong shape however carefully it
// is fenced. The smoke path is exercised end to end by
// `tests/memoryEvalSchema3DryRun.test.mjs`, which spends nothing by
// construction.

test("both revoked v5 pairs refuse for the status exactly", () => {
    // **This assertion is not interchangeable with "some refusal happened".**
    // The integration tests around this one accept any refusal on purpose,
    // because which gate speaks is the register's business and has moved
    // three times. That tolerance has a cost: a missing key or a lost budget
    // would satisfy them too, and a register gate that stopped working would
    // go unnoticed behind a refusal that came from somewhere else.
    //
    // So this test pins the one thing those cannot: the refusal is the
    // status gate, named, for both v5 pairs, with a key present and the
    // dataset frozen — every other reason removed rather than absent.
    assert.equal(MEMORY_EVAL_SUCC3_DATASET_FROZEN, true);

    for (const entry of [LUNA_V5, MINI_V5]) {
        const label = `${entry.extractionModelId}::${entry.promptVersion}`;
        assert.equal(entry.status, "revoked", label);
        assert.equal(
            decideEvalRunMode(onSucc3({ registerEntry: entry, hasApiKey: true }))
                .reason,
            "pair_not_runnable",
            label
        );
    }
});

test("the harness cannot select a v5 pair at all, and calls nothing", () => {
    // The harness resolves the prompt version from the tree, so once the tree
    // moved to v6 the v5 entries stopped being reachable through it. That is
    // containment, not a gap — but it does mean this file can no longer read
    // the status refusal out of the harness's output, and asserting a v5
    // message here would be asserting one gate's words about a different
    // entry. `mem-extract-v4` was named that way once and passed for weeks
    // while describing the wrong pair.
    //
    // So the harness half asserts what is still true of it: with a key
    // present, whichever pair the tree selects refuses before anything dials
    // out, and the pair it selects is not a v5 one.
    assert.notEqual(MEMORY_EXTRACTION_PROMPT_VERSION, LUNA_V5.promptVersion);
    assert.notEqual(MEMORY_EXTRACTION_PROMPT_VERSION, MINI_V5.promptVersion);

    // Asserted without running the harness. It used to run it with a key, on
    // the reasoning that the selected pair was unfunded and would refuse
    // before reaching an adapter. The 2026-08-28 budget made that false for
    // `gpt-5-6-luna::mem-extract-v6`, and a test that dispatches to a provider
    // to prove it does not is the worst possible shape — so the premise is
    // asserted directly instead.
    for (const entry of [LUNA_V5, MINI_V5]) {
        const label = `${entry.extractionModelId}::${entry.promptVersion}`;
        assert.notEqual(
            MEMORY_EXTRACTION_PROMPT_VERSION,
            entry.promptVersion,
            `${label} is the shipped version again; this file's premise is gone`
        );
    }
    // And the harness's own selection rule, read off the source rather than
    // reimplemented: it resolves the prompt version from the tree, so no
    // argument can make it choose a v5 entry.
    const source = readFileSync(
        fileURLToPath(new URL("../scripts/evalImportedMemoryExtraction.mjs", import.meta.url)),
        "utf8"
    );
    assert.match(
        source,
        /entry\.promptVersion === MEMORY_EXTRACTION_PROMPT_VERSION/,
        "the harness no longer selects by the shipped prompt version"
    );
});
