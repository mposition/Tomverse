/**
 * How a model's context window at runtime compares with the one the catalogue
 * declares, and which of those differences is a defect.
 *
 * Split from the script for the reason `check-release-gate-coverage-core.mjs`
 * is split from its own: the check needs the deployed database, so it is
 * manually gated and CI never runs it. A rule nothing exercises is a rule that
 * decays -- and this one decides whether a model is guarded, so it decaying
 * quietly is the whole failure it exists to prevent. The comparison is pure
 * and lives here; the script does the I/O and the printing.
 *
 * The comparison matters because `getRuntimeModels` does not merge a registry
 * row with the catalogue entry of the same id. When rows exist it builds each
 * model from its row alone, so a row is the whole truth about that model and
 * `contextWindowTokens = NULL` on it means no window at runtime -- whatever
 * lib/models.ts says.
 */

/**
 * @param {{
 *   runtime: readonly {id: string, provider: string, minimumPlan: string, contextWindowTokens?: number | null}[],
 *   catalogue: readonly {id: string, contextWindowTokens?: number | null}[],
 * }} input
 * @returns {{
 *   entries: object[],
 *   cleared: object[],
 *   unknownUndeclared: object[],
 *   closed: object[],
 *   differing: object[],
 *   undeclared: object[],
 * }}
 */
export function classifyContextWindows({ runtime, catalogue }) {
    const catalogueById = new Map(catalogue.map((model) => [model.id, model]));

    const entries = runtime
        .map((model) => {
            // `|| null` rather than `?? null` on purpose: this mirrors
            // `registryRowToModel`, which maps a stored 0 to undefined. A zero
            // window is not a window, and reading it as one would report a
            // model as guarded whose fit would divide an empty budget.
            const runtimeWindowTokens = model.contextWindowTokens || null;
            const inCatalogue = catalogueById.has(model.id);
            const catalogueWindowTokens =
                catalogueById.get(model.id)?.contextWindowTokens || null;
            return {
                modelId: model.id,
                provider: model.provider,
                minimumPlan: model.minimumPlan,
                runtimeWindowTokens,
                catalogueWindowTokens,
                inCatalogue,
                /** Green in CI, unguarded in production. The finding. */
                clearedByRow:
                    runtimeWindowTokens === null && catalogueWindowTokens !== null,
                /** No baseline covers it, because no baseline knows it exists. */
                unknownToCatalogue: !inCatalogue,
                undeclaredEverywhere:
                    runtimeWindowTokens === null && catalogueWindowTokens === null,
                /** Good news, and not grounds for shrinking the catalogue baseline. */
                closedByRow:
                    runtimeWindowTokens !== null && catalogueWindowTokens === null,
                differs:
                    runtimeWindowTokens !== null &&
                    catalogueWindowTokens !== null &&
                    runtimeWindowTokens !== catalogueWindowTokens,
            };
        })
        .sort((left, right) => left.modelId.localeCompare(right.modelId));

    return {
        entries,
        cleared: entries.filter((entry) => entry.clearedByRow),
        unknownUndeclared: entries.filter(
            (entry) => entry.unknownToCatalogue && entry.runtimeWindowTokens === null
        ),
        closed: entries.filter((entry) => entry.closedByRow),
        differing: entries.filter((entry) => entry.differs),
        undeclared: entries.filter((entry) => entry.runtimeWindowTokens === null),
    };
}
