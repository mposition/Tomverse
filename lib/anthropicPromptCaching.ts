import type { ProviderOptions } from "@ai-sdk/provider-utils";
import type { AiModel } from "@/lib/models";

/**
 * Anthropic automatic prompt caching, and the list of call paths that get it.
 *
 * Policy: docs/policy/anthropic-prompt-caching.md.
 *
 * Two decisions live here and nowhere else, because both were wrong by default
 * and neither announces itself when it is.
 *
 * ## 1. Which provider
 *
 * `providerOptions.anthropic` is not "options for Anthropic". It is the
 * namespace `@ai-sdk/anthropic` reads, and `lib/activeAiModel.ts` builds
 * MiniMax's client with `createAnthropic()` too -- pointed at
 * `https://api.minimax.io/anthropic/v1`. So a `cacheControl` written into that
 * namespace for "the Anthropic provider" reaches MiniMax as well, where it
 * would be sent to an endpoint whose caching semantics and price this
 * application has never verified. The gate is therefore `provider ===
 * "anthropic"` -- the registry's own provider identity, which is what decides
 * the base URL and the price profile -- and never "does this model use the
 * Anthropic SDK".
 *
 * ## 2. Which call path
 *
 * Caching is a prefix match, so it pays only where the same prefix comes back.
 * On a path that never repeats a prefix, a `cache_control` marker is a pure
 * 1.25x surcharge on bytes nothing ever reads back, and -- worse for the thing
 * this was turned on to measure -- it puts cache-creation tokens into the
 * organisation's usage report that no read will ever offset, so the hit rate
 * the seven-day report computes is depressed by traffic that was never a
 * caching candidate.
 *
 * That is why this is a table of named paths rather than a boolean. Each entry
 * says whether the path repeats a prefix and why, so adding a call site is a
 * decision somebody wrote down rather than a default that got inherited.
 *
 * ## Launch scope: `chat_turn` only
 *
 * Four paths that were `true` when this table was written are now `false`, and
 * the reason is not that their prefixes turned out to be worse. It is that a
 * caching path has three parts and they were only wired on two paths:
 *
 *   1. `createChatBudget(..., { promptCachePath })` -- so the provider budget
 *      authorises the 1.25x write premium before dispatch;
 *   2. `getModelGenerationSettings(..., { promptCachePath })` -- so the
 *      request actually carries the marker;
 *   3. `settleChatUsage(..., { cacheWriteInputTokens })` -- so the write is
 *      billed at 1.25x instead of disappearing into the uncached remainder.
 *
 * `comparison_review`, `comparison_review_verify_item` and `compare_summary`
 * had (2) and neither (1) nor (3): they would have sent a cache marker against
 * a budget that never authorised it, and then settled the resulting writes at
 * the plain input rate. Both halves are silent -- an under-authorised turn
 * still dispatches, and an under-billed one still settles -- so nothing would
 * have reported it.
 *
 * Turning them off is the fix rather than wiring the other two parts, because
 * the prefix argument each of them rested on has not been demonstrated either
 * (see each entry). Two unproven things at once is not a launch.
 *
 * `tests/anthropicPromptCachingWiring.test.mjs` now fails if any `caches: true`
 * path is missing any of the three, so the gap cannot reopen silently.
 *
 * ## Re-enabling a path
 *
 * A `false` here becomes `true` only with the evidence named in
 * docs/policy/anthropic-prompt-caching.md section 2.1: a byte-identical
 * rendered prefix across two real dispatches on the same Anthropic model,
 * measured on a path that actually reaches the provider. A re-run answered
 * from the `ComparisonReview` input-hash cache is not evidence -- the request
 * that would have read the prompt cache is precisely the one that never
 * happens.
 */
export type AnthropicPromptCachePath =
    /** A chat turn. The conversation prefix is resent every turn. */
    | "chat_turn"
    /** A chat turn's automatic fallback to a second model. */
    | "chat_fallback_turn"
    /** AI Review over a comparison's answers. */
    | "comparison_review"
    /**
     * Re-checking one item of an existing review.
     *
     * Its own path rather than a reuse of `comparison_review`, because the two
     * are different requests: this one is a single item and its own prompt, and
     * sharing a path would make one policy decision cover two prefixes nobody
     * compared. A shared path also hides a coverage gap -- the wiring test
     * below checks each path's call sites, and a path used from two routes
     * passes as soon as one of them is wired.
     */
    | "comparison_review_verify_item"
    /** The one-shot summary of a comparison. */
    | "compare_summary"
    /** Naming a conversation from its opening turns. */
    | "conversation_title"
    /** The scheduled provider health probe. */
    | "provider_probe"
    /** The admin-triggered provider credential check. */
    | "provider_verification"
    /** Memory extraction over a finished conversation. */
    | "memory_extraction";

type PromptCachePathPolicy = {
    /** Whether requests on this path carry `cache_control`. */
    caches: boolean;
    /** Why -- the repeated prefix, or the reason there is not one. */
    rationale: string;
};

export const ANTHROPIC_PROMPT_CACHE_PATHS: Readonly<
    Record<AnthropicPromptCachePath, PromptCachePathPolicy>
> = {
    chat_turn: {
        caches: true,
        rationale:
            "The whole reason the feature exists. Turn N+1 resends turns 1..N " +
            "byte-identically ahead of the new question, so the automatic " +
            "breakpoint moves forward over a prefix that is already cached.",
    },
    chat_fallback_turn: {
        caches: false,
        rationale:
            "Held out of the first launch scope. The earlier rationale was that " +
            "a fallback reads its own entry from an earlier turn that fell back " +
            "the same way -- which requires the same conversation to fail over " +
            "to the same model twice inside five minutes, and nothing measures " +
            "how often that happens. Automatic fallback is rare by design, so " +
            "the likely shape is a write per fallback and no read at all: a " +
            "1.25x surcharge on the turns a user is already waiting longer for. " +
            "Re-enabling needs the fallback re-dispatch rate from routing " +
            "telemetry, not an argument from symmetry with the primary.",
    },
    comparison_review: {
        caches: false,
        rationale:
            "Held out of the first launch scope, and the claim it rested on was " +
            "wrong. 'One comparison is reviewed more than once' describes a " +
            "re-run, and a re-run does not reach the provider: the stored " +
            "`ComparisonReview` row is keyed on an input hash and answered from " +
            "the database, so the second request that would have read the cache " +
            "is the one that never happens. Re-enabling needs the evidence in " +
            "docs/policy/anthropic-prompt-caching.md section 2.1.",
    },
    comparison_review_verify_item: {
        caches: false,
        rationale:
            "A single item of an existing review, re-checked on demand. One " +
            "request per item per user action, over a prompt built from that " +
            "item -- so there is no second request with this prefix, whatever " +
            "the full review does. Named separately from `comparison_review` " +
            "precisely so a decision about that path cannot silently become a " +
            "decision about this one.",
    },
    compare_summary: {
        caches: false,
        rationale:
            "Held out of the first launch scope. It shares the comparison's " +
            "answers with the review path, but 'shares content with another " +
            "request' is not the same as 'repeats a prefix': caching is a " +
            "byte-prefix match over tools, then system, then messages, and the " +
            "summary's system prompt and instructions differ from the review's " +
            "from the first token. Nothing has compared the two rendered " +
            "prefixes, and until something has, this is a guess.",
    },
    conversation_title: {
        caches: false,
        rationale:
            "One request per conversation, over that conversation's own opening " +
            "text. There is no second request with this prefix, so a marker " +
            "here buys a 1.25x write that nothing reads. The fixed instruction " +
            "in front of it is far below any model's minimum cacheable prefix.",
    },
    provider_probe: {
        caches: false,
        rationale:
            "A synthetic health check, 144 times a day, over a two-line prompt. " +
            "Excluded for two reasons and either would be enough: the prompt is " +
            "well under the minimum cacheable prefix so nothing would cache " +
            "anyway, and a probe must exercise the ordinary request path " +
            "without adding parameters -- adding one has broken this probe " +
            "twice, and each time the rejection was recorded as provider " +
            "health. See lib/providerProbe.ts.",
    },
    provider_verification: {
        caches: false,
        rationale:
            "A one-shot credential check with a fixed tiny prompt, run when an " +
            "administrator asks. Same reasoning as the probe.",
    },
    memory_extraction: {
        caches: false,
        rationale:
            "Runs once per conversation over that conversation's transcript. A " +
            "second extraction is a different transcript, so there is no " +
            "repeated prefix to read back.",
    },
};

/**
 * The only TTL this application requests.
 *
 * 5 minutes, and 1 hour deliberately unimplemented. The 1-hour entry costs 2x
 * base input to write against the 5-minute entry's 1.25x, so it pays only when
 * requests sharing a prefix start more than five minutes apart -- and a read
 * refreshes the timer at no cost, so continuous traffic keeps a 5-minute entry
 * alive indefinitely and the doubled write buys nothing.
 *
 * Whether Tomverse's traffic has those gaps is a question about production
 * data this repository does not hold, and -- importantly -- one the seven-day
 * report cannot answer either. That report aggregates per day and per model,
 * and the quantity the TTL decision turns on is the *start-to-start gap
 * between consecutive requests that share a prefix*. A daily total cannot
 * distinguish traffic evenly spread across a day from the same traffic in two
 * bursts twelve hours apart; both produce the same row.
 *
 * What could answer it is in docs/policy/anthropic-prompt-caching.md section 3.1:
 * a privacy-safe prefix-digest histogram of re-call intervals, or a 5m/1h
 * canary split. Until one of them has run, the cheaper write is the one that
 * cannot be wrong by much.
 *
 * Sent explicitly rather than left to the provider's default so the value is
 * in the request bytes -- and therefore in the manifest's effective-request
 * hash, where a later reader can see which TTL a stored turn was dispatched
 * with instead of inferring it from the date of a deploy.
 */
export const ANTHROPIC_PROMPT_CACHE_TTL = "5m" as const;

/**
 * The provider options that turn on automatic caching, or undefined.
 *
 * Automatic (a single top-level `cache_control`) rather than explicit
 * breakpoints: the SDK places the breakpoint on the last cacheable block and
 * moves it forward as the conversation grows, which is exactly the multi-turn
 * pattern this application needs, and it needs no per-block bookkeeping in a
 * prompt assembled by several different code paths.
 *
 * Returns options rather than mutating any, so the caller merges it one
 * namespace deep and `thinking`/`effort` -- which live in the same `anthropic`
 * namespace -- survive. A shallow spread would replace them, and the symptom
 * of that is a model that silently stops reasoning.
 */
export const anthropicPromptCacheOptions = (
    model: Pick<AiModel, "provider">,
    path: AnthropicPromptCachePath
): ProviderOptions | undefined => {
    if (model.provider !== "anthropic") return undefined;
    if (!ANTHROPIC_PROMPT_CACHE_PATHS[path]?.caches) return undefined;
    return {
        anthropic: {
            cacheControl: { type: "ephemeral", ttl: ANTHROPIC_PROMPT_CACHE_TTL },
        },
    };
};

/**
 * Whether a request on this path will carry a cache marker, for callers that
 * need to know before the options exist.
 *
 * The reservation is the one that does: a request that may write its whole
 * prompt into the cache costs 1.25x its input in the worst case, and the
 * provider budget has to have authorised that before the request goes out --
 * not discovered it at settlement, which is after the money is spent.
 */
export const anthropicPromptCacheApplies = (
    model: Pick<AiModel, "provider">,
    path: AnthropicPromptCachePath
) => anthropicPromptCacheOptions(model, path) !== undefined;

/**
 * A model-specific minimum below which the provider silently does not cache.
 *
 * Recorded for the report and for anybody reading a low hit rate, and
 * deliberately *not* used to suppress the marker. A prompt under the minimum
 * is a cache miss, not an error: the provider writes nothing, charges nothing
 * extra, and returns zero cache-creation tokens. Withholding the marker below
 * some estimated size would instead mean deciding from this application's own
 * token estimate -- which is an estimate, and is the one that would have to be
 * right for the guess to be safe.
 *
 * Null for a model whose minimum has not been verified against Anthropic's own
 * documentation. Absent, not assumed.
 */
export const ANTHROPIC_MIN_CACHEABLE_PREFIX_TOKENS: Readonly<
    Record<string, number>
> = {
    // Anthropic's published per-model minimums. Not monotonic across
    // generations, which is exactly why they are listed rather than derived:
    // Haiku 4.5's 4,096 is eight times Opus 5's 512.
    //
    // Keyed by Tomverse model id, and the first row is the one to read twice:
    // `claude-opus-4-8` is this catalogue's stable id for Claude *Opus 5*
    // (`apiModelId: "claude-opus-5"`), so it takes Opus 5's 512 and not Opus
    // 4.8's 1,024. Reading the minimum off the Tomverse id's family name is
    // the mistake this comment exists to stop.
    "claude-opus-4-8": 512,
    "claude-fable-5": 512,
    "claude-sonnet-5": 1_024,
    "claude-haiku-4-5": 4_096,
};
