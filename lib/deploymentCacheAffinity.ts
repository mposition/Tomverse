/**
 * What a deployment's prompt cache is known to do, and which deployment a
 * conversation's turns have been landing on.
 *
 * Dark. Nothing reads either fact yet.
 *
 * ## Why this is two facts and not one number
 *
 * The routing ADR asks for `P(cache_hit | session, deployment)` folded into an
 * effective cost. Two reasons that is not what is here.
 *
 * The first is scope: folding a saving into cost is a change to the objective
 * function, and the objective function is lexicographic by decision
 * (`ROUTER_TIE_BREAK_ORDER` in lib/routerScorePolicy.ts). A probability
 * multiplied by a price is a weighted sum whichever name it is given.
 *
 * The second is that the probability cannot be computed from anything this
 * repository holds. A cache hit needs a byte-identical prefix, and no table
 * here records a prefix or a digest of one -- deliberately, because a prefix
 * digest is derived from what the person wrote, and routing telemetry stays
 * content-free for the same reason `ComparisonReviewRun` does. So a
 * `P(cache_hit)` written today would be a prior with a decimal point on it,
 * which is the one thing the surrounding work has refused at every step.
 *
 * What can be said without inventing anything is two observable things:
 *
 *   1. whether this deployment's cache has been verified, and if so what its
 *      window is -- a fact about the provider, established by a dispatch
 *      somebody recorded;
 *   2. which deployment this conversation's turns last went to, and when -- a
 *      fact about us.
 *
 * Put together they answer "is the last serve inside the verified window", and
 * that is all `cacheWindowState()` claims. It is a comparison of two clocks.
 * **It is not a cache-hit prediction**: the prefix may have changed between
 * turns, and nothing here would know.
 *
 * ## This does not decide whether to send a cache marker
 *
 * That decision is `lib/anthropicPromptCaching.ts` and stays there. It gates on
 * the registry's provider identity, because `createAnthropic()` also builds
 * MiniMax's client and a marker written for "the Anthropic provider" would
 * reach an endpoint whose caching semantics were never verified. A capability
 * column on a deployment that a dispatcher consulted instead would be a second
 * answer to that question, and the two would drift.
 *
 * `promptCacheSupport` says what a *provider* was observed to do, so that a
 * future ranking can tell a deployment with no cache from one nobody has
 * checked. It is not an instruction to any call path.
 *
 * Pure: no database, no clock, no network.
 */

/**
 * What is known about a deployment's prompt cache.
 *
 * `unproven` is the default and is not a synonym for either of the others. A
 * deployment nobody has checked is not "no cache" -- treating it as such would
 * quietly write off a saving -- and it is not a cache either. It abstains, the
 * same way an unmeasured signal abstains everywhere else in this work.
 *
 * `verified_absent` is a finding: somebody dispatched twice and the provider
 * charged full price both times.
 *
 * The last two split on who sends what, because a ranking that could not tell
 * them apart would be assuming a marker either is or is not needed:
 *
 * - `verified_automatic` -- the provider caches a repeated prefix on its own,
 *   as OpenAI does. Nothing in the request asks for it.
 * - `verified_explicit` -- the request must carry a marker, as Anthropic's
 *   `cache_control` does, and the write costs a premium the plain rate does
 *   not.
 *
 * **The word `automatic` means something else two modules over.**
 * `lib/anthropicPromptCaching.ts` says "Anthropic automatic prompt caching"
 * about a path that sends a top-level `cache_control` marker. In this list
 * that is `verified_explicit`. An Anthropic deployment recorded as
 * `verified_automatic` because of that sentence would be read as one needing
 * no marker and paying no write premium.
 *
 * **Nothing here tells the two apart yet.** Both are in
 * `VERIFIED_CACHING_SUPPORT_STATES`, so `cacheWindowState()` answers the same
 * for either, and `promptCacheCapabilityProblems()` judges them together.
 * They are two stored facts and one behaviour; the split exists so that a
 * ranking which does need to tell them apart is not first having to work out
 * which deployments needed a marker.
 */
export const PROMPT_CACHE_SUPPORT_STATES = [
    "unproven",
    "verified_absent",
    "verified_automatic",
    "verified_explicit",
] as const;

export type PromptCacheSupport = (typeof PROMPT_CACHE_SUPPORT_STATES)[number];

/** The support states that mean a cache was observed to exist. */
export const VERIFIED_CACHING_SUPPORT_STATES: readonly PromptCacheSupport[] = [
    "verified_automatic",
    "verified_explicit",
];

export type PromptCacheCapabilityInput = {
    promptCacheSupport: string;
    promptCacheMinPrefixTokens?: number | null;
    promptCacheTtlSeconds?: number | null;
    promptCacheVerifiedAt?: Date | null;
    promptCacheEvidenceRef?: string | null;
};

/**
 * Whether a reference says nothing.
 *
 * The character set is written out rather than left to `String.trim()`,
 * because the database has to reject exactly the same strings and the two
 * definitions do not match by default: `trim()` strips U+00A0 and every other
 * Unicode space, while PostgreSQL's `btrim` strips only U+0020. A row whose
 * evidence was a single tab passed the constraint and failed here.
 *
 * So both sides use this list and nothing else. A non-breaking space counts
 * as a character in both.
 */
const BLANK_CHARACTERS = /^[ \t\n\r\f\v]*$/;

const blank = (value: string | null | undefined): boolean =>
    value === null || value === undefined || BLANK_CHARACTERS.test(value);

/**
 * Why a deployment's cache capability is not well formed, or an empty list.
 *
 * The database holds the same rules. Here so a caller can say which part is
 * wrong rather than only that the write failed.
 */
export const promptCacheCapabilityProblems = (
    input: PromptCacheCapabilityInput
): readonly string[] => {
    const problems: string[] = [];
    const support = input.promptCacheSupport;

    if (!(PROMPT_CACHE_SUPPORT_STATES as readonly string[]).includes(support)) {
        problems.push(`unknown prompt cache support ${JSON.stringify(support)}`);
        return problems;
    }

    const ttl = input.promptCacheTtlSeconds ?? null;
    const minPrefix = input.promptCacheMinPrefixTokens ?? null;

    if (ttl !== null && ttl <= 0) {
        problems.push("a cache window is longer than nothing");
    }
    if (minPrefix !== null && minPrefix < 0) {
        problems.push("a minimum prefix is not negative");
    }

    // An unproven deployment carries no figures, because a figure is the
    // result of the verification that has not happened. A number sitting
    // beside `unproven` is a number nobody can say where it came from, and it
    // would be read as one somebody measured.
    if (support === "unproven") {
        if (ttl !== null || minPrefix !== null) {
            problems.push("an unproven cache has no measured figures");
        }
        // Present-but-blank counts. The constraint requires the column to be
        // NULL here, so accepting an empty string would be this validator
        // passing a row the database refuses.
        if (
            input.promptCacheVerifiedAt ||
            input.promptCacheEvidenceRef !== null &&
                input.promptCacheEvidenceRef !== undefined
        ) {
            problems.push("an unproven cache has no verification");
        }
        return problems;
    }

    // Every other state is a claim that somebody checked, so it names when and
    // what. Without both, "verified" is a word rather than a record.
    if (!input.promptCacheVerifiedAt) {
        problems.push("a verified cache says when it was verified");
    }
    if (blank(input.promptCacheEvidenceRef)) {
        problems.push("a verified cache names its evidence");
    }

    if (support === "verified_absent") {
        // The finding is that there is no cache. A window for a cache that
        // does not exist is the contradiction this stops.
        if (ttl !== null || minPrefix !== null) {
            problems.push("a cache found absent has no window");
        }
        return problems;
    }

    // A cache with no window cannot be aged, so it would be believed forever --
    // the same failure `QuotaCapacityState` stops with its refill time.
    if (ttl === null) {
        problems.push("a verified cache says how long it holds");
    }

    return problems;
};

export type CacheAffinityInput = {
    conversationId: string;
    logicalModelId: string;
    modelDeploymentId: string;
    servedTurns: number;
};

/** Why an affinity row is not well formed, or an empty list. */
export const cacheAffinityProblems = (
    input: CacheAffinityInput
): readonly string[] => {
    const problems: string[] = [];

    if (blank(input.conversationId)) {
        problems.push("an affinity names the conversation it is about");
    }
    if (blank(input.logicalModelId)) {
        problems.push("an affinity names the model the person chose");
    }
    if (blank(input.modelDeploymentId)) {
        problems.push("an affinity names the deployment that served it");
    }
    // A row exists because a turn landed somewhere. Zero would be a row about
    // an event that did not happen.
    if (!Number.isInteger(input.servedTurns) || input.servedTurns < 1) {
        problems.push("an affinity counts at least the turn that created it");
    }

    return problems;
};

/**
 * Where the last serve sits relative to the verified cache window.
 *
 * - `unproven` -- nobody has checked this deployment's cache. Abstains.
 * - `no_cache_here` -- checked, and there is none.
 * - `never_served` -- this conversation has not been on this deployment.
 * - `within_ttl` -- the last serve was inside the verified window.
 * - `past_ttl` -- it was not.
 */
export const CACHE_WINDOW_STATES = [
    "unproven",
    "no_cache_here",
    "never_served",
    "within_ttl",
    "past_ttl",
] as const;

export type CacheWindowState = (typeof CACHE_WINDOW_STATES)[number];

/**
 * Compare two clocks and say which side of the window the last serve is on.
 *
 * **Not a cache-hit prediction.** `within_ttl` means less than the verified
 * window has passed, and nothing more. The boundary is exclusive: at exactly
 * the TTL the window has elapsed, so that is `past_ttl`. Whether the prefix is still byte-identical is
 * a question about content, and this module holds none -- a turn that added an
 * attachment or edited the system prompt returns `within_ttl` and would miss.
 *
 * Reading this as a probability is the misuse it is named to prevent.
 */
export const cacheWindowState = (input: {
    promptCacheSupport: string;
    promptCacheTtlSeconds?: number | null;
    lastServedAt?: Date | null;
    now: Date;
}): CacheWindowState => {
    // `no_cache_here` is a finding -- somebody dispatched twice and the
    // provider charged full price both times. Only the state that records
    // that finding may produce it. An unrecognised string is not a finding,
    // and an earlier version answered one for it.
    if (input.promptCacheSupport === "verified_absent") return "no_cache_here";
    if (
        !(VERIFIED_CACHING_SUPPORT_STATES as readonly string[]).includes(
            input.promptCacheSupport
        )
    ) {
        return "unproven";
    }
    if (!input.lastServedAt) return "never_served";

    const ttl = input.promptCacheTtlSeconds ?? null;
    // A verified cache without a window is refused at write time. Reaching
    // here means the row predates the constraint or was not validated, and the
    // honest answer is that nothing is known rather than a window of zero.
    if (ttl === null || ttl <= 0) return "unproven";

    const elapsedMs = input.now.getTime() - input.lastServedAt.getTime();
    // A serve in the future is a clock disagreement, not a fresh cache.
    if (elapsedMs < 0) return "unproven";

    // Exclusive. At exactly the TTL the window has elapsed; calling that
    // `within_ttl` would be the one boundary where the name is a claim the
    // provider would not agree with.
    return elapsedMs < ttl * 1000 ? "within_ttl" : "past_ttl";
};
