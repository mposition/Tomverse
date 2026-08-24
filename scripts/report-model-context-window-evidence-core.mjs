/**
 * What each provider says the context window of a model it serves is, beside
 * what Tomverse declares for it.
 *
 * 16 enabled models declare no context window, and `check:router-context-window`
 * holds that as a ratcheted baseline until ESTIMATE-03 is approved. Closing it
 * means writing 16 numbers into lib/models.ts, and the one thing that must not
 * happen is somebody typing them from memory: `fitChatOutputToContextWindow`
 * treats a declared window as the ceiling a request is clamped to, so a number
 * that is too large is worse than no number at all. No number skips the guard
 * and is at least visible as a gap; a wrong number passes the guard by
 * inventing headroom, and the over-limit request reaches the provider anyway.
 *
 * The provider catalog monitor already records the answer. It reads each
 * provider's own model-list endpoint and stores `context_length` /
 * `max_context_length` as `metadata.contextLength` on ProviderModelCatalogEntry
 * (lib/providerModelCatalogCore.ts). That is a figure the provider published
 * about its own model, refreshed on a schedule, with a `lastSeenAt` beside it.
 *
 * This splits the 16 into the ones that can be closed from evidence already in
 * the database and the ones that need a person to read a documentation page --
 * because those are different tasks, and lumping them together is how the
 * second kind gets guessed.
 *
 * Pure, so the rule that decides which bucket a model lands in can be tested
 * without a database.
 */

/** Providers whose list endpoint is known not to answer this question. */
export const KNOWN_SILENT_SOURCES = {
    perplexity:
        "Perplexity's v1/models describes Agent API models, not the Chat " +
        "Completions Sonar entries Tomverse sends; lib/providerModelCatalogMonitor.ts " +
        "already refuses to read retirement from it for the same reason.",
};

/**
 * @param {{
 *   models: readonly {
 *     id: string, provider: string, apiModel: string, minimumPlan?: string,
 *     contextWindowTokens?: number | null,
 *   }[],
 *   catalogEntries: readonly {
 *     provider: string, apiModel: string, lifecycle?: string | null,
 *     lastSeenAt?: Date | string | null,
 *     metadata?: Record<string, unknown> | null,
 *   }[],
 * }} input
 */
export function modelContextWindowEvidence({ models, catalogEntries }) {
    // Keyed on the pair, not a concatenation: a separator that can occur in
    // either half silently merges two models, and one that cannot is an
    // invisible character in the source. `JSON.stringify` of the pair is
    // injective by construction and readable.
    const key = (provider, apiModel) => JSON.stringify([provider, apiModel]);
    const byKey = new Map(
        catalogEntries.map((entry) => [key(entry.provider, entry.apiModel), entry])
    );

    const rows = models
        .filter((model) => !model.contextWindowTokens)
        .map((model) => {
            const entry = byKey.get(key(model.provider, model.apiModel)) ?? null;
            const metadata = entry?.metadata ?? null;
            const numeric = (value) =>
                typeof value === "number" && Number.isFinite(value) && value > 0
                    ? value
                    : null;

            // `contextLength` is the total window. `inputTokenLimit` is what
            // some providers publish instead, and it is not the same figure --
            // it excludes the answer. Recorded separately rather than folded
            // into one "evidence" number, because declaring an input limit as
            // a context window would overstate the room by the size of every
            // reply.
            const contextLength = numeric(metadata?.contextLength);
            const inputTokenLimit = numeric(metadata?.inputTokenLimit);
            const outputTokenLimit = numeric(metadata?.outputTokenLimit);

            return {
                modelId: model.id,
                provider: model.provider,
                apiModel: model.apiModel,
                minimumPlan: model.minimumPlan ?? null,
                observed: entry !== null,
                lifecycle: entry?.lifecycle ?? null,
                lastSeenAt: entry?.lastSeenAt ? new Date(entry.lastSeenAt).toISOString() : null,
                contextLength,
                inputTokenLimit,
                outputTokenLimit,
                /** Enough to write lib/models.ts from, without a judgement call. */
                declarable: contextLength !== null,
                /**
                 * The provider published a figure, but not the one this field
                 * means. Someone has to decide whether the window is the input
                 * limit plus the output limit, or look it up -- so it is not
                 * `declarable`, and saying so is the point.
                 */
                partialEvidence: contextLength === null && inputTokenLimit !== null,
                knownSilentSource: Object.hasOwn(KNOWN_SILENT_SOURCES, model.provider)
                    ? KNOWN_SILENT_SOURCES[model.provider]
                    : null,
            };
        })
        .sort((left, right) => left.modelId.localeCompare(right.modelId));

    return {
        rows,
        declarable: rows.filter((row) => row.declarable),
        partial: rows.filter((row) => row.partialEvidence),
        unobserved: rows.filter(
            (row) => !row.declarable && !row.partialEvidence
        ),
    };
}
