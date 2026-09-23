// CACHE-01: how much of the input the providers actually served from their
// prompt caches, by provider x model x source, from the app's own usage rows.
//
//   npm run report:prompt-cache-usage                          # synthetic fixture only, no credentials
//   npm run report:prompt-cache-usage -- --json
//   npm run report:prompt-cache-usage -- --database            # stored usage, read-only, last 30 days
//   npm run report:prompt-cache-usage -- --database --days 7
//
// Writes nothing, anywhere, and changes no price, charge or cache setting. It
// exits 0 whatever it finds -- this is evidence, not a gate -- and 2 when it is
// run wrongly.
//
// Reads ChatAttemptUsage (one row per provider call a chat turn or an AI Review
// made) joined to its reservation's `source`. No prompt, answer, user id or
// conversation id is read or printed; the output is provider, model, source and
// counts.
//
// What the numbers are:
//   - cache read share = cached input tokens / input tokens, over attempts whose
//     usage came from the provider. Estimated rows and rows nobody observed are
//     counted apart and never enter a share.
//   - unpriced write = cache-write tokens on an attempt whose pricing snapshot
//     recorded no cache-write rate, so they were charged nothing.
//   - `no_cache_observed` means every observed attempt carried zero cache
//     tokens. It does not mean the provider has no cache: this table cannot
//     tell a reported zero from a field that was never read.
//   - Paths that write no ChatAttemptUsage row (conversation titles, provider
//     probes and verification, memory extraction) are not in this report at all.
//
// The --database flag is required even when DATABASE_URL is set, so a run
// against a production URL is a decision rather than a side effect.

import {
    SMALL_SAMPLE_ATTEMPTS,
    aggregatePromptCacheUsage,
    createPromptCacheAggregator,
    promptCacheFixtureRows,
    readAttemptUsagePages,
    summarisePromptCacheUsage,
} from "./report-prompt-cache-usage-core.mjs";

const argv = process.argv.slice(2);
const json = argv.includes("--json");
const useDatabase = argv.includes("--database");

let days = 30;
if (argv.includes("--days")) {
    const value = argv[argv.indexOf("--days") + 1] ?? "";
    if (!/^[1-9]\d*$/.test(value) || Number(value) > 366) {
        process.stderr.write("--days needs a whole number from 1 to 366, for example --days 7\n");
        process.exit(2);
    }
    days = Number(value);
}

const PAGE = 5_000;

const readStoredGroups = async () => {
    process.env.PRISMA_CLIENT_LOG = "";
    const { prisma } = await import("../lib/prisma.ts");
    // Both ends fixed before the first page: rows written while the report
    // runs are outside the window rather than a moving tail.
    const until = new Date();
    const since = new Date(until.getTime() - days * 24 * 60 * 60 * 1_000);
    const aggregator = createPromptCacheAggregator();
    try {
        await readAttemptUsagePages({
            since,
            until,
            pageSize: PAGE,
            findMany: (args) =>
                prisma.chatAttemptUsage.findMany({
                    ...args,
                    select: {
                        id: true,
                        provider: true,
                        modelId: true,
                        usageSource: true,
                        inputTokens: true,
                        cachedInputTokens: true,
                        cacheWriteInputTokens: true,
                        pricingSnapshot: true,
                        reservation: { select: { source: true } },
                    },
                }),
            onRow: (row) =>
                aggregator.add({
                    provider: row.provider,
                    modelId: row.modelId,
                    source: row.reservation?.source ?? null,
                    usageSource: row.usageSource,
                    inputTokens: row.inputTokens,
                    cachedInputTokens: row.cachedInputTokens,
                    cacheWriteInputTokens: row.cacheWriteInputTokens,
                    pricingSnapshot: row.pricingSnapshot,
                }),
        });
    } finally {
        await prisma.$disconnect();
    }
    return { since: since.toISOString(), until: until.toISOString(), groups: aggregator.result() };
};

let report;
if (useDatabase) {
    if (!process.env.DATABASE_URL?.trim()) {
        process.stderr.write("--database needs DATABASE_URL.\n");
        process.exit(2);
    }
    let read;
    try {
        read = await readStoredGroups();
    } catch (error) {
        if (error?.name === "PromptCacheGroupLimitError") {
            process.stderr.write(`Refused: ${error.message}. Narrow --days.\n`);
            process.exit(1);
        }
        // The message of a connection error names the host; print its class only.
        process.stderr.write(`Could not read stored usage (${error?.name ?? "Error"}).\n`);
        process.exit(1);
    }
    report = {
        data: "database",
        since: read.since,
        until: read.until,
        days,
        summary: summarisePromptCacheUsage(read.groups),
        groups: read.groups,
    };
} else {
    const groups = aggregatePromptCacheUsage(promptCacheFixtureRows());
    report = { data: "synthetic_fixture", summary: summarisePromptCacheUsage(groups), groups };
}

if (json) {
    console.log(JSON.stringify(report, null, 2));
} else {
    const pct = (value) => (value === null ? "   n/a" : `${(value * 100).toFixed(1).padStart(5)}%`);
    console.log("Prompt cache usage (CACHE-01) -- evidence, not a gate");
    console.log(
        report.data === "database"
            ? `  stored ChatAttemptUsage from ${report.since} to ${report.until} (${report.days} days)`
            : "  SYNTHETIC FIXTURE. Pass --database to read stored usage (read-only)."
    );
    const s = report.summary;
    console.log(
        `  attempts ${s.attempts}: observed ${s.observedAttempts}, estimated ${s.estimatedAttempts}, unobserved ${s.unobservedAttempts}. ` +
            `cache read share ${pct(s.cacheReadShare).trim()}. unpriced cache-write tokens ${s.unpricedCacheWriteTokens}; cache-write tokens with no rate in the snapshot ${s.unknownRateCacheWriteTokens}.`
    );
    console.log(`  shares use observed attempts only; * marks fewer than ${SMALL_SAMPLE_ATTEMPTS} observed attempts.\n`);
    for (const group of report.groups) {
        console.log(`  ${group.provider} / ${group.modelId} / ${group.source}${group.smallSample ? " *" : ""}`);
        console.log(
            `    attempts ${group.attempts} (observed ${group.observedAttempts}, estimated ${group.estimatedAttempts}, unobserved ${group.unobservedAttempts})  state ${group.state}`
        );
        console.log(
            `    read ${pct(group.cacheReadShare)} of input (${group.attemptsWithCacheRead} attempts)  write ${pct(group.cacheWriteShare)} (${group.attemptsWithCacheWrite} attempts)`
        );
        if (group.unpricedCacheWriteTokens > 0 || group.attemptsWithUnknownWriteRate > 0) {
            console.log(
                `    unpriced write tokens ${group.unpricedCacheWriteTokens} (${group.attemptsWithUnpricedCacheWrite} attempts); write rate not in snapshot: ${group.unknownRateCacheWriteTokens} tokens on ${group.attemptsWithUnknownWriteRate} attempts`
            );
        }
    }
    console.log(
        "\n  Not covered: conversation titles, provider probes and verification, and memory extraction write no ChatAttemptUsage row."
    );
}
