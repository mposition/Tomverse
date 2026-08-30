/**
 * Which prompt version implements which prompt-side scoring rule.
 *
 * The scoring contract can name a rule it does not enforce itself. Two of the
 * `mem-score-v3.3` rules are like that, and they are not the same kind of
 * waiting: `v3-unfixable-evidence-not-a-gold` is enforced at gold review, and
 * `v3-unfixable-evidence-emits-nothing` is a rule about what the *model* is
 * asked not to produce. Nothing in the eval tree can enforce the second one —
 * it is satisfied, or not, by the sentences in the extraction prompt.
 *
 * The contract records it as `prompt_pending` and stops there, because the
 * contract is frozen and cannot learn about prompt versions written after it.
 * So the fact that a version answered it lives here instead, as a mapping a
 * person writes when they write the rule into a prompt — never derived by
 * searching the prompt for words, which would let a paraphrase that dropped
 * the rule keep claiming it.
 *
 * `.github/audits/memory-eval-gold-contract-2026-08-27.md` §13.1 approved
 * splitting the two, on the condition that a paid run be refused while the
 * prompt half is unimplemented. That refusal is `decideEvalRunMode`'s
 * `prompt_rule_unimplemented`, and this module is what it reads.
 */

import { memoryEvalScoringContractPromptPending } from "@/lib/memoryEvalScoringContractDigest";

/**
 * Rule ids each prompt version implements, by version.
 *
 * A version absent from this table implements none of them, which is the
 * fail-closed direction: a new prompt starts out unable to run a schema-3
 * decision-grade eval, and saying so is one line.
 */
export const MEMORY_EVAL_PROMPT_RULE_IMPLEMENTATIONS: Readonly<
    Record<string, readonly string[]>
> = {
    // `mem-extract-v6` states the rule as a refusal with its three shapes
    // named (a condition that has not happened, an unresolved correction, a
    // double negative), keeps the resolved-correction exception, and refuses
    // the answer a model reaches for instead — the same candidate with a
    // lower confidence. `MEMORY_EXTRACTION_POLARITY_RULE` carries the
    // sentences and `tests/memoryExtractionPromptRules.test.mjs` pins them.
    "mem-extract-v6": ["v3-unfixable-evidence-emits-nothing"],
};

/**
 * The prompt-side rules this version leaves unanswered.
 *
 * Empty for a version that covers every pending rule. The pending list is
 * taken from the live contract rather than hard-coded, so a rule added to the
 * contract as `prompt_pending` is unimplemented by every existing version
 * from the moment it is added.
 */
export function memoryEvalUnimplementedPromptRules(
    promptVersion: string,
    pending: readonly string[] = memoryEvalScoringContractPromptPending()
): readonly string[] {
    const implemented = new Set(
        MEMORY_EVAL_PROMPT_RULE_IMPLEMENTATIONS[promptVersion] ?? []
    );
    return pending.filter((ruleId) => !implemented.has(ruleId));
}
