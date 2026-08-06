/**
 * Router Pass 1's hard filters — which models Auto may consider at all.
 *
 * `docs/policy/tomverse-chat-routing.md` §4: "Health, policy, regional
 * availability, capability, context limit, attachment support, and credit
 * constraints are all hard filters." Hard means a candidate is in or out; there
 * is no score here, and nothing below can be outweighed by a model being a
 * better answer. Ranking, confidence and stickiness are later steps, and they
 * rank what survives this.
 *
 * Two properties this exists to hold:
 *
 * **Auto may not select a model it cannot bound.** The chat guard reads
 * `modelConfig.contextWindowTokens && ...`, so a model with no declared window
 * is not clamped to a safe default — it is not checked at all, and an
 * over-limit request reaches the provider. `scripts/check-router-context-
 * window.mjs` already states why that is worse under Auto than today: a person
 * choosing such a model is choosing it deliberately, whereas the Router would
 * be choosing it on the user's behalf. So an undeclared window is a rejection
 * here even while it stays a pass on the manual path, and `ESTIMATE-03` ("no
 * over-limit context request reaches a provider", zero tolerance) is the gate
 * that makes the difference matter.
 *
 * **Every rejection carries a reason.** `RoutingRun` records selection
 * reasons, and a filter that can only say "no" produces routing nobody can
 * explain afterwards. Reasons are fixed identifiers, never text derived from
 * the request — same content-free rule as the task profile.
 *
 * Nothing here fetches, reads a database, or calls a model. Health and
 * regional availability are inputs rather than lookups for that reason: the
 * caller owns where they come from, and this owns what they mean.
 */

import { fitChatOutputToContextWindow } from "@/lib/chatContextWindow";
import {
    canUseModelWithPlan,
    modelSupportsImageInput,
    type AiModel,
    type ModelTier,
} from "@/lib/models";
import { getWebSearchCapability } from "@/lib/webSearchCapability";
import type { TaskProfile } from "@/lib/taskProfileCore";

/**
 * Bump with any change to the filters or their order. `RoutingRun` records it
 * beside the Task Profiler and Estimator versions so a change in which models
 * were considered can be attributed.
 */
export const ROUTER_CANDIDATE_VERSION = "router-candidates-v1";

export const CANDIDATE_REJECTIONS = [
    /** Not enabled in the catalogue, or not publicly selectable. */
    "disabled",
    /** The account's plan does not include it. */
    "plan",
    /** The turn carries an image and the model cannot read one. */
    "image_input_unsupported",
    /** The turn needs current information and the model cannot search. */
    "web_search_unsupported",
    /** Search support was never verified, so Auto will not assume it. */
    "web_search_unverified",
    /** No declared context window, so Auto cannot bound the request. */
    "context_window_undeclared",
    /** The input alone leaves no room for an answer. */
    "context_exceeded",
    /** Reported unhealthy by the caller. */
    "unhealthy",
    /** Not available in the request's region. */
    "region_unavailable",
    /** The account cannot pay for it. */
    "insufficient_credits",
] as const;

export type CandidateRejection = (typeof CANDIDATE_REJECTIONS)[number];

export type RouterCandidateInput = {
    models: readonly AiModel[];
    plan: ModelTier | "Guest";
    profile: TaskProfile;
    /** Input tokens the request will really send, tool overhead included. */
    reservedInputTokens: number;
    /** The output cap this application asks for. */
    requestOutputCapTokens: number;
    /**
     * Model IDs the caller knows to be unhealthy or regionally unavailable.
     * Inputs rather than lookups: this module decides what they mean, and the
     * caller decides where they come from.
     */
    unhealthyModelIds?: readonly string[];
    regionBlockedModelIds?: readonly string[];
    /**
     * What the account can spend, and what each model would cost. Omitted
     * together, the credit filter does not run — an absent budget is unknown,
     * not unlimited, so the caller must not be able to skip it by accident on
     * one side only.
     */
    availableCredits?: number;
    creditsByModelId?: Readonly<Record<string, number>>;
};

export type RouterCandidate = {
    modelId: string;
    /** Output room this model would have, from the shared window arithmetic. */
    outputTokens: number;
};

export type RouterCandidateResult = {
    version: string;
    eligible: readonly RouterCandidate[];
    /** Content-free: model id and a fixed reason identifier, nothing else. */
    rejected: readonly { modelId: string; reason: CandidateRejection }[];
};

/**
 * Applies every hard filter, cheapest and most decisive first.
 *
 * The order is not arbitrary. Plan and enablement are facts about the account
 * and the catalogue; capability is a fact about the model; the context check
 * is the only one that depends on the size of this particular turn, so it runs
 * last and only on models still standing. A model is reported with the *first*
 * reason it failed, because a list of every way a model is unsuitable is
 * noise — what a routing decision has to explain is why the model was not
 * available, and the first blocking fact is that answer.
 */
export function filterRouterCandidates(
    input: RouterCandidateInput
): RouterCandidateResult {
    const unhealthy = new Set(input.unhealthyModelIds ?? []);
    const regionBlocked = new Set(input.regionBlockedModelIds ?? []);
    // Both sides or neither: an available budget with no per-model prices
    // would silently pass every model, which reads as "affordable" when it
    // means "not checked".
    const checkCredits =
        typeof input.availableCredits === "number" &&
        input.creditsByModelId !== undefined;

    const eligible: RouterCandidate[] = [];
    const rejected: { modelId: string; reason: CandidateRejection }[] = [];
    const reject = (modelId: string, reason: CandidateRejection) => {
        rejected.push({ modelId, reason });
    };

    for (const model of input.models) {
        if (!model.enabled || model.publiclyListed === false) {
            reject(model.id, "disabled");
            continue;
        }
        if (!canUseModelWithPlan(input.plan, model)) {
            reject(model.id, "plan");
            continue;
        }
        if (unhealthy.has(model.id)) {
            reject(model.id, "unhealthy");
            continue;
        }
        if (regionBlocked.has(model.id)) {
            reject(model.id, "region_unavailable");
            continue;
        }
        if (input.profile.hasImageInput && !modelSupportsImageInput(model)) {
            reject(model.id, "image_input_unsupported");
            continue;
        }
        if (input.profile.needsCurrentInformation) {
            const support = getWebSearchCapability(model.id).support;
            if (support === "unsupported") {
                reject(model.id, "web_search_unsupported");
                continue;
            }
            // Unverified is not a maybe. The capability register leaves a
            // model unverified precisely because nobody confirmed it, and
            // Auto choosing one on the user's behalf would turn an unchecked
            // assumption into a failed answer they paid for.
            if (support === "unverified") {
                reject(model.id, "web_search_unverified");
                continue;
            }
        }
        if (checkCredits) {
            const price = input.creditsByModelId?.[model.id];
            // A model with no price is not free; it is unpriced, and an
            // unpriced model cannot be shown to be affordable.
            if (typeof price !== "number" || price > input.availableCredits!) {
                reject(model.id, "insufficient_credits");
                continue;
            }
        }

        const budget = fitChatOutputToContextWindow({
            contextWindowTokens: model.contextWindowTokens,
            reservedInputTokens: input.reservedInputTokens,
            requestOutputCapTokens: input.requestOutputCapTokens,
        });
        if (budget.kind === "unbounded") {
            // The manual path still allows this; Auto does not. See the module
            // comment: the difference is who made the choice.
            reject(model.id, "context_window_undeclared");
            continue;
        }
        if (budget.kind === "exceeded") {
            reject(model.id, "context_exceeded");
            continue;
        }
        eligible.push({ modelId: model.id, outputTokens: budget.outputTokens });
    }

    return { version: ROUTER_CANDIDATE_VERSION, eligible, rejected };
}
