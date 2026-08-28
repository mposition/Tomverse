/**
 * How many output tokens one evaluation call may ask for, and the record of
 * why it asked for that.
 *
 * ## The defect this exists to stop repeating
 *
 * The 2026-08-28 pilot hardcoded `maxOutputTokens: 2_048` for every call. The
 * product asks for 128,000–384,000 for the same models, and for all of them
 * `reasoningTokenBilling` is `billed_as_output` — reasoning tokens are spent
 * from the same budget as the answer. So a reasoning model handed 2,048 can
 * spend the whole budget thinking and return no answer text at all. 60 of that
 * run's answers came back empty, every one of them on the auto arm, and the
 * run was void.
 *
 * The harness was measuring a condition the product never creates. So the
 * answer arms now resolve their cap through the product's own pricing profile
 * rather than a constant this file invented.
 *
 * ## Why the judge is not resolved the same way
 *
 * mposition's ruling: the two calls do different work and must not share a
 * number. An answer is prose for a person and gets the product's cap, because
 * that is the thing being measured. A judge returns one structured verdict and
 * has no use for a 128,000-token budget.
 *
 * But it cannot have 2,048 either, and for exactly the reason above: the
 * judges are reasoning models too, and a judge that exhausts its budget
 * thinking returns no verdict. `JUDGE_MAX_OUTPUT_TOKENS` is sized to cover the
 * reasoning a pairwise comparison needs with room to spare, and a judge call
 * that exhausts it now shows up in the failure journal under `arm: "judge"`
 * rather than as an unparseable verdict.
 */

import { resolveModelPricing } from "./modelPricing";
import type { AiModel } from "./models";

/**
 * The rules below, versioned.
 *
 * Frozen into the run manifest beside `pricingVersion`: the pricing version
 * says which table supplied the number, and this says which rules read it.
 * Both have to match for two runs to have asked the same question.
 */
export const CALL_LIMIT_PROFILE_VERSION = "router-call-limits-v1";

/** Which call this is. Not an arm: `judge` never scores. */
export const CALL_ROLES = ["answer", "judge"] as const;
export type CallRole = (typeof CALL_ROLES)[number];

/**
 * The judge's output budget.
 *
 * A verdict is a handful of tokens. This is not sized for the verdict, it is
 * sized for the reasoning in front of it: every judge in the pre-registration
 * bills reasoning as output, so a budget that fits only the answer is a budget
 * the model can exhaust before writing one.
 *
 * 8,192 is measured rather than picked. The judge-cap probe of 2026-08-28 ran
 * ten judgements on `claude-fable-5` at this budget: every one finished
 * `stop`, every verdict parsed, none came close to exhausting it, and the
 * largest billed 1,437 output tokens against a visible verdict of three -- so
 * the budget is spent thinking, and this leaves 5.7x headroom over the worst
 * case anybody has seen. mposition fixed it here on that evidence.
 *
 * Still far below the product's chat cap, which is what keeps a judge call
 * from being priced like a conversation.
 */
export const JUDGE_MAX_OUTPUT_TOKENS = 8_192;

export const LIMIT_SOURCES = [
    "product_pricing_profile",
    "provider_ceiling",
    "judge_structured_verdict",
] as const;
export type LimitSource = (typeof LIMIT_SOURCES)[number];

export type ResolvedCallLimit = {
    modelId: string;
    apiModelId: string;
    callRole: CallRole;
    requestedMaxOutputTokens: number;
    limitSource: LimitSource;
    profileVersion: string;
    pricingVersion: string;
    /**
     * What the product would ask for on this model, whatever this call asked.
     *
     * Kept even on a judge call, because it is one of the four conditions that
     * has to hold before an empty answer may be called budget exhaustion: a
     * request that already asks for the product's cap did not run short
     * because this harness was stingy.
     */
    resolvedProductOutputCap: number;
    outputUsdPerMillionTokens: number;
    inputUsdPerMillionTokens: number;
    reasoningTokenBilling: string;
};

/**
 * What this call asks for, and the provenance of the number.
 *
 * The product's cap is bounded by the provider's verified ceiling where one is
 * known, the same way the product bounds it — `providerMaxOutputTokens` never
 * raises a request, only lowers it.
 */
export const resolveCallLimit = (model: AiModel, callRole: CallRole): ResolvedCallLimit => {
    const pricing = resolveModelPricing(model);
    const ceiling = pricing.providerMaxOutputTokens;
    const productCap =
        ceiling === null ? pricing.maxOutputTokens : Math.min(pricing.maxOutputTokens, ceiling);

    const requested = callRole === "judge" ? Math.min(JUDGE_MAX_OUTPUT_TOKENS, productCap) : productCap;
    const limitSource: LimitSource =
        callRole === "judge"
            ? "judge_structured_verdict"
            : ceiling !== null && ceiling < pricing.maxOutputTokens
              ? "provider_ceiling"
              : "product_pricing_profile";

    return {
        modelId: model.id,
        apiModelId: pricing.apiModelId,
        callRole,
        requestedMaxOutputTokens: requested,
        limitSource,
        profileVersion: CALL_LIMIT_PROFILE_VERSION,
        pricingVersion: pricing.pricingVersion,
        resolvedProductOutputCap: productCap,
        outputUsdPerMillionTokens: pricing.outputUsdPerMillionTokens,
        inputUsdPerMillionTokens: pricing.inputUsdPerMillionTokens,
        reasoningTokenBilling: pricing.reasoningTokenBilling,
    };
};

/**
 * The run's frozen answer to "what was every call allowed to ask for".
 *
 * Written into the artifact at the start of the run. Reading the profile at
 * runtime is not enough on its own: a pricing table edit between two runs
 * would silently change what the same pilot asked for, and a comparison across
 * that edit would be comparing two different questions. The snapshot is what
 * makes the change visible.
 */
export type RunCallLimitManifest = {
    profileVersion: string;
    frozenAt: string;
    entries: readonly ResolvedCallLimit[];
};

export const buildCallLimitManifest = (
    calls: readonly { model: AiModel; callRole: CallRole }[],
    now: () => Date = () => new Date()
): RunCallLimitManifest => {
    const entries = new Map<string, ResolvedCallLimit>();
    for (const { model, callRole } of calls) {
        const key = `${model.id}::${callRole}`;
        if (!entries.has(key)) entries.set(key, resolveCallLimit(model, callRole));
    }
    return {
        profileVersion: CALL_LIMIT_PROFILE_VERSION,
        frozenAt: now().toISOString(),
        entries: [...entries.values()].sort((a, b) =>
            `${a.modelId}${a.callRole}`.localeCompare(`${b.modelId}${b.callRole}`)
        ),
    };
};

/** Why a manifest may not be used. Empty means it may. */
export const callLimitManifestProblems = (
    manifest: RunCallLimitManifest | null | undefined
): readonly string[] => {
    if (!manifest) return ["the run froze no call-limit manifest, so what it asked for is unknown"];
    const problems: string[] = [];
    if (manifest.profileVersion !== CALL_LIMIT_PROFILE_VERSION) {
        problems.push(
            `the manifest was frozen under ${manifest.profileVersion}, not ${CALL_LIMIT_PROFILE_VERSION}`
        );
    }
    if (!Array.isArray(manifest.entries) || manifest.entries.length === 0) {
        problems.push("the manifest names no calls");
        return problems;
    }
    for (const entry of manifest.entries) {
        const where = `${entry.modelId}/${entry.callRole}`;
        if (!(Number.isInteger(entry.requestedMaxOutputTokens) && entry.requestedMaxOutputTokens > 0)) {
            problems.push(`${where} froze no usable requestedMaxOutputTokens`);
        }
        if (!entry.pricingVersion) problems.push(`${where} froze no pricingVersion`);
        if (entry.callRole === "answer" && entry.requestedMaxOutputTokens < entry.resolvedProductOutputCap) {
            problems.push(
                `${where} asks for ${entry.requestedMaxOutputTokens} against the product's ` +
                    `${entry.resolvedProductOutputCap}, so the answer arm is measured under a cap the ` +
                    "product never applies"
            );
        }
    }
    return problems;
};
