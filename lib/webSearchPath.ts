/**
 * Whether one dispatch will actually be able to search, as opposed to being
 * allowed to.
 *
 * `lib/routerCandidates.ts` filters on the *declared* capability: the register
 * says `native`, `search-model`, `unverified` or `unsupported`, and a turn that
 * needs current information keeps the first two. That is the right question for
 * a filter -- it runs before there is an attempt to configure or a cost to
 * reserve -- but it is not the same question as "will this attempt search".
 *
 * A `search-model` searches as part of ordinary completion, so passing the
 * filter is the whole story. A `native` model searches only when the dispatch
 * also enables its tool, and the dispatch only does that when the user's web
 * search mode is `always`. So a turn whose profile says it needs current
 * information, sent to a native model while the mode is `auto` or `off`, is a
 * turn the filter admitted on the grounds that the model can search and that
 * then does not search. Nothing was wrong with the filter; the two facts are
 * simply different, and only one of them was ever checked.
 *
 * This is that second check, in the units the dispatch actually has: what the
 * register says, what mode the turn is in, whether a tool configuration was
 * built, and whether the surcharge behind it was reserved. Reading the built
 * plan rather than rebuilding it is deliberate -- a second construction of the
 * tool configuration would be free to disagree with the one being dispatched,
 * and the disagreement would only ever show as this check passing for a
 * request that carried no tools.
 *
 * Pure, and deliberately free of `server-only` so the matrix can be tested
 * without a provider SDK in scope.
 *
 * See `docs/policy/tomverse-chat-router-score-policy.md` §8.
 */

import type { WebSearchMode } from "@/lib/appDefaults";
import type { WebSearchSupport } from "@/lib/webSearchCapability";

export const SEARCH_PATH_GAPS = [
    /** The register says this model cannot search at all. */
    "capability_unsupported",
    /**
     * Nobody confirmed that it can. Same treatment as unsupported, and for the
     * same reason the candidate filter gives: Auto choosing an unverified
     * model on the user's behalf turns an unchecked assumption into a failed
     * answer the account paid for.
     */
    "capability_unverified",
    /**
     * Native, but this turn did not enable the tool -- the web search mode is
     * `auto` or `off`. The model could search; on this turn it will not.
     */
    "mode_not_always",
    /**
     * Native and enabled, and still no tool configuration was built. The
     * register and the tool builder disagree about the provider, which is a
     * defect rather than a state -- recorded as its own reason so it cannot
     * hide inside "the mode was wrong".
     */
    "tool_config_unavailable",
    /**
     * A native tool with no surcharge reserved behind it. The reservation is
     * what pays for the search, so a request configured to search without one
     * is either an unbilled search or a tool that will not run; both are worth
     * a name.
     */
    "surcharge_unreserved",
] as const;

export type SearchPathGap = (typeof SEARCH_PATH_GAPS)[number];

export type AttemptSearchPath =
    /** Searches as part of ordinary completion; nothing else is required. */
    | { kind: "search_model" }
    /** The provider-native tool is configured and paid for on this attempt. */
    | { kind: "native_tool" }
    | { kind: "none"; gap: SearchPathGap };

export type AttemptSearchPathInput = {
    /** What the capability register says about the model being dispatched. */
    support: WebSearchSupport;
    /** The turn's web search mode, as the request carries it. */
    webSearchMode: WebSearchMode | null;
    /** Whether a tool configuration was actually built for this attempt. */
    toolConfigBuilt: boolean;
    /** Surcharge credits reserved for this attempt's search. */
    surchargeCredits: number;
};

export const resolveAttemptSearchPath = ({
    support,
    webSearchMode,
    toolConfigBuilt,
    surchargeCredits,
}: AttemptSearchPathInput): AttemptSearchPath => {
    if (support === "search-model") return { kind: "search_model" };
    if (support === "unsupported") {
        return { kind: "none", gap: "capability_unsupported" };
    }
    if (support === "unverified") {
        return { kind: "none", gap: "capability_unverified" };
    }
    // Native from here down.
    if (webSearchMode !== "always") {
        return { kind: "none", gap: "mode_not_always" };
    }
    if (!toolConfigBuilt) {
        return { kind: "none", gap: "tool_config_unavailable" };
    }
    if (!(surchargeCredits > 0)) {
        return { kind: "none", gap: "surcharge_unreserved" };
    }
    return { kind: "native_tool" };
};

export const hasSearchPath = (path: AttemptSearchPath) => path.kind !== "none";
