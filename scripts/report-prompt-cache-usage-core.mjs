// CACHE-01: the pure half of the prompt-cache usage report.
//
// Everything here takes rows already read and returns numbers; the database
// read lives in report-prompt-cache-usage.mjs. That split is what lets
// tests/promptCacheUsageReport.test.mjs check every figure against a
// hand-computed answer without a database.
//
// What a row is: one ChatAttemptUsage row -- one provider call a chat turn or an
// AI Review made -- with the reservation's `source` beside it. Grouped by
// provider x model x source, because the caching policy differs by path
// (docs/policy/anthropic-prompt-caching.md) and a model-level total would mix
// a path that sends a cache marker with one that does not.
//
// What it refuses to do:
//   - Blend an unknown into a zero. A row whose token counts are NULL (nobody
//     observed the call) and a row whose counts are estimates are counted as
//     their own states and excluded from every share.
//   - Claim a provider "does not cache". A group whose observed rows all show
//     zero cache tokens is reported as `no_cache_observed`: this schema cannot
//     tell a provider that reported zero from an adapter that never read the
//     field (the CACHE-01 instrumentation survey, gaps 3 and 4).
//   - Invent a path. `source` is whatever the reservation stored; turns the
//     column does not distinguish stay together.

/**
 * The most provider x model x source groups one report holds.
 *
 * Rows are read a page at a time, so row memory is one page; groups are kept
 * for the whole run. Their number is bounded in practice by the model catalogue
 * (about a hundred models, two sources), and this cap makes that bound a
 * refusal rather than an assumption: a report that would hold more stops.
 */
export const MAX_PROMPT_CACHE_GROUPS = 2_000;

export class PromptCacheGroupLimitError extends Error {
    constructor() {
        super(`more than ${MAX_PROMPT_CACHE_GROUPS} provider x model x source groups`);
        this.name = "PromptCacheGroupLimitError";
    }
}

/** Below this many observed attempts a share is printed but marked as a small sample. */
export const SMALL_SAMPLE_ATTEMPTS = 20;

const OBSERVED_USAGE_SOURCE = "provider_usage_metadata";

const finiteRate = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;

/**
 * The cache-write rate an attempt was priced at, as three states:
 * `priced` (a rate was recorded), `unpriced` (the snapshot says there was none),
 * `unknown` (the snapshot does not carry the field at all).
 */
export const cacheWriteRateState = (pricingSnapshot) => {
    if (!pricingSnapshot || typeof pricingSnapshot !== "object" || Array.isArray(pricingSnapshot)) {
        return "unknown";
    }
    if (!("cacheWriteUsdPerMillionTokens" in pricingSnapshot)) return "unknown";
    return finiteRate(pricingSnapshot.cacheWriteUsdPerMillionTokens) ? "priced" : "unpriced";
};

const emptyGroup = (provider, modelId, source) => ({
    provider,
    modelId,
    source,
    attempts: 0,
    observedAttempts: 0,
    estimatedAttempts: 0,
    unobservedAttempts: 0,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    attemptsWithCacheRead: 0,
    attemptsWithCacheWrite: 0,
    unpricedCacheWriteTokens: 0,
    attemptsWithUnpricedCacheWrite: 0,
    attemptsWithUnknownWriteRate: 0,
    unknownRateCacheWriteTokens: 0,
});

/**
 * An aggregator that takes rows one at a time: `add(row)` then `result()`.
 *
 * A row is `{ provider, modelId, source, usageSource, inputTokens,
 * cachedInputTokens, cacheWriteInputTokens, pricingSnapshot }`, with the three
 * token counts `null` when nobody observed the call.
 */
export const createPromptCacheAggregator = ({ maxGroups = MAX_PROMPT_CACHE_GROUPS } = {}) => {
    const groups = new Map();
    const add = (row) => {
        const source = row.source ?? "unknown";
        const key = JSON.stringify([row.provider, row.modelId, source]);
        if (!groups.has(key)) {
            if (groups.size >= maxGroups) throw new PromptCacheGroupLimitError();
            groups.set(key, emptyGroup(row.provider, row.modelId, source));
        }
        const group = groups.get(key);
        group.attempts += 1;

        const countsKnown =
            Number.isSafeInteger(row.inputTokens) &&
            Number.isSafeInteger(row.cachedInputTokens) &&
            Number.isSafeInteger(row.cacheWriteInputTokens);
        if (!countsKnown) {
            group.unobservedAttempts += 1;
            return;
        }
        if (row.usageSource !== OBSERVED_USAGE_SOURCE) {
            group.estimatedAttempts += 1;
            return;
        }

        group.observedAttempts += 1;
        group.inputTokens += row.inputTokens;
        group.cachedInputTokens += row.cachedInputTokens;
        group.cacheWriteInputTokens += row.cacheWriteInputTokens;
        if (row.cachedInputTokens > 0) group.attemptsWithCacheRead += 1;
        if (row.cacheWriteInputTokens > 0) {
            group.attemptsWithCacheWrite += 1;
            const rate = cacheWriteRateState(row.pricingSnapshot);
            if (rate === "unpriced") {
                group.unpricedCacheWriteTokens += row.cacheWriteInputTokens;
                group.attemptsWithUnpricedCacheWrite += 1;
            } else if (rate === "unknown") {
                group.attemptsWithUnknownWriteRate += 1;
                group.unknownRateCacheWriteTokens += row.cacheWriteInputTokens;
            }
        }
    };
    const result = () => [...groups.values()]
        .map((group) => ({
            ...group,
            // Shares of input tokens across observed attempts only.
            cacheReadShare:
                group.inputTokens > 0 ? round4(group.cachedInputTokens / group.inputTokens) : null,
            cacheWriteShare:
                group.inputTokens > 0 ? round4(group.cacheWriteInputTokens / group.inputTokens) : null,
            state: groupState(group),
            smallSample: group.observedAttempts < SMALL_SAMPLE_ATTEMPTS,
        }))
        .sort(
            (a, b) =>
                a.provider.localeCompare(b.provider) ||
                a.modelId.localeCompare(b.modelId) ||
                a.source.localeCompare(b.source)
        );
    return { add, result };
};

export const aggregatePromptCacheUsage = (rows) => {
    const aggregator = createPromptCacheAggregator();
    for (const row of rows) aggregator.add(row);
    return aggregator.result();
};

/**
 * Reads usage rows page by page between two fixed instants and hands each row
 * to `onRow` as it arrives, so rows are held one page at a time (the groups they
 * are added to are capped separately, see MAX_PROMPT_CACHE_GROUPS) and rows
 * inserted while the report runs cannot extend or reshuffle what it reads.
 *
 * `findMany` is Prisma's `chatAttemptUsage.findMany` in the script, and a fake
 * in the test.
 */
export const readAttemptUsagePages = async ({ findMany, since, until, pageSize, onRow }) => {
    let cursor = null;
    let pages = 0;
    for (;;) {
        const page = await findMany({
            where: { createdAt: { gte: since, lt: until } },
            orderBy: { id: "asc" },
            take: pageSize,
            ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
        });
        pages += 1;
        for (const row of page) onRow(row);
        if (page.length < pageSize) return { pages };
        cursor = page[page.length - 1].id;
    }
};

const round4 = (value) => Math.round(value * 10_000) / 10_000;

const groupState = (group) => {
    if (group.observedAttempts === 0) return "no_observed_usage";
    if (group.cachedInputTokens === 0 && group.cacheWriteInputTokens === 0) return "no_cache_observed";
    return "cache_observed";
};

/** Totals across groups, with the same exclusions. */
export const summarisePromptCacheUsage = (groups) => {
    const sum = (field) => groups.reduce((total, group) => total + group[field], 0);
    const inputTokens = sum("inputTokens");
    return {
        groups: groups.length,
        attempts: sum("attempts"),
        observedAttempts: sum("observedAttempts"),
        estimatedAttempts: sum("estimatedAttempts"),
        unobservedAttempts: sum("unobservedAttempts"),
        inputTokens,
        cachedInputTokens: sum("cachedInputTokens"),
        cacheWriteInputTokens: sum("cacheWriteInputTokens"),
        cacheReadShare: inputTokens > 0 ? round4(sum("cachedInputTokens") / inputTokens) : null,
        unpricedCacheWriteTokens: sum("unpricedCacheWriteTokens"),
        attemptsWithUnknownWriteRate: sum("attemptsWithUnknownWriteRate"),
        unknownRateCacheWriteTokens: sum("unknownRateCacheWriteTokens"),
        groupsWithNoCacheObserved: groups.filter((group) => group.state === "no_cache_observed").length,
    };
};

/** A synthetic set whose every figure is written out in the test. */
export const promptCacheFixtureRows = () => [
    // Anthropic chat: two observed calls with reads and a priced write.
    { provider: "anthropic", modelId: "claude-sonnet-5", source: "chat", usageSource: OBSERVED_USAGE_SOURCE, inputTokens: 10_000, cachedInputTokens: 6_000, cacheWriteInputTokens: 2_000, pricingSnapshot: { cacheWriteUsdPerMillionTokens: 3.75 } },
    { provider: "anthropic", modelId: "claude-sonnet-5", source: "chat", usageSource: OBSERVED_USAGE_SOURCE, inputTokens: 10_000, cachedInputTokens: 8_000, cacheWriteInputTokens: 0, pricingSnapshot: { cacheWriteUsdPerMillionTokens: 3.75 } },
    // A crash-reconciled row: counts unknown, never a zero.
    { provider: "anthropic", modelId: "claude-sonnet-5", source: "chat", usageSource: "crash_reconciliation", inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, pricingSnapshot: null },
    // The same model on the review path is its own group.
    { provider: "anthropic", modelId: "claude-sonnet-5", source: "comparison_review", usageSource: OBSERVED_USAGE_SOURCE, inputTokens: 4_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, pricingSnapshot: { cacheWriteUsdPerMillionTokens: 3.75 } },
    // MiniMax: a write with no verified rate.
    { provider: "minimax", modelId: "minimax-m3", source: "chat", usageSource: OBSERVED_USAGE_SOURCE, inputTokens: 5_000, cachedInputTokens: 1_000, cacheWriteInputTokens: 500, pricingSnapshot: { cacheWriteUsdPerMillionTokens: null } },
    // OpenAI: an estimate, then an observed call with a read and an old snapshot lacking the rate field.
    { provider: "openai", modelId: "gpt-5-6-luna", source: "chat", usageSource: "fallback_estimator", inputTokens: 3_000, cachedInputTokens: 0, cacheWriteInputTokens: 0, pricingSnapshot: {} },
    { provider: "openai", modelId: "gpt-5-6-luna", source: "chat", usageSource: OBSERVED_USAGE_SOURCE, inputTokens: 8_000, cachedInputTokens: 2_000, cacheWriteInputTokens: 100, pricingSnapshot: {} },
];
