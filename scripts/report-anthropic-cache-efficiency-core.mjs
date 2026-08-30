/**
 * Anthropic prompt-cache efficiency, from the organisation's own Usage API.
 *
 * Everything in this file is arithmetic over data the Admin API returned. It
 * makes no network call, touches no database, and -- deliberately -- invents no
 * operational figure. That last one is the reason it exists as a separate
 * module: `docs/policy/anthropic-prompt-caching.md` §8 says the measurement is
 * still pending, and a report whose numbers can be produced without an API key
 * is a report that can be quoted as if the measurement had happened.
 *
 * ## What the two cost columns are, and why they are two
 *
 * **List-price estimate.** Tokens the Usage API counted, times the published
 * per-model rate in `lib/modelPricing.ts`. Reproducible from this repository
 * and from Anthropic's price page, and wrong by exactly whatever discount the
 * contract carries.
 *
 * **Actual billed cost.** What the Cost API says the organisation was charged.
 * Includes negotiated discounts, credits and tax.
 *
 * They are reported side by side and never reconciled into one number. Claiming
 * they should match would make a contract discount look like a defect in this
 * report, and the direction of the difference is not something this repository
 * can know.
 *
 * ## Priced and unpriced rows
 *
 * A row is priced only when every modifier on it is one this application can
 * price: `service_tier` must be `standard`, and `speed` must be `standard` or
 * absent. Batch is 50% off, flex and priority are different rates again, fast
 * mode is premium, and US-only inference carries a 1.1x multiplier on every
 * token category. Those rates are real and they are not in this registry, so
 * such a row is reported as `unpriced` with its tokens intact and its cost
 * blank. Estimating it would put a number nobody verified into a savings
 * figure somebody will quote.
 */

/** Cache-write price multiples over base input, from Anthropic's price table. */
export const CACHE_WRITE_MULTIPLIER = { "5m": 1.25, "1h": 2 };
/** Cache reads cost this multiple of base input. */
export const CACHE_READ_MULTIPLIER = 0.1;

/** Why a usage row could not be priced against the registry. */
export const UNPRICED_REASONS = {
    SERVICE_TIER: "service_tier_not_standard",
    SPEED: "speed_not_standard",
    INFERENCE_GEO: "inference_geo_not_global",
    /**
     * The response did not report a geo even though the request grouped by it.
     *
     * Its own reason rather than folded into the one above, because the two
     * need different responses: `us` means "priced elsewhere, at a multiplier
     * this registry does not carry", and this means "the report cannot see the
     * dimension at all", which is a question about the request or the API
     * rather than about the traffic.
     */
    INFERENCE_GEO_UNKNOWN: "inference_geo_not_reported",
    UNKNOWN_MODEL: "model_not_in_pricing_registry",
};

const isFiniteNumber = (value) =>
    typeof value === "number" && Number.isFinite(value);

/**
 * A token count as the API reported it.
 *
 * Rejects rather than coerces. The API's own schema says these are numbers, so
 * a string here means the response is not the shape this parser was written
 * against -- and a `Number("")` of 0 would be indistinguishable from a real
 * zero in every total downstream.
 */
const tokenCount = (value, path) => {
    if (value === undefined || value === null) return 0;
    if (!isFiniteNumber(value) || value < 0 || !Number.isInteger(value)) {
        throw new AnthropicUsageParseError(
            "ANTHROPIC_USAGE_INVALID_TOKEN_COUNT",
            `Anthropic Usage API returned a non-integer token count at ${path}.`
        );
    }
    return value;
};

export class AnthropicUsageParseError extends Error {
    constructor(code, message) {
        super(message);
        this.name = "AnthropicUsageParseError";
        this.code = code;
    }
}

/**
 * The most recently *completed* UTC day range, `days` long.
 *
 * Completed, because a partial day is a partial denominator: a cache hit rate
 * computed over three hours of one time zone's morning is not the seven-day
 * figure anybody asked for, and nothing in the output would say so. The range
 * ends at today's UTC midnight (exclusive) and starts `days` before it.
 *
 * Anthropic's own note is that usage data typically appears within five
 * minutes, so a day that ended some hours ago is settled; excluding today is
 * about completeness of the *window*, not about ingestion lag.
 */
export const completedUtcDayRange = ({ days, now = new Date() }) => {
    const endingAt = new Date(
        Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
    );
    const startingAt = new Date(endingAt.getTime() - days * 86_400_000);
    return { startingAt, endingAt };
};

/** Resolve `--from`/`--to`/`--days` into one range, or explain the refusal. */
export const resolveReportRange = ({ from, to, days, now = new Date() }) => {
    const parseDay = (value, label) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
            return { error: `--${label} must be a UTC date as YYYY-MM-DD.` };
        }
        const parsed = Date.parse(`${value}T00:00:00.000Z`);
        if (!Number.isFinite(parsed)) {
            return { error: `--${label} is not a real date.` };
        }
        return { instant: new Date(parsed) };
    };

    if (from || to) {
        if (!from || !to) {
            return { error: "--from and --to must be given together." };
        }
        const start = parseDay(from, "from");
        if (start.error) return start;
        const end = parseDay(to, "to");
        if (end.error) return end;
        if (end.instant <= start.instant) {
            return { error: "--to must be after --from." };
        }
        const spanDays = Math.round(
            (end.instant - start.instant) / 86_400_000
        );
        // The API's own ceiling for `bucket_width=1d`. Refused here rather
        // than at the provider so the message names the limit instead of
        // arriving as a 400 with an opaque body.
        if (spanDays > 31) {
            return { error: "The daily report covers at most 31 days." };
        }
        return {
            startingAt: start.instant,
            endingAt: end.instant,
            days: spanDays,
            explicit: true,
        };
    }

    const requested = days ?? 7;
    if (!Number.isInteger(requested) || requested < 1 || requested > 31) {
        return { error: "--days must be a whole number between 1 and 31." };
    }
    return {
        ...completedUtcDayRange({ days: requested, now }),
        days: requested,
        explicit: false,
    };
};

/**
 * The beta header the `speed` dimension requires.
 *
 * Both the `speeds[]` filter and the `speed` group-by are gated on it, and a
 * request that asks for the dimension without the header does not fail loudly
 * -- so grouping by `speed` and sending the header are one decision, taken
 * together in `anthropicUsageReportUrl`.
 */
export const FAST_MODE_BETA_HEADER = "fast-mode-2026-02-01";

/** The dimensions asked for on every run, in a fixed order. */
export const BASE_GROUP_BY = [
    "model",
    "service_tier",
    "context_window",
    // Grouped from the start rather than on request. `inference_geo: "us"`
    // carries a 1.1x multiplier on every token category, and a report that did
    // not ask for the dimension gets `null` back for it -- which
    // `priceUsageRow` would read as "no modifier" and price at standard. The
    // cheapest way to be wrong about a US-only row is to not ask.
    "inference_geo",
];

/**
 * Build the request URL for one page of the messages usage report.
 *
 * `speed` is opt-in because its group-by needs a beta header, and asking for a
 * beta dimension on every run makes an ordinary report depend on a beta whose
 * availability is not this script's to assume. `scope` is opt-in because
 * filtering is a claim about attribution -- see `attributionScope`.
 */
export const anthropicUsageReportUrl = ({
    baseUrl,
    startingAt,
    endingAt,
    limit,
    page,
    groupBySpeed = false,
    workspaceIds = [],
    apiKeyIds = [],
}) => {
    const url = new URL(baseUrl);
    url.searchParams.set("starting_at", startingAt.toISOString());
    url.searchParams.set("ending_at", endingAt.toISOString());
    url.searchParams.set("bucket_width", "1d");
    // Every dimension that changes the price, plus the model. Grouping by a
    // dimension is the only way its value comes back at all -- the API returns
    // `null` for anything not in `group_by[]` -- so a report that priced rows
    // without asking for `service_tier` would be pricing rows it could not see
    // the tier of, and would quietly rate a batch row at standard.
    for (const dimension of BASE_GROUP_BY) {
        url.searchParams.append("group_by[]", dimension);
    }
    if (groupBySpeed) url.searchParams.append("group_by[]", "speed");
    // Narrowing filters, when the operator supplied them. Repeated rather than
    // comma-joined: the API documents these as array parameters.
    for (const id of workspaceIds) url.searchParams.append("workspace_ids[]", id);
    for (const id of apiKeyIds) url.searchParams.append("api_key_ids[]", id);
    url.searchParams.set("limit", String(limit));
    if (page) url.searchParams.set("page", page);
    return url;
};

/**
 * What this run's numbers are actually *about*.
 *
 * The Usage API answers for the whole organisation. If Tomverse shares its
 * Anthropic organisation with anything else -- another product, a staging key,
 * somebody's console playground -- an unfiltered run reports that traffic too,
 * and a cache hit rate computed over it is not Tomverse's hit rate.
 *
 * There is no way for this script to detect that from the outside: an
 * organisation with one workspace and an organisation with three look identical
 * in a response that was not grouped by workspace. So the scope is *declared*
 * rather than inferred, and the honest default is the wide one. A run with no
 * filter says so in its own output instead of letting the reader assume.
 */
export const attributionScope = ({ workspaceIds = [], apiKeyIds = [] }) => {
    const filtered = workspaceIds.length > 0 || apiKeyIds.length > 0;
    return {
        filtered,
        workspaceIds,
        apiKeyIds,
        label: filtered
            ? `filtered to ${workspaceIds.length} workspace(s) and ${apiKeyIds.length} API key(s)`
            : "the entire Anthropic organization",
        caveat: filtered
            ? "Scoped by the workspace and API key filters given on the command line. Anything Tomverse sends outside them is not counted."
            : "ORGANIZATION-WIDE: no workspace or API key filter was given, so every Anthropic request this organization made is counted -- including any product, staging key or console usage that is not Tomverse. Pass --workspace-id or --api-key-id to attribute these numbers to Tomverse.",
    };
};

/**
 * One page of `GET /v1/organizations/usage_report/messages`, validated.
 *
 * Fail-closed throughout: an unexpected shape raises rather than being skipped,
 * because a skipped bucket silently shrinks the denominator of every rate this
 * report computes. The one thing that is *not* an error is a bucket with an
 * empty `results` array -- the API documents that it returns those for
 * intervals with no usage.
 */
export const parseAnthropicUsagePage = (payload) => {
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
        throw new AnthropicUsageParseError(
            "ANTHROPIC_USAGE_INVALID_PAYLOAD",
            "Anthropic Usage API returned an invalid JSON object."
        );
    }
    if (!Array.isArray(payload.data)) {
        throw new AnthropicUsageParseError(
            "ANTHROPIC_USAGE_INVALID_PAYLOAD",
            "Anthropic Usage API response did not contain a data array."
        );
    }

    const rows = [];
    for (const [bucketIndex, bucket] of payload.data.entries()) {
        if (!bucket || typeof bucket !== "object") {
            throw new AnthropicUsageParseError(
                "ANTHROPIC_USAGE_INVALID_PAYLOAD",
                `Anthropic Usage API returned an invalid bucket at data[${bucketIndex}].`
            );
        }
        if (typeof bucket.starting_at !== "string") {
            throw new AnthropicUsageParseError(
                "ANTHROPIC_USAGE_INVALID_PAYLOAD",
                `Anthropic Usage API omitted starting_at at data[${bucketIndex}].`
            );
        }
        const startedAt = Date.parse(bucket.starting_at);
        if (!Number.isFinite(startedAt)) {
            throw new AnthropicUsageParseError(
                "ANTHROPIC_USAGE_INVALID_PAYLOAD",
                `Anthropic Usage API returned an unparseable starting_at at data[${bucketIndex}].`
            );
        }
        if (!Array.isArray(bucket.results)) {
            throw new AnthropicUsageParseError(
                "ANTHROPIC_USAGE_INVALID_PAYLOAD",
                `Anthropic Usage API omitted results at data[${bucketIndex}].`
            );
        }
        // The UTC calendar day this bucket belongs to. Taken from the bucket's
        // own `starting_at` rather than counted off the range's first day: a
        // page boundary or an empty interval would put every later row on the
        // wrong date, and the date is what selects the effective price.
        const day = new Date(startedAt).toISOString().slice(0, 10);

        for (const [resultIndex, result] of bucket.results.entries()) {
            const path = `data[${bucketIndex}].results[${resultIndex}]`;
            if (!result || typeof result !== "object") {
                throw new AnthropicUsageParseError(
                    "ANTHROPIC_USAGE_INVALID_PAYLOAD",
                    `Anthropic Usage API returned an invalid result at ${path}.`
                );
            }
            const cacheCreation = result.cache_creation;
            if (
                cacheCreation !== undefined &&
                cacheCreation !== null &&
                (typeof cacheCreation !== "object" || Array.isArray(cacheCreation))
            ) {
                throw new AnthropicUsageParseError(
                    "ANTHROPIC_USAGE_INVALID_PAYLOAD",
                    `Anthropic Usage API returned an invalid cache_creation at ${path}.`
                );
            }
            const serverToolUse = result.server_tool_use;
            if (
                serverToolUse !== undefined &&
                serverToolUse !== null &&
                (typeof serverToolUse !== "object" || Array.isArray(serverToolUse))
            ) {
                throw new AnthropicUsageParseError(
                    "ANTHROPIC_USAGE_INVALID_PAYLOAD",
                    `Anthropic Usage API returned an invalid server_tool_use at ${path}.`
                );
            }
            rows.push({
                day,
                startingAt: bucket.starting_at,
                model:
                    typeof result.model === "string" ? result.model : null,
                serviceTier:
                    typeof result.service_tier === "string"
                        ? result.service_tier
                        : null,
                contextWindow:
                    typeof result.context_window === "string"
                        ? result.context_window
                        : null,
                inferenceGeo:
                    typeof result.inference_geo === "string"
                        ? result.inference_geo
                        : null,
                speed: typeof result.speed === "string" ? result.speed : null,
                uncachedInputTokens: tokenCount(
                    result.uncached_input_tokens,
                    `${path}.uncached_input_tokens`
                ),
                cacheCreation5mTokens: tokenCount(
                    cacheCreation?.ephemeral_5m_input_tokens,
                    `${path}.cache_creation.ephemeral_5m_input_tokens`
                ),
                cacheCreation1hTokens: tokenCount(
                    cacheCreation?.ephemeral_1h_input_tokens,
                    `${path}.cache_creation.ephemeral_1h_input_tokens`
                ),
                cacheReadInputTokens: tokenCount(
                    result.cache_read_input_tokens,
                    `${path}.cache_read_input_tokens`
                ),
                outputTokens: tokenCount(
                    result.output_tokens,
                    `${path}.output_tokens`
                ),
                webSearchRequests: tokenCount(
                    serverToolUse?.web_search_requests,
                    `${path}.server_tool_use.web_search_requests`
                ),
            });
        }
    }

    const hasMore = payload.has_more === true;
    const nextPage =
        typeof payload.next_page === "string" && payload.next_page.trim()
            ? payload.next_page
            : null;
    // A page that says there is more and names no cursor is a response this
    // report cannot continue from, and continuing would silently truncate.
    if (hasMore && !nextPage) {
        throw new AnthropicUsageParseError(
            "ANTHROPIC_USAGE_MISSING_CURSOR",
            "Anthropic Usage API reported more pages and omitted the cursor."
        );
    }
    return { rows, hasMore, nextPage, bucketCount: payload.data.length };
};

/**
 * The API's request-count field.
 *
 * There is not one. The messages usage report returns token counts and
 * `server_tool_use.web_search_requests`, and no per-bucket request count --
 * so this report says so rather than deriving a request count from tokens,
 * which would be a fabricated operational figure of exactly the kind
 * `docs/policy/anthropic-prompt-caching.md` §8 forbids.
 */
export const REQUEST_COUNT_IS_NOT_REPORTED_BY_THE_USAGE_API = true;

/**
 * Price one usage row, or say why it cannot be priced.
 *
 * `resolvePrice(modelId, day)` returns the effective registry price for that
 * model on that UTC day, or null when the registry does not name the model.
 * Passed in rather than imported so this module stays pure arithmetic and the
 * per-day resolution is done by the caller that owns `lib/modelPricing.ts` --
 * and so a test can price a row at rates it chose.
 */
export const priceUsageRow = (row, resolvePrice) => {
    // Modifier checks first, and each on its own, so the reason names one
    // thing. A batch row and a fast-mode row are both unpriced and are not the
    // same finding.
    if (row.serviceTier !== null && row.serviceTier !== "standard") {
        return { priced: false, reason: UNPRICED_REASONS.SERVICE_TIER };
    }
    if (row.speed !== null && row.speed !== "standard") {
        return { priced: false, reason: UNPRICED_REASONS.SPEED };
    }
    // `inference_geo`, handled by value rather than by "is it global".
    //
    //   global         -- standard pricing. Priced.
    //   not_available  -- the model predates the parameter, so it *cannot* have
    //                     run US-only and always billed at standard rates.
    //                     Priced, and priced correctly: refusing it would drop
    //                     every pre-4.6 model out of the totals for carrying an
    //                     honest "this dimension does not apply to me".
    //   us             -- 1.1x on every token category, including cache reads
    //                     and writes. Not priced here: the multiplier is real
    //                     and applying it would put a rate into the savings
    //                     figure that no registry entry verifies.
    //   null           -- the dimension was not grouped. Since `BASE_GROUP_BY`
    //                     always asks for it, a null means the response did not
    //                     answer, which is not the same as "global" and must
    //                     not be read as it.
    if (row.inferenceGeo === "us") {
        return { priced: false, reason: UNPRICED_REASONS.INFERENCE_GEO };
    }
    if (row.inferenceGeo === null) {
        return { priced: false, reason: UNPRICED_REASONS.INFERENCE_GEO_UNKNOWN };
    }
    if (row.inferenceGeo !== "global" && row.inferenceGeo !== "not_available") {
        // A value the API added after this was written. Refused rather than
        // assumed: an unknown geo is an unknown multiplier.
        return { priced: false, reason: UNPRICED_REASONS.INFERENCE_GEO };
    }
    const price = row.model ? resolvePrice(row.model, row.day) : null;
    if (!price) {
        return { priced: false, reason: UNPRICED_REASONS.UNKNOWN_MODEL };
    }

    const inputRate = price.inputUsdPerMillionTokens;
    const readRate = inputRate * price.cachedInputPriceMultiplier;
    // The registry's own verified write rate where it has one, and the
    // published 1.25x otherwise. Falling back rather than refusing because the
    // multiplier is documented on Anthropic's price page for every model on it,
    // and the fallback is flagged so the output can say which rows used it.
    const write5mRate =
        typeof price.cacheWriteUsdPerMillionTokens === "number"
            ? price.cacheWriteUsdPerMillionTokens
            : inputRate * CACHE_WRITE_MULTIPLIER["5m"];
    const write1hRate = inputRate * CACHE_WRITE_MULTIPLIER["1h"];

    const perMillion = (tokens, rate) => (tokens * rate) / 1_000_000;

    const uncachedCostUsd = perMillion(row.uncachedInputTokens, inputRate);
    const cacheReadCostUsd = perMillion(row.cacheReadInputTokens, readRate);
    const cacheWrite5mCostUsd = perMillion(row.cacheCreation5mTokens, write5mRate);
    const cacheWrite1hCostUsd = perMillion(row.cacheCreation1hTokens, write1hRate);
    const outputCostUsd = perMillion(
        row.outputTokens,
        price.outputUsdPerMillionTokens
    );

    // What the same input tokens would have cost with no cache at all: every
    // token that was read or written would instead have been processed
    // uncached, at 1.0x. This is the *counterfactual*, and it is the only
    // honest baseline for a savings figure -- comparing against "input tokens
    // as reported" would compare the cached bill against itself.
    const inputTokensTotal =
        row.uncachedInputTokens +
        row.cacheReadInputTokens +
        row.cacheCreation5mTokens +
        row.cacheCreation1hTokens;
    const uncachedCounterfactualInputCostUsd = perMillion(
        inputTokensTotal,
        inputRate
    );

    return {
        priced: true,
        pricingVersion: price.pricingVersion,
        inputUsdPerMillionTokens: inputRate,
        cacheWriteUsdPerMillionTokens: write5mRate,
        cacheWriteRateWasDerived:
            typeof price.cacheWriteUsdPerMillionTokens !== "number",
        uncachedCostUsd,
        cacheReadCostUsd,
        cacheWrite5mCostUsd,
        cacheWrite1hCostUsd,
        outputCostUsd,
        actualInputCostUsd:
            uncachedCostUsd +
            cacheReadCostUsd +
            cacheWrite5mCostUsd +
            cacheWrite1hCostUsd,
        uncachedCounterfactualInputCostUsd,
        inputTokensTotal,
    };
};

const emptyTotals = () => ({
    uncachedInputTokens: 0,
    cacheCreation5mTokens: 0,
    cacheCreation1hTokens: 0,
    cacheReadInputTokens: 0,
    outputTokens: 0,
    webSearchRequests: 0,
    inputTokensTotal: 0,
    actualInputCostUsd: 0,
    uncachedCounterfactualInputCostUsd: 0,
    outputCostUsd: 0,
    pricedRowCount: 0,
    unpricedRowCount: 0,
});

const addRow = (totals, row, priced) => {
    totals.uncachedInputTokens += row.uncachedInputTokens;
    totals.cacheCreation5mTokens += row.cacheCreation5mTokens;
    totals.cacheCreation1hTokens += row.cacheCreation1hTokens;
    totals.cacheReadInputTokens += row.cacheReadInputTokens;
    totals.outputTokens += row.outputTokens;
    totals.webSearchRequests += row.webSearchRequests;
    if (priced.priced) {
        totals.pricedRowCount += 1;
        totals.inputTokensTotal += priced.inputTokensTotal;
        totals.actualInputCostUsd += priced.actualInputCostUsd;
        totals.uncachedCounterfactualInputCostUsd +=
            priced.uncachedCounterfactualInputCostUsd;
        totals.outputCostUsd += priced.outputCostUsd;
    } else {
        totals.unpricedRowCount += 1;
    }
};

/**
 * The efficiency metrics, defined here so the definitions travel with the
 * arithmetic.
 *
 * - **cache read share** = `cacheRead / (uncached + cacheRead + writes)`. The
 *   fraction of all input tokens that came out of the cache. Denominator is
 *   every input token, not just the cacheable ones, because the question is
 *   what fraction of the input bill the cache is carrying.
 * - **cache read/write ratio** = `cacheRead / (write5m + write1h)`. How many
 *   tokens each written token is read back as. Below 1 the cache is costing
 *   more than it saves on those tokens (a write is 1.25x, a read is 0.1x, so
 *   break-even for the 5-minute TTL is at about 0.25 reads per written token,
 *   but a ratio under 1 means most entries expire unread and is worth looking
 *   at whatever the arithmetic says).
 * - **list-price saving** = counterfactual uncached input cost minus actual
 *   input cost, both at list price. Input only: output tokens are unaffected
 *   by caching and including them would dilute the rate with a constant.
 */
export const cacheEfficiencyMetrics = (totals) => {
    const writes = totals.cacheCreation5mTokens + totals.cacheCreation1hTokens;
    const inputTokens =
        totals.uncachedInputTokens + totals.cacheReadInputTokens + writes;
    const savingUsd =
        totals.uncachedCounterfactualInputCostUsd - totals.actualInputCostUsd;
    return {
        inputTokens,
        cacheWriteTokens: writes,
        // Null rather than 0 for an empty denominator: "no traffic" and "no
        // cache hits on real traffic" are opposite findings and a 0% that
        // means the first is the one somebody escalates.
        cacheReadShare:
            inputTokens > 0 ? totals.cacheReadInputTokens / inputTokens : null,
        cacheReadToWriteRatio:
            writes > 0 ? totals.cacheReadInputTokens / writes : null,
        actualInputCostUsd: totals.actualInputCostUsd,
        uncachedCounterfactualInputCostUsd:
            totals.uncachedCounterfactualInputCostUsd,
        listPriceSavingUsd: savingUsd,
        listPriceSavingShare:
            totals.uncachedCounterfactualInputCostUsd > 0
                ? savingUsd / totals.uncachedCounterfactualInputCostUsd
                : null,
    };
};

/**
 * Roll parsed rows up per model, per modifier bucket, and overall.
 *
 * Rows carrying a price modifier are split out into their own group rather than
 * dropped: their tokens are real and belong in a traffic picture, and their
 * cost is unknown and must not enter a savings figure. Both facts survive.
 */
export const summariseUsageRows = (rows, resolvePrice) => {
    const overall = emptyTotals();
    const byModel = new Map();
    const unpriced = new Map();

    for (const row of rows) {
        const priced = priceUsageRow(row, resolvePrice);
        const key = row.model ?? "(ungrouped)";
        if (!byModel.has(key)) byModel.set(key, emptyTotals());
        addRow(byModel.get(key), row, priced);
        addRow(overall, row, priced);
        if (!priced.priced) {
            const bucket = `${key} | ${priced.reason}`;
            if (!unpriced.has(bucket)) {
                unpriced.set(bucket, {
                    model: key,
                    reason: priced.reason,
                    serviceTier: row.serviceTier,
                    speed: row.speed,
                    inferenceGeo: row.inferenceGeo,
                    ...emptyTotals(),
                });
            }
            addRow(unpriced.get(bucket), row, priced);
        }
    }

    return {
        overall: { totals: overall, metrics: cacheEfficiencyMetrics(overall) },
        byModel: [...byModel.entries()]
            .map(([model, totals]) => ({
                model,
                totals,
                metrics: cacheEfficiencyMetrics(totals),
            }))
            .sort((a, b) => b.metrics.inputTokens - a.metrics.inputTokens),
        unpriced: [...unpriced.values()],
    };
};

export const formatUsd = (value) =>
    value === null || value === undefined ? "n/a" : `$${value.toFixed(4)}`;

export const formatShare = (value) =>
    value === null || value === undefined
        ? "n/a"
        : `${(value * 100).toFixed(1)}%`;

export const formatTokens = (value) => value.toLocaleString("en-US");
