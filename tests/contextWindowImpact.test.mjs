import assert from "node:assert/strict";
import test from "node:test";

import {
    MAX_TOOL_INPUT_TOKEN_OVERHEAD,
    buildContextWindowImpact,
    percentile,
    toImpactRow,
} from "../lib/contextWindowImpact.ts";

/**
 * Stage 2 of the context-window rollout, checked without traffic.
 *
 * The arithmetic matters more than it looks. These numbers decide whether a
 * window gets connected, and connecting one starts rejecting real requests that
 * used to reach a provider — so a report that quietly rounds an unknown into a
 * confident count would be worse than no report.
 */

const window = (overrides = {}) => ({
    modelId: "gpt-5-6-luna",
    contextWindowTokens: 100_000,
    source: "catalogue",
    includesOutput: null,
    ...overrides,
});

const row = (overrides = {}) => ({
    modelId: "gpt-5-6-luna",
    plan: "Free",
    inputTokens: 1_000,
    maxOutputTokens: 1_000,
    ...overrides,
});

test("a request inside the window is not counted as blocked", () => {
    const report = buildContextWindowImpact(
        [row({ inputTokens: 90_000, maxOutputTokens: 10_000 })],
        [window()]
    );
    // Exactly at the limit: the guard's comparison is `>`, so this passes.
    assert.equal(report.models[0].blocked, 0);
    assert.equal(report.totalBlocked, 0);
});

test("one token over the window is blocked", () => {
    const report = buildContextWindowImpact(
        [row({ inputTokens: 90_001, maxOutputTokens: 10_000 })],
        [window()]
    );
    assert.equal(report.models[0].blocked, 1);
    assert.equal(report.models[0].blockedShare, 1);
});

test("a row over the limit without the overhead is already blocked today", () => {
    // 20,000 tokens past the limit, so removing the largest possible tool
    // overhead still leaves it over: the current guard refuses it too, and
    // connecting the corrected formula changes nothing for this row.
    const report = buildContextWindowImpact(
        [row({ inputTokens: 110_000, maxOutputTokens: 10_000 })],
        [window()]
    );
    const model = report.models[0];
    assert.equal(model.blocked, 1);
    assert.equal(model.blockedRegardlessOfToolOverhead, 1);
    assert.equal(model.blockedDependsOnToolOverhead, 0);
});

test("a row inside the overhead band is reported as undecidable, not as new", () => {
    // Over the limit by less than the maximum tool overhead. Whether today's
    // guard already refuses it depends on whether that turn carried search,
    // which the reservation did not record.
    const report = buildContextWindowImpact(
        [row({ inputTokens: 99_000, maxOutputTokens: 2_000 })],
        [window()]
    );
    const model = report.models[0];
    assert.equal(model.blocked, 1);
    assert.equal(model.blockedRegardlessOfToolOverhead, 0);
    assert.equal(model.blockedDependsOnToolOverhead, 1);
});

test("the band boundary follows the real overhead ceiling", () => {
    // Exactly MAX_TOOL_INPUT_TOKEN_OVERHEAD past the limit is still decidable:
    // subtracting the whole overhead lands on the limit, which passes.
    const onBoundary = buildContextWindowImpact(
        [
            row({
                inputTokens: 100_000 + MAX_TOOL_INPUT_TOKEN_OVERHEAD,
                maxOutputTokens: 0,
            }),
        ],
        [window()]
    );
    assert.equal(onBoundary.models[0].blockedRegardlessOfToolOverhead, 0);

    const justPast = buildContextWindowImpact(
        [
            row({
                inputTokens: 100_001 + MAX_TOOL_INPUT_TOKEN_OVERHEAD,
                maxOutputTokens: 0,
            }),
        ],
        [window()]
    );
    assert.equal(justPast.models[0].blockedRegardlessOfToolOverhead, 1);
});

test("blocked rows are split by plan", () => {
    const over = { inputTokens: 200_000, maxOutputTokens: 0 };
    const report = buildContextWindowImpact(
        [
            row({ ...over, plan: "Guest" }),
            row({ ...over, plan: "Guest" }),
            row({ ...over, plan: "Pro" }),
            row({ inputTokens: 10, maxOutputTokens: 10, plan: "Max" }),
        ],
        [window()]
    );
    assert.deepEqual(report.models[0].blockedByPlan, {
        Guest: 2,
        Free: 0,
        Pro: 1,
        Max: 0,
    });
});

test("settled rows are judged on actual usage, not on the reservation", () => {
    // The reservation is padded on purpose; what the provider really consumed
    // is the only ground truth available here.
    const report = buildContextWindowImpact(
        [
            row({
                inputTokens: 99_000,
                maxOutputTokens: 500,
                settledInputTokens: 99_500,
                settledOutputTokens: 1_000,
            }),
            row({
                inputTokens: 99_000,
                maxOutputTokens: 500,
                settledInputTokens: 10,
                settledOutputTokens: 10,
            }),
        ],
        [window()]
    );
    const model = report.models[0];
    assert.equal(model.settledRows, 2);
    assert.equal(model.settledOverWindow, 1);
});

test("an unsettled row contributes no settled evidence", () => {
    const report = buildContextWindowImpact([row()], [window()]);
    assert.equal(report.models[0].settledRows, 0);
    assert.equal(report.models[0].settledOverWindow, 0);
});

test("a model with traffic and no window is named rather than dropped", () => {
    // Reporting it as zero impact would read as "safe" when it means "no
    // evidence", and stage 1 not being finished for that model is the finding.
    const report = buildContextWindowImpact(
        [row({ modelId: "gpt-5-6-sol" }), row({ modelId: "gpt-5-6-sol" })],
        [window()]
    );
    assert.equal(report.models.length, 0);
    assert.deepEqual(report.unmeasurableModels, [
        { modelId: "gpt-5-6-sol", requests: 2 },
    ]);
    // It still counts towards what was read, so no share is computed over a
    // denominator that quietly excluded it.
    assert.equal(report.totalRequests, 2);
});

test("a verified window is preferred and labelled", () => {
    const report = buildContextWindowImpact(
        [row()],
        [window({ source: "verified", includesOutput: false })]
    );
    assert.equal(report.models[0].source, "verified");
    assert.equal(report.models[0].includesOutput, false);
});

test("provider length refusals are counted separately from the estimate", () => {
    // This is the one signal that needs no estimate at all: the provider
    // itself said the request was too long.
    const report = buildContextWindowImpact(
        [
            row({ providerContextError: true }),
            row({ providerContextError: false }),
            row({}),
        ],
        [window()]
    );
    assert.equal(report.models[0].providerContextErrors, 1);
});

test("models are ordered by traffic, busiest first", () => {
    const report = buildContextWindowImpact(
        [
            row({ modelId: "quiet" }),
            row({ modelId: "busy" }),
            row({ modelId: "busy" }),
        ],
        [window({ modelId: "quiet" }), window({ modelId: "busy" })]
    );
    assert.deepEqual(
        report.models.map((model) => model.modelId),
        ["busy", "quiet"]
    );
});

test("percentiles report a size some request really had", () => {
    const sorted = [10, 20, 30, 40, 50, 60, 70, 80, 90, 100];
    // Nearest-rank, so the answer is a member of the input rather than an
    // interpolation between two requests that neither of them had.
    assert.equal(percentile(sorted, 0.95), 100);
    assert.equal(percentile(sorted, 0.5), 50);
    assert.ok(sorted.includes(percentile(sorted, 0.99)));
    assert.equal(percentile([], 0.95), 0);
});

test("an empty corpus reports nothing rather than dividing by zero", () => {
    const report = buildContextWindowImpact([], [window()]);
    assert.deepEqual(report.models, []);
    assert.equal(report.totalRequests, 0);
    assert.equal(report.totalBlocked, 0);
});

const stored = (overrides = {}) => ({
    modelId: "gpt-5-6-luna",
    reservationPayload: { inputTokens: 100, maxOutputTokens: 50 },
    status: "reserved",
    lastError: null,
    settledInputTokens: 0,
    settledOutputTokens: 0,
    user: { plan: "Pro" },
    ...overrides,
});

test("a stored reservation maps to the tokens it booked", () => {
    const row = toImpactRow(stored());
    assert.equal(row.inputTokens, 100);
    assert.equal(row.maxOutputTokens, 50);
    assert.equal(row.plan, "Pro");
});

test("reservedOutputTokens wins over maxOutputTokens when both are present", () => {
    // Older reservations carry only maxOutputTokens; newer ones record what was
    // actually reserved, and that is the number the reservation was priced on.
    const row = toImpactRow(
        stored({
            reservationPayload: {
                inputTokens: 100,
                maxOutputTokens: 50,
                reservedOutputTokens: 70,
            },
        })
    );
    assert.equal(row.maxOutputTokens, 70);
});

test("a reservation with no account is the guest cohort", () => {
    assert.equal(toImpactRow(stored({ user: null })).plan, "Guest");
});

test("an unrecognised plan is not promoted into a paid cohort", () => {
    // A plan name this report does not know must not land in Pro by accident:
    // the plan split is read to decide who a rejection would hit.
    assert.equal(toImpactRow(stored({ user: { plan: "Legacy" } })).plan, "Guest");
    assert.equal(toImpactRow(stored({ user: { plan: null } })).plan, "Guest");
});

test("settled usage is read only from a settled reservation", () => {
    // The columns default to 0, so reading them on an open reservation would
    // report every in-flight request as having consumed nothing.
    const open = toImpactRow(
        stored({ status: "reserved", settledInputTokens: 0, settledOutputTokens: 0 })
    );
    assert.equal(open.settledInputTokens, undefined);
    assert.equal(open.settledOutputTokens, undefined);

    const done = toImpactRow(
        stored({ status: "settled", settledInputTokens: 900, settledOutputTokens: 80 })
    );
    assert.equal(done.settledInputTokens, 900);
    assert.equal(done.settledOutputTokens, 80);
});

test("an unreadable payload is null rather than a zeroed row", () => {
    // Substituting zero would move missing traffic into the "well inside the
    // window" bucket, turning absent evidence into reassurance.
    assert.equal(toImpactRow(stored({ reservationPayload: null }), 0), null);
    assert.equal(toImpactRow(stored({ reservationPayload: {} })), null);
    assert.equal(
        toImpactRow(stored({ reservationPayload: { inputTokens: "many", maxOutputTokens: 1 } })),
        null
    );
});

test("a provider length refusal is recognised from the provider's own wording", () => {
    for (const message of [
        "provider error: context_length_exceeded",
        "This model's maximum context length is 128000 tokens",
        "Request had too many tokens",
        "context window exceeded",
    ]) {
        assert.equal(
            toImpactRow(stored({ lastError: message })).providerContextError,
            true,
            message
        );
    }
    assert.equal(
        toImpactRow(stored({ lastError: "rate limited" })).providerContextError,
        false
    );
    assert.equal(toImpactRow(stored()).providerContextError, false);
});
