// How much is Anthropic prompt caching actually saving?
//
//   npm run report:anthropic-cache-efficiency -- --days=7
//   npm run report:anthropic-cache-efficiency -- --from=2026-08-20 --to=2026-08-27
//   npm run report:anthropic-cache-efficiency -- --days=7 --json
//
// Read-only, in the strong sense: it calls two Anthropic Admin API endpoints
// and writes nothing anywhere. No database, no ProviderDailyUsage row, no
// Console state. `report:model-credit-weights` and `report:credit-lot-invariants`
// are the same shape and for the same reason -- a report that edits its own
// subject destroys the audit trail the subject exists to be.
//
// Requires ANTHROPIC_ADMIN_API_KEY (an Admin API key, `sk-ant-admin...`, or
// another admin credential; workspace keys are rejected by the API). The key is
// never printed, never put in an error, and never written to the JSON output.
//
// Exit codes: 0 when the report was produced, 1 when it could not be. There is
// no "findings" exit code -- a low hit rate is a thing to read, not a build
// failure. See docs/policy/anthropic-prompt-caching.md §8.

import { resolveModelPricing } from "../lib/modelPricing.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
    AnthropicUsageParseError,
    anthropicUsageReportUrl,
    anthropicCostReportUrl,
    anthropicWorkspaceUrl,
    attributionScope,
    BASE_GROUP_BY,
    CACHE_5M_BREAK_EVEN_READ_RATIO,
    classifyWorkspaceIds,
    cacheEfficiencyMetrics,
    FAST_MODE_BETA_HEADER,
    formatShare,
    formatTokens,
    formatUsd,
    parseAnthropicUsagePage,
    resolveReportRange,
    sumCostReport,
    summariseUsageRows,
    UNPRICED_REASONS,
} from "./report-anthropic-cache-efficiency-core.mjs";

const USAGE_URL =
    "https://api.anthropic.com/v1/organizations/usage_report/messages";
const COST_URL = "https://api.anthropic.com/v1/organizations/cost_report";
const WORKSPACES_URL = "https://api.anthropic.com/v1/organizations/workspaces";
const REQUEST_TIMEOUT_MS = 30_000;
// The report is bounded at 31 daily buckets and the API returns at most
// `limit` per page, so 8 pages is far more than a well-formed response needs.
// A cursor loop with no ceiling is a cursor loop that can be made to run for
// ever by a server that keeps saying `has_more`.
const MAX_PAGES = 8;
// Big enough for a month of daily buckets grouped three ways across a handful
// of models, and small enough that a runaway response is refused rather than
// buffered. The Cost API's own docs put daily line items well inside this.
const MAX_RESPONSE_BYTES = 4_000_000;

const argValue = (name) => {
    const prefix = `--${name}=`;
    const hit = process.argv.find((arg) => arg.startsWith(prefix));
    return hit ? hit.slice(prefix.length) : undefined;
};

/** Repeatable: `--workspace-id=a --workspace-id=b`. */
const argValues = (name) => {
    const prefix = `--${name}=`;
    return process.argv
        .filter((arg) => arg.startsWith(prefix))
        .map((arg) => arg.slice(prefix.length).trim())
        .filter(Boolean);
};

const json = process.argv.includes("--json");
// Opt-in, because the `speed` group-by requires a beta header and an ordinary
// run should not depend on a beta's availability.
const groupBySpeed = process.argv.includes("--speed");

const fail = (message) => {
    if (json) {
        process.stdout.write(
            `${JSON.stringify({ ok: false, error: message }, null, 2)}\n`
        );
    } else {
        process.stderr.write(`${message}\n`);
    }
    process.exit(1);
};

/**
 * Read a JSON body with a hard byte ceiling.
 *
 * `response.json()` buffers whatever arrives. A `Content-Length` header is a
 * claim, not a promise, so the stream is counted as it is consumed and the
 * read is aborted the moment it goes over -- which is the only check that
 * holds against a server that under-reports its own length.
 */
const readBoundedJson = async (response) => {
    if (!response.body) return null;
    const reader = response.body.getReader();
    const chunks = [];
    let bytes = 0;
    try {
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            bytes += value.byteLength;
            if (bytes > MAX_RESPONSE_BYTES) {
                await reader.cancel("response exceeded the size ceiling");
                throw new AnthropicUsageParseError(
                    "ANTHROPIC_USAGE_RESPONSE_TOO_LARGE",
                    `Anthropic Admin API response exceeded ${MAX_RESPONSE_BYTES} bytes.`
                );
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock?.();
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text.trim()) return null;
    try {
        return JSON.parse(text);
    } catch {
        throw new AnthropicUsageParseError(
            "ANTHROPIC_USAGE_INVALID_JSON",
            "Anthropic Admin API returned a body that is not JSON."
        );
    }
};

const adminFetch = async (url, adminKey, { betas = [] } = {}) => {
    const response = await fetch(url, {
        cache: "no-store",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
            Accept: "application/json",
            "anthropic-version": "2023-06-01",
            // The beta header travels with the request that needs the beta
            // dimension, never as a standing default: a group-by that asks for
            // `speed` without it is not loudly refused, so the two have to be
            // one decision rather than two settings that can drift apart.
            ...(betas.length > 0
                ? { "anthropic-beta": betas.join(",") }
                : {}),
            "x-api-key": adminKey,
            // Anthropic asks integrations to identify themselves so usage
            // patterns are attributable. No account identifier in it.
            "User-Agent": "Tomverse-cache-efficiency-report/1.0",
        },
    });
    const payload = await readBoundedJson(response);
    if (!response.ok) {
        const detail =
            payload && typeof payload === "object"
                ? typeof payload.error?.message === "string"
                    ? payload.error.message
                    : typeof payload.message === "string"
                      ? payload.message
                      : null
                : null;
        // The key is never echoed here. A 401 says the credential is wrong,
        // and printing the credential to prove it is how a key reaches a
        // terminal log.
        const hint =
            response.status === 401 || response.status === 403
                ? " Verify that ANTHROPIC_ADMIN_API_KEY is an Admin API key for a Claude Console organization; workspace-scoped keys are rejected."
                : "";
        throw new Error(
            `Anthropic Admin API returned ${response.status}.${hint}${
                detail ? ` ${detail}` : ""
            }`
        );
    }
    return payload;
};

/**
 * Every model's price on a given UTC day, by the *API* model id.
 *
 * Keyed on `apiModelId` because that is what the usage report returns:
 * `claude-opus-5`, not this catalogue's stable `claude-opus-4-8`. Matching on
 * the Tomverse id would silently price every Opus row as unknown.
 *
 * The day is resolved through `resolveModelPricing({ at })`, so a range that
 * crosses a scheduled price change prices each date at the rate that was in
 * force on it rather than at today's. That is the whole reason the effective
 * date mechanism exists (docs/policy/credit-and-cost-limits.md §3).
 */
const buildPriceResolver = () => {
    const byApiModelId = new Map();
    for (const model of AVAILABLE_MODELS) {
        if (model.provider !== "anthropic") continue;
        byApiModelId.set(model.apiModel, model);
    }
    return (apiModelId, day) => {
        const model = byApiModelId.get(apiModelId);
        if (!model) return null;
        // Midday rather than midnight, deliberately: a price boundary is an
        // instant, and pricing a whole UTC day at 00:00:00.000Z would put a day
        // that *starts* on a change onto the new rate for its whole length --
        // which is correct -- while a boundary at any other hour has no
        // representation in a daily bucket at all. Midday makes the choice
        // explicit and puts a same-day change on the new price, matching how
        // the daily bucket is already an aggregate nobody can split.
        const at = Date.parse(`${day}T12:00:00.000Z`);
        return resolveModelPricing(model, {
            at: Number.isFinite(at) ? at : undefined,
        });
    };
};

const main = async () => {
    const adminKey = process.env.ANTHROPIC_ADMIN_API_KEY?.trim();
    if (!adminKey) {
        fail(
            "ANTHROPIC_ADMIN_API_KEY is not set. This report reads the organization's own Usage and Cost APIs and cannot be produced without one; it does not estimate."
        );
    }

    const scope = attributionScope({
        workspaceIds: argValues("workspace-id"),
        apiKeyIds: argValues("api-key-id"),
    });

    const daysArg = argValue("days");
    const range = resolveReportRange({
        from: argValue("from"),
        to: argValue("to"),
        days: daysArg === undefined ? undefined : Number(daysArg),
    });
    if (range.error) fail(range.error);

    const rows = [];
    let page = null;
    let pageCount = 0;
    let bucketCount = 0;
    try {
        do {
            pageCount += 1;
            if (pageCount > MAX_PAGES) {
                throw new Error(
                    "Anthropic Usage API pagination exceeded the safety limit."
                );
            }
            const payload = await adminFetch(
                anthropicUsageReportUrl({
                    baseUrl: USAGE_URL,
                    startingAt: range.startingAt,
                    endingAt: range.endingAt,
                    limit: range.days,
                    page,
                    groupBySpeed,
                    workspaceIds: scope.workspaceIds,
                    apiKeyIds: scope.apiKeyIds,
                }),
                adminKey,
                { betas: groupBySpeed ? [FAST_MODE_BETA_HEADER] : [] }
            );
            const parsed = parseAnthropicUsagePage(payload);
            rows.push(...parsed.rows);
            bucketCount += parsed.bucketCount;
            page = parsed.hasMore ? parsed.nextPage : null;
        } while (page);
    } catch (error) {
        fail(
            error instanceof Error
                ? `Usage report could not be read: ${error.message}`
                : "Usage report could not be read."
        );
    }

    const summary = summariseUsageRows(rows, buildPriceResolver());

    // Which of the named workspaces is the Default Workspace.
    //
    // It has a real `wrkspc_` id -- that is what the Usage API filter takes --
    // but usage and cost reports echo `null` for it. So a filtered run has to
    // reconcile two names for one workspace, and the only documented way to ask
    // is `GET /v1/organizations/workspaces/{id}`, which answers `"name":
    // "Default"` for it. List Workspaces omits it entirely, so there is no
    // cheaper lookup.
    let workspaceIdentity = {
        named: scope.cost.workspaceIds,
        defaultWorkspaceIds: [],
        matchesDefaultWorkspace: false,
        unresolved: [],
    };
    if (scope.cost.workspaceIds.length > 0) {
        workspaceIdentity = await classifyWorkspaceIds(
            scope.cost.workspaceIds,
            async (id) =>
                adminFetch(
                    anthropicWorkspaceUrl({
                        baseUrl: WORKSPACES_URL,
                        workspaceId: id,
                    }),
                    adminKey
                )
        );
    }

    // The billed total, read separately and never reconciled with the estimate
    // above. A failure here is not a failure of the report: the cache metrics
    // come entirely from the usage side, so the billed column is reported as
    // unavailable and everything else stands.
    //
    // `scope.cost` decides what this can honestly be compared against. The two
    // APIs narrow differently -- the usage report takes workspace *and* API-key
    // filters, the cost report takes neither and offers only workspace
    // grouping -- so a filtered usage figure beside an unfiltered bill is two
    // populations on one screen.
    let billed = {
        available: false,
        reason: null,
        costUsd: null,
        comparable: scope.cost.comparable,
        mode: scope.cost.mode,
        note: scope.cost.note,
        defaultWorkspaceIds: workspaceIdentity.defaultWorkspaceIds,
        unresolvedWorkspaceIds: workspaceIdentity.unresolved,
    };
    try {
        let costUsd = 0;
        let matchedResults = 0;
        let skippedResults = 0;
        let costPage = null;
        let costPageCount = 0;
        // Paginated to the end, like the usage side. A first-page-only total
        // presented as "the bill" is a number that is wrong by however much the
        // later pages held, and nothing on screen would say by how much.
        for (;;) {
            costPageCount += 1;
            if (costPageCount > MAX_PAGES) {
                throw new Error(
                    `Cost API pagination exceeded ${MAX_PAGES} pages; the billed total would be partial, so it is withheld rather than shown incomplete.`
                );
            }
            const payload = await adminFetch(
                anthropicCostReportUrl({
                    baseUrl: COST_URL,
                    startingAt: range.startingAt,
                    endingAt: range.endingAt,
                    limit: range.days,
                    groupByWorkspace: scope.cost.groupByWorkspace,
                    page: costPage,
                }),
                adminKey
            );
            const summed = sumCostReport(payload, {
                workspaceIds: workspaceIdentity.named,
                matchesDefaultWorkspace:
                    workspaceIdentity.matchesDefaultWorkspace,
            });
            costUsd += summed.costUsd;
            matchedResults += summed.matchedResults;
            skippedResults += summed.skippedResults;
            if (!summed.hasMore) break;
            costPage = summed.nextPage;
        }
        billed = {
            ...billed,
            available: true,
            costUsd,
            matchedResults,
            skippedResults,
            pageCount: costPageCount,
            reason: null,
        };
        // A workspace filter that matched nothing is a filter that is probably
        // wrong -- a mistyped id sums to zero and looks like a quiet month.
        if (scope.cost.workspaceIds.length > 0 && matchedResults === 0) {
            billed.reason =
                "No cost rows matched the named workspace(s). Check the ids: a filter that matches nothing sums to zero and reads like an unused period.";
        }
        if (workspaceIdentity.unresolved.length > 0) {
            billed.reason = [
                billed.reason,
                `Could not resolve ${workspaceIdentity.unresolved.length} workspace id(s) against GET Workspace, so they were matched by id alone; if one of them is the Default Workspace its cost is NOT included (the report calls it null).`,
            ]
                .filter(Boolean)
                .join(" ");
        }
    } catch (error) {
        billed = {
            ...billed,
            available: false,
            reason:
                error instanceof Error
                    ? error.message
                    : "Cost API could not be read.",
            costUsd: null,
        };
    }

    const report = {
        ok: true,
        generatedAt: new Date().toISOString(),
        range: {
            startingAt: range.startingAt.toISOString(),
            endingAt: range.endingAt.toISOString(),
            days: range.days,
            basis: range.explicit
                ? "explicit --from/--to (UTC, end exclusive)"
                : "most recent completed UTC days, today excluded",
        },
        source: {
            usageEndpoint: "GET /v1/organizations/usage_report/messages",
            costEndpoint: "GET /v1/organizations/cost_report",
            groupedBy: [...BASE_GROUP_BY, ...(groupBySpeed ? ["speed"] : [])],
            betas: groupBySpeed ? [FAST_MODE_BETA_HEADER] : [],
            speedMeasured: groupBySpeed,
            pageCount,
            bucketCount,
            rowCount: rows.length,
        },
        // What these numbers are about. First-class in the output rather than
        // a footnote: an organization-wide figure read as Tomverse's is the
        // most likely way this report gets quoted wrongly.
        attribution: {
            scope: scope.label,
            filtered: scope.filtered,
            workspaceIds: scope.workspaceIds,
            apiKeyIds: scope.apiKeyIds,
            caveat: scope.caveat,
            // Which of the named ids the cost report calls `null`, so a
            // consumer can reproduce the matching without repeating the
            // lookup.
            defaultWorkspaceIds: workspaceIdentity.defaultWorkspaceIds,
            unresolvedWorkspaceIds: workspaceIdentity.unresolved,
        },
        definitions: {
            cacheReadShare:
                "cache_read_input_tokens / (uncached_input_tokens + cache_read_input_tokens + cache_creation tokens)",
            cacheReadToWriteRatio:
                "cache_read_input_tokens / (ephemeral_5m_input_tokens + ephemeral_1h_input_tokens). Break-even for the 5-minute TTL is 0.25/0.9 = 0.2778 reads per written token, from 1.25 + 0.1R = 1 + R -- not 0.25, which would be right only if reads were free. This ratio weights every token equally regardless of which model wrote it, so it diagnoses rather than decides; listPriceSavingUsd is the figure that answers whether caching paid.",
            actualInputCostUsd:
                "uncached x 1.00 + cache_read x 0.10 + 5m writes x 1.25 + 1h writes x 2.00, each times the model's base input rate for that UTC day",
            uncachedCounterfactualInputCostUsd:
                "every input token (uncached + read + written) x 1.00 x the base input rate: what the same traffic would have cost with no cache at all",
            listPriceSavingUsd:
                "uncachedCounterfactualInputCostUsd - actualInputCostUsd (input tokens only; output is unaffected by caching)",
            requestCount:
                "not reported: the messages usage report returns token counts and web-search requests, and no per-bucket request count. Deriving one from tokens would be a fabricated figure.",
            ttlDecision:
                "NOT decidable from this report. The 1-hour TTL question turns on the start-to-start gap between consecutive requests that share a prefix, and this report aggregates per day and per model -- traffic spread evenly across a day and the same traffic in two bursts twelve hours apart produce identical rows. A low read/write ratio here is one candidate explanation among several (prefix varying per request, prompts under the model minimum, workspace-split traffic) and does not single out expiry. See docs/policy/anthropic-prompt-caching.md section 3.1 for the two designs that can answer it: a keyed prefix-digest histogram of re-call intervals, or a 5m/1h canary split on separate API keys.",
        },
        overall: summary.overall,
        byModel: summary.byModel,
        unpriced: summary.unpriced,
        // `comparable`/`mode`/`note` travel with the figure rather than beside
        // it, so a consumer that reads `billed.costUsd` cannot miss that it may
        // describe a different population from the usage totals.
        billed,
    };

    if (json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
        return;
    }

    const lines = [];
    lines.push("Anthropic prompt-cache efficiency");
    lines.push(
        `  ${report.range.startingAt.slice(0, 10)} .. ${report.range.endingAt.slice(0, 10)} (${range.days} UTC day(s), end exclusive)`
    );
    lines.push(`  basis: ${report.range.basis}`);
    lines.push(
        `  ${rows.length} usage row(s) across ${bucketCount} bucket(s), ${pageCount} page(s)`
    );
    lines.push(`  grouped by: ${report.source.groupedBy.join(", ")}`);
    lines.push(
        `  speed:      ${
            groupBySpeed
                ? `measured (beta ${FAST_MODE_BETA_HEADER})`
                : "not measured -- pass --speed to group by it (sends the fast-mode beta header)"
        }`
    );
    lines.push("");
    // Before the numbers, not after. A reader who stops at the first table
    // must have seen what the table is about.
    lines.push(`SCOPE: ${scope.label}`);
    lines.push(`  ${scope.caveat}`);
    lines.push("");

    const renderMetrics = (label, totals, metrics) => {
        lines.push(label);
        lines.push(
            `    input tokens        uncached ${formatTokens(totals.uncachedInputTokens)} | read ${formatTokens(totals.cacheReadInputTokens)} | write 5m ${formatTokens(totals.cacheCreation5mTokens)} | write 1h ${formatTokens(totals.cacheCreation1hTokens)}`
        );
        lines.push(
            `    output tokens       ${formatTokens(totals.outputTokens)}`
        );
        lines.push(
            `    web searches        ${formatTokens(totals.webSearchRequests)}`
        );
        lines.push(
            `    cache read share    ${formatShare(metrics.cacheReadShare)}`
        );
        lines.push(
            `    read/write ratio    ${
                metrics.cacheReadToWriteRatio === null
                    ? "n/a"
                    : `${metrics.cacheReadToWriteRatio.toFixed(3)} (5m break-even ${CACHE_5M_BREAK_EVEN_READ_RATIO.toFixed(3)}${
                          metrics.cacheReadToWriteRatio >=
                          CACHE_5M_BREAK_EVEN_READ_RATIO
                              ? ""
                              : " -- BELOW"
                      })`
            }`
        );
        lines.push(
            `    input cost (list)   ${formatUsd(metrics.actualInputCostUsd)} actual vs ${formatUsd(metrics.uncachedCounterfactualInputCostUsd)} with no cache`
        );
        lines.push(
            `    list-price saving   ${formatUsd(metrics.listPriceSavingUsd)} (${formatShare(metrics.listPriceSavingShare)})`
        );
        if (totals.unpricedRowCount > 0) {
            lines.push(
                `    unpriced rows       ${totals.unpricedRowCount} (tokens counted above, cost excluded)`
            );
        }
    };

    renderMetrics("TOTAL", report.overall.totals, report.overall.metrics);
    lines.push("");
    for (const entry of report.byModel) {
        renderMetrics(entry.model, entry.totals, entry.metrics);
        lines.push("");
    }

    if (summary.unpriced.length > 0) {
        lines.push("Unpriced rows -- tokens are real, cost is not comparable:");
        for (const entry of summary.unpriced) {
            const detail =
                entry.reason === UNPRICED_REASONS.SERVICE_TIER
                    ? `service_tier=${entry.serviceTier}`
                    : entry.reason === UNPRICED_REASONS.SPEED
                      ? `speed=${entry.speed}`
                      : entry.reason === UNPRICED_REASONS.INFERENCE_GEO
                        ? `inference_geo=${entry.inferenceGeo} (1.1x on every token category; no verified rate here)`
                        : entry.reason === UNPRICED_REASONS.INFERENCE_GEO_UNKNOWN
                          ? "inference_geo was grouped but not reported, so the multiplier is unknown"
                          : "no pricing profile for this model id";
            lines.push(
                `  ${entry.model}: ${entry.reason} (${detail}) -- ${formatTokens(
                    cacheEfficiencyMetrics(entry).inputTokens
                )} input token(s), unpriced`
            );
        }
        lines.push("");
    }

    lines.push("Billed vs estimated -- deliberately two numbers:");
    lines.push(
        `  list-price estimate (input + output, priced rows only): ${formatUsd(
            report.overall.metrics.actualInputCostUsd +
                report.overall.totals.outputCostUsd
        )}`
    );
    lines.push(
        billed.available
            ? `  Cost API actual billed total:                            ${formatUsd(billed.costUsd)}`
            : `  Cost API actual billed total:                            unavailable (${billed.reason})`
    );
    if (billed.available && billed.reason) lines.push(`  note: ${billed.reason}`);
    // Which population the bill describes, always -- not only when it differs.
    // A reader who has to infer that from the flags above will not.
    lines.push(`  ${billed.comparable ? "scope" : "SCOPE MISMATCH"}: ${billed.note}`);
    if (billed.defaultWorkspaceIds?.length) {
        // Said out loud because it is the one case where the two APIs name the
        // same workspace differently, and a reader checking the arithmetic by
        // hand against the Console would otherwise not know why a `null` row
        // was counted.
        lines.push(
            `  note: ${billed.defaultWorkspaceIds.join(", ")} is the Default Workspace; cost reports name it \`null\`, and its rows were matched on that.`
        );
    }
    if (billed.unresolvedWorkspaceIds?.length) {
        lines.push(
            `  warning: could not resolve ${billed.unresolvedWorkspaceIds.join(", ")} against GET Workspace.`
        );
    }
    lines.push(
        "  These are not the same measurement. The estimate is tokens x published rates; the billed total carries any contract discount, credit or tax. A difference is not a defect."
    );
    lines.push("");
    lines.push(
        "Request count is not reported by the Usage API and is not derived here."
    );
    lines.push("");
    lines.push("This report does NOT decide the 1-hour TTL question.");
    lines.push(
        "  It aggregates per day and per model; the TTL turns on the start-to-start gap"
    );
    lines.push(
        "  between consecutive requests sharing a prefix, which a daily total cannot show."
    );
    lines.push(
        "  docs/policy/anthropic-prompt-caching.md section 3.1 names the two designs that can:"
    );
    lines.push(
        "  a keyed prefix-digest interval histogram, or a 5m/1h canary on separate API keys."
    );

    process.stdout.write(`${lines.join("\n")}\n`);
};

main().catch((error) => {
    fail(
        error instanceof Error
            ? error.message
            : "The cache-efficiency report failed."
    );
});
