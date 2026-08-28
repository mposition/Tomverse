/**
 * The prompt half of the scoring contract, and the gate that refuses a paid
 * run while it is unwritten.
 *
 * `mem-score-v3.3` carries one rule it cannot enforce itself:
 * `v3-unfixable-evidence-emits-nothing` is about what the extraction model is
 * asked not to produce, and only the prompt can satisfy it. The contract is
 * frozen, so it cannot learn that a later prompt version answered it — the
 * mapping lives outside the digest, which is exactly why it needs a test:
 * nothing else would notice a rule that quietly stopped being claimed, or a
 * claim nobody wrote a rule for.
 *
 * .github/audits/memory-eval-gold-contract-2026-08-27.md §13.1 approved the
 * split on the condition that the run-mode gate refuse until the prompt
 * implements it. These assertions are that condition.
 */

import assert from "node:assert/strict";
import test from "node:test";
import {
    MEMORY_EVAL_PROMPT_RULE_IMPLEMENTATIONS,
    memoryEvalUnimplementedPromptRules,
} from "../lib/memoryEvalPromptRuleImplementations.ts";
import {
    MEMORY_EVAL_SCORING_RULES,
    memoryEvalScoringContractPromptPending,
} from "../lib/memoryEvalScoringContractDigest.ts";
import { MEMORY_EXTRACTION_PROMPT_VERSION } from "../lib/memoryExtractionPrompt.ts";
import { decideEvalRunMode } from "../lib/memoryExtractionEvalCore.ts";

test("every version claims only rules the contract actually names", () => {
    // A claim for an id the contract does not carry is a claim about nothing,
    // and it would silently stop covering the rule it was written for the day
    // that rule was renamed.
    const known = new Set(MEMORY_EVAL_SCORING_RULES.map((rule) => rule.id));
    for (const [version, ruleIds] of Object.entries(
        MEMORY_EVAL_PROMPT_RULE_IMPLEMENTATIONS
    )) {
        for (const ruleId of ruleIds) {
            assert.ok(known.has(ruleId), `${version} claims unknown ${ruleId}`);
        }
    }
});

test("the shipped prompt implements every prompt-side rule", () => {
    // The state the tree is in, asserted rather than assumed. If this fails,
    // either a rule was added to the contract or the prompt version moved
    // without the mapping moving with it -- and both mean a live schema-3 run
    // would report on a rule nothing applied.
    assert.deepEqual(
        [...memoryEvalUnimplementedPromptRules(MEMORY_EXTRACTION_PROMPT_VERSION)],
        []
    );
    assert.ok(memoryEvalScoringContractPromptPending().length > 0);
});

test("a version that implements nothing leaves every pending rule open", () => {
    // Fail-closed: absence from the table is not silence, it is "none".
    assert.deepEqual(
        [...memoryEvalUnimplementedPromptRules("mem-extract-v5")],
        [...memoryEvalScoringContractPromptPending()]
    );
    assert.deepEqual(
        [...memoryEvalUnimplementedPromptRules("mem-extract-v99")],
        [...memoryEvalScoringContractPromptPending()]
    );
});

test("an unimplemented rule refuses the run before the key is spent", () => {
    const base = {
        live: true,
        registerEntry: { status: "candidate", evalBudget: { maxUsd: 5 } },
        hasApiKey: true,
        datasetFrozen: true,
        commitKnown: true,
        datasetSchemaVersion: 2,
    };
    assert.deepEqual(decideEvalRunMode(base), { mode: "live", ceilingUsd: 5 });
    assert.deepEqual(
        decideEvalRunMode({
            ...base,
            unimplementedPromptRules: ["v3-unfixable-evidence-emits-nothing"],
        }),
        { mode: "refused", reason: "prompt_rule_unimplemented" }
    );
    // And it refuses after the cheaper checks, not instead of them: a pair
    // with no budget must still report the budget.
    assert.deepEqual(
        decideEvalRunMode({
            ...base,
            registerEntry: { status: "candidate", evalBudget: null },
            unimplementedPromptRules: ["v3-unfixable-evidence-emits-nothing"],
        }),
        { mode: "refused", reason: "no_eval_budget" }
    );
});

test("smoke mode is not gated by it", () => {
    // The rule is about what a paid run may report. A smoke run reports
    // nothing citable and costs nothing, and gating it would leave the
    // offline path unusable for the whole time a rule is being written.
    assert.deepEqual(
        decideEvalRunMode({
            live: false,
            registerEntry: null,
            hasApiKey: false,
            datasetFrozen: false,
            commitKnown: false,
            unimplementedPromptRules: ["v3-unfixable-evidence-emits-nothing"],
        }),
        { mode: "smoke" }
    );
});
