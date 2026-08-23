/**
 * What the badge beside an assistant answer is allowed to say (UI contract:
 * the badge reports web search, and nothing else).
 *
 * The badge used to carry a sixth state, "training knowledge", on the `else`
 * branch of the web-search check: any answer that had not searched the web was
 * declared to have come from the model's training alone. That was a claim
 * about the *source of the answer*, made by a control that only ever looked at
 * one input -- whether a web search had been requested.
 *
 * It is now wrong often enough to matter. An answer can also be grounded in
 * the account's long-term memory (import/memory policy §8) or in an assistant
 * profile's knowledge files (§14), and this badge knows about neither. During
 * the assistant-knowledge staging round it was observed twice on answers that
 * had quoted the user's own uploaded file, and turning memory injection on
 * would reproduce it on answers built from the user's own stored memories.
 * Telling someone their own document was the model's training data is not a
 * cosmetic defect: it is the badge telling them the wrong thing about where
 * their answer came from.
 *
 * So the badge is narrowed to the one question it actually has an input for.
 * `requested: false` becomes "no web search" -- a statement about the search,
 * not about what did ground the answer. What *did* ground it is stated by the
 * disclosures that own that fact and are counted by the server:
 * `memory-usage-disclosure` today (§13.4), and the knowledge attribution that
 * follows it.
 *
 * The second change is that a message with no `searchMetadata` gets no badge.
 * That field is written on every assistant message the current code
 * *persists* (`normalizeWebSearchExecution` always returns an object), so on a
 * finished message its absence means exactly one thing: the row predates the
 * field. The old fallback guessed from the model's provider and usage class --
 * Perplexity research models were reported as "executed" -- which is an
 * assertion about a turn no record survives for. A badge that has to guess is
 * a badge that should not render.
 *
 * "Persists" is load-bearing, and reading it as "has" cost the Deep Research
 * badge. `searchMetadata` reaches the client in the stream's trailer, at the
 * end (`ChatApp.tsx`), so a turn that is still running has none -- and the
 * `!meta` guard, written for rows older than the field, was hiding the badge
 * on every in-flight answer as well. For a Deep Research turn that is the
 * whole visible run: the job is asynchronous, so "still running" is the state
 * the panel sits in for as long as the research takes.
 *
 * `generating` separates the two populations the absence of metadata covers.
 * A running turn is a fact about *now*, so the mode it is running in can be
 * reported from the model's usage class -- that is what the badge said before
 * this module existed. A finished message with no record is still a row from
 * before the field, and still gets nothing: this is not a way back in for the
 * provider guess, which is why the mode is the only status reachable here.
 *
 * Pure, so the whole matrix is testable without a browser
 * (tests/webSearchStatusBadge.test.mjs).
 */

/** The search facts a persisted message carries. A subset of WebSearchExecution. */
export type WebSearchBadgeMetadata = {
    requested: boolean;
    supported: boolean;
    executed: boolean;
    failureCode?: string;
};

export type WebSearchBadgeStatus =
    /** The model searches as part of every answer; the turn's mode, not its outcome. */
    | "deep-research"
    /** No web search was asked for. Says nothing about what else grounded the answer. */
    | "not-searched"
    | "unsupported"
    | "failed"
    | "executed"
    /** Asked for, supported, no failure, and still no search -- the refunded case. */
    | "requested-not-executed";

export type WebSearchBadgeDecision =
    | { shown: false }
    | { shown: true; status: WebSearchBadgeStatus };

const HIDDEN: WebSearchBadgeDecision = { shown: false };

export function decideWebSearchBadge(input: {
    /**
     * `Message.searchMetadata`. Absent on a turn that is still running -- it
     * arrives in the stream trailer -- and on rows older than the field.
     */
    searchMetadata: WebSearchBadgeMetadata | null | undefined;
    /** `modelInfo.usageClass` for the model that answered. */
    usageClass: string | null | undefined;
    /** True while this turn is still streaming, so its trailer has not landed. */
    generating?: boolean;
}): WebSearchBadgeDecision {
    const meta = input.searchMetadata;
    const isDeepResearch = input.usageClass === "deep-research";
    // Before the usage-class branch on purpose: with no record of the turn
    // there is nothing to report, and a Deep Research label on a row from
    // before the field would be describing the model rather than the answer.
    //
    // A turn still in flight is the exception, and only for the mode: the run
    // is happening now, so naming it describes this answer rather than
    // guessing at one nobody kept a record of.
    if (!meta) {
        return input.generating && isDeepResearch
            ? { shown: true, status: "deep-research" }
            : HIDDEN;
    }
    if (isDeepResearch) {
        return { shown: true, status: "deep-research" };
    }
    if (!meta.requested) return { shown: true, status: "not-searched" };
    if (!meta.supported) return { shown: true, status: "unsupported" };
    if (meta.failureCode) return { shown: true, status: "failed" };
    if (meta.executed) return { shown: true, status: "executed" };
    return { shown: true, status: "requested-not-executed" };
}
