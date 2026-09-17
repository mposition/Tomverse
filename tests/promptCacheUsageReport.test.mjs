import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import {
    SMALL_SAMPLE_ATTEMPTS,
    aggregatePromptCacheUsage,
    cacheWriteRateState,
    PromptCacheGroupLimitError,
    createPromptCacheAggregator,
    promptCacheFixtureRows,
    readAttemptUsagePages,
    summarisePromptCacheUsage,
} from "../scripts/report-prompt-cache-usage-core.mjs";

/**
 * CACHE-01. Every figure the report prints for the synthetic fixture is written
 * out here by hand, so a change to the aggregation that moves a number has to
 * move it in this file too. The fixture carries each state the report must keep
 * apart: observed, estimated, unobserved, a priced write, an unpriced write and
 * a snapshot that predates the rate field.
 */

const groups = aggregatePromptCacheUsage(promptCacheFixtureRows());
const group = (provider, modelId, source) =>
    groups.find((g) => g.provider === provider && g.modelId === modelId && g.source === source);

test("groups are provider x model x source, and a path is never merged into another", () => {
    assert.deepEqual(
        groups.map((g) => `${g.provider}/${g.modelId}/${g.source}`),
        [
            "anthropic/claude-sonnet-5/chat",
            "anthropic/claude-sonnet-5/comparison_review",
            "minimax/minimax-m3/chat",
            "openai/gpt-5-6-luna/chat",
        ]
    );
});

test("observed attempts give the shares; an unobserved row is counted, never zeroed in", () => {
    const chat = group("anthropic", "claude-sonnet-5", "chat");
    assert.equal(chat.attempts, 3);
    assert.equal(chat.observedAttempts, 2);
    assert.equal(chat.unobservedAttempts, 1);
    assert.equal(chat.inputTokens, 20_000);
    assert.equal(chat.cachedInputTokens, 14_000);
    assert.equal(chat.cacheWriteInputTokens, 2_000);
    assert.equal(chat.cacheReadShare, 0.7);
    assert.equal(chat.cacheWriteShare, 0.1);
    assert.equal(chat.attemptsWithCacheRead, 2);
    assert.equal(chat.attemptsWithCacheWrite, 1);
    assert.equal(chat.unpricedCacheWriteTokens, 0);
    assert.equal(chat.state, "cache_observed");
});

test("all-zero cache tokens are 'no cache observed', not 'no cache'", () => {
    const review = group("anthropic", "claude-sonnet-5", "comparison_review");
    assert.equal(review.state, "no_cache_observed");
    assert.equal(review.cacheReadShare, 0);
});

test("a write with no verified rate is reported as unpriced", () => {
    const minimax = group("minimax", "minimax-m3", "chat");
    assert.equal(minimax.unpricedCacheWriteTokens, 500);
    assert.equal(minimax.attemptsWithUnpricedCacheWrite, 1);
    assert.equal(minimax.cacheReadShare, 0.2);
});

test("an estimate stays out of the shares, and a snapshot without the rate field is its own state", () => {
    const openai = group("openai", "gpt-5-6-luna", "chat");
    assert.equal(openai.attempts, 2);
    assert.equal(openai.estimatedAttempts, 1);
    assert.equal(openai.observedAttempts, 1);
    assert.equal(openai.inputTokens, 8_000);
    assert.equal(openai.cacheReadShare, 0.25);
    assert.equal(openai.unpricedCacheWriteTokens, 0);
    assert.equal(openai.attemptsWithUnknownWriteRate, 1);
    assert.equal(openai.unknownRateCacheWriteTokens, 100);
});

test("one group with priced, unpriced and unknown-rate writes keeps each volume apart", () => {
    const observed = { provider: "p", modelId: "m", source: "chat", usageSource: "provider_usage_metadata", inputTokens: 1_000, cachedInputTokens: 0 };
    const [mixed] = aggregatePromptCacheUsage([
        { ...observed, cacheWriteInputTokens: 300, pricingSnapshot: { cacheWriteUsdPerMillionTokens: 3.75 } },
        { ...observed, cacheWriteInputTokens: 200, pricingSnapshot: { cacheWriteUsdPerMillionTokens: null } },
        { ...observed, cacheWriteInputTokens: 50, pricingSnapshot: {} },
    ]);
    assert.equal(mixed.cacheWriteInputTokens, 550);
    assert.equal(mixed.attemptsWithCacheWrite, 3);
    assert.equal(mixed.unpricedCacheWriteTokens, 200);
    assert.equal(mixed.attemptsWithUnpricedCacheWrite, 1);
    assert.equal(mixed.unknownRateCacheWriteTokens, 50);
    assert.equal(mixed.attemptsWithUnknownWriteRate, 1);
});

test("a group with no observed attempt has no share and says so", () => {
    const [group] = aggregatePromptCacheUsage([
        { provider: "p", modelId: "m", source: "chat", usageSource: "crash_reconciliation", inputTokens: null, cachedInputTokens: null, cacheWriteInputTokens: null, pricingSnapshot: null },
        { provider: "p", modelId: "m", source: "chat", usageSource: "fallback_estimator", inputTokens: 900, cachedInputTokens: 0, cacheWriteInputTokens: 0, pricingSnapshot: {} },
    ]);
    assert.equal(group.state, "no_observed_usage");
    assert.equal(group.cacheReadShare, null);
    assert.equal(group.unobservedAttempts, 1);
    assert.equal(group.estimatedAttempts, 1);
});

test("the paged reader walks every page once, inside fixed bounds, one row at a time", async () => {
    const since = new Date("2026-09-01T00:00:00.000Z");
    const until = new Date("2026-09-08T00:00:00.000Z");
    const inside = Array.from({ length: 7 }, (_, index) => ({
        id: `r${String(index).padStart(2, "0")}`,
        createdAt: new Date(since.getTime() + index * 60_000),
        provider: "p",
        modelId: "m",
        reservation: { source: "chat" },
        usageSource: "provider_usage_metadata",
        inputTokens: 100,
        cachedInputTokens: 10,
        cacheWriteInputTokens: 0,
        pricingSnapshot: {},
    }));
    // Written after the report started: outside `until`, never read.
    const late = { ...inside[0], id: "r99", createdAt: new Date(until.getTime() + 1) };
    const table = [...inside, late];
    const calls = [];
    const findMany = async (args) => {
        calls.push(args);
        const { gte, lt } = args.where.createdAt;
        let rows = table.filter((row) => row.createdAt >= gte && row.createdAt < lt).sort((a, b) => a.id.localeCompare(b.id));
        if (args.cursor) rows = rows.filter((row) => row.id > args.cursor.id);
        return rows.slice(0, args.take);
    };
    const aggregator = createPromptCacheAggregator();
    let seen = 0;
    const { pages } = await readAttemptUsagePages({
        findMany,
        since,
        until,
        pageSize: 3,
        onRow: (row) => {
            seen += 1;
            aggregator.add({ ...row, source: row.reservation.source });
        },
    });
    assert.equal(pages, 3);
    assert.equal(seen, 7);
    assert.ok(calls.every((call) => call.where.createdAt.gte === since && call.where.createdAt.lt === until));
    const [group] = aggregator.result();
    assert.equal(group.attempts, 7);
    assert.equal(group.cacheReadShare, 0.1);
});

test("more groups than the cap is a refusal, not an unbounded map", () => {
    const aggregator = createPromptCacheAggregator({ maxGroups: 2 });
    const row = (modelId) => ({ provider: "p", modelId, source: "chat", usageSource: "provider_usage_metadata", inputTokens: 1, cachedInputTokens: 0, cacheWriteInputTokens: 0, pricingSnapshot: {} });
    aggregator.add(row("a"));
    aggregator.add(row("b"));
    aggregator.add(row("a"));
    assert.throws(() => aggregator.add(row("c")), PromptCacheGroupLimitError);
    assert.equal(aggregator.result().length, 2);
});

test("every fixture group is a small sample", () => {
    assert.ok(groups.every((g) => g.smallSample));
    assert.ok(SMALL_SAMPLE_ATTEMPTS > 2);
});

test("the summary totals use the same exclusions", () => {
    const summary = summarisePromptCacheUsage(groups);
    assert.equal(summary.attempts, 7);
    assert.equal(summary.observedAttempts, 5);
    assert.equal(summary.estimatedAttempts, 1);
    assert.equal(summary.unobservedAttempts, 1);
    assert.equal(summary.inputTokens, 37_000);
    assert.equal(summary.cachedInputTokens, 17_000);
    assert.equal(summary.cacheReadShare, 0.4595);
    assert.equal(summary.unpricedCacheWriteTokens, 500);
    assert.equal(summary.unknownRateCacheWriteTokens, 100);
    assert.equal(summary.groupsWithNoCacheObserved, 1);
});

test("the write-rate state reads the snapshot and nothing else", () => {
    assert.equal(cacheWriteRateState({ cacheWriteUsdPerMillionTokens: 3.75 }), "priced");
    assert.equal(cacheWriteRateState({ cacheWriteUsdPerMillionTokens: 0 }), "priced");
    assert.equal(cacheWriteRateState({ cacheWriteUsdPerMillionTokens: null }), "unpriced");
    assert.equal(cacheWriteRateState({}), "unknown");
    assert.equal(cacheWriteRateState(null), "unknown");
    assert.equal(cacheWriteRateState([]), "unknown");
});

const cli = (args) =>
    spawnSync(process.execPath, ["--import", "tsx", "scripts/report-prompt-cache-usage.mjs", ...args], {
        encoding: "utf8",
        env: { ...process.env, DATABASE_URL: "" },
    });

test("the CLI prints the synthetic fixture without credentials and refuses bad input", () => {
    const fixture = cli(["--json"]);
    assert.equal(fixture.status, 0, fixture.stderr);
    const report = JSON.parse(fixture.stdout);
    assert.equal(report.data, "synthetic_fixture");
    assert.equal(report.summary.attempts, 7);

    assert.equal(cli(["--database"]).status, 2);
    assert.equal(cli(["--days", "0"]).status, 2);
    assert.equal(cli(["--days", "400"]).status, 2);
});
