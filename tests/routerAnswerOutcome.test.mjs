/**
 * An empty answer is a real failure for the person who asked, so it is counted
 * against the arm that produced it rather than dropped.
 *
 * mposition's ruling after the 2026-08-27 run, which was voided as
 * VOID_GENERATION_VALIDATION_MISMATCH: 62 empty answer slots reached a bundle
 * because the writer took `result.text ?? ""` and nothing checked it, and the
 * judge graded emptiness against prose 210 times. Dropping those pairs would
 * have been worse than counting them -- it deletes an arm's worst turns and
 * flatters whichever arm fails least gracefully.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
    classifyEmptiness,
    displayableText,
    failureRecord,
    generatedTokens,
    isUsableAnswerText,
    outcomeFromReply,
} from "../lib/routerAnswerOutcome.ts";
import {
    computeWinRateDelta,
    decidePairFromAnswers,
    outcomeScore,
    pairAccounting,
    pairAccountingProblems,
    pairScore,
} from "../lib/routerQualityEvalCore.ts";

const identity = { arm: "auto", modelId: "deepseek-v4-flash", provider: "deepseek", apiModel: "deepseek-v4-flash", latencyMs: 12 };

const pair = (outcome, overrides = {}) => ({
    itemId: "coding-en-001",
    stratum: "coding",
    cell: "en",
    autoModelId: "deepseek-v4-flash",
    baselineModelId: "gpt-5-6-luna",
    autoPosition: "first",
    outcome,
    ...overrides,
});

test("whitespace is not an answer, and neither is an empty string", () => {
    assert.equal(displayableText("a"), "a");
    assert.equal(displayableText("  hello  "), "hello");
    assert.equal(displayableText(""), null);
    assert.equal(displayableText("   "), null);
    assert.equal(displayableText("\n\t \r\n"), null);
    assert.equal(displayableText(null), null);
    assert.equal(displayableText(undefined), null);

    assert.equal(isUsableAnswerText("   \n  "), false);
    assert.equal(isUsableAnswerText(" x "), true);
});

test("an empty reply becomes a failure carrying what a root cause would need", () => {
    const outcome = outcomeFromReply(
        { text: "", finishReason: "length", usage: { inputTokens: 80, outputTokens: 2048 } },
        identity
    );
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "empty_output");
    assert.equal(outcome.metadata.finishReason, "length");
    assert.equal(outcome.metadata.usage.outputTokens, 2048);
    assert.equal(outcome.metadata.arm, "auto");
    assert.equal(outcome.metadata.apiModel, "deepseek-v4-flash");
});

test("whitespace-only is a failure, and says it was whitespace rather than nothing", () => {
    const outcome = outcomeFromReply({ text: "   \n " }, identity);
    assert.equal(outcome.status, "failed");
    assert.equal(outcome.reason, "empty_output");
    assert.match(outcome.detail, /whitespace/);
    assert.equal(outcome.metadata.rawTextLength, 5);
});

test("a failure whose raw response held text is this code's defect, not the model's", () => {
    // The distinction mposition asked for: a provider that did return text and
    // an adapter that lost it look identical from an empty string alone.
    const lost = failureRecord(outcomeFromReply({ text: "    " }, identity));
    assert.equal(lost.lostByThisCode, true);
    assert.equal(lost.emptiness, "harness_lost_text");
    assert.equal(lost.rawTextLength, 4);
});

test("an empty string alone does not convict the model", () => {
    // mposition's correction. `rawTextLength === 0` says this code holds no
    // text; it does not establish that the provider sent none, because the
    // text could have been lost anywhere upstream. Calling that a model
    // failure files our defects under the model's name.
    const record = failureRecord(outcomeFromReply({ text: "" }, identity));
    assert.equal(record.emptiness, "observed_empty_at_adapter_boundary");
    assert.equal(record.lostByThisCode, false);
    assert.match(record.detail, /nothing establishes whether the provider sent any/);
});

test("output tokens the provider billed for and this code cannot show are lost text", () => {
    // The case a raw-length check cannot see: nothing arrived at
    // `rawTextLength` at all, and the provider's own usage says it generated
    // 2048 tokens. Ours, not the model's.
    const record = failureRecord(
        outcomeFromReply(
            { text: "", finishReason: "length", usage: { inputTokens: 80, outputTokens: 2048 } },
            identity
        )
    );
    assert.equal(record.emptiness, "harness_lost_text");
    assert.equal(record.lostByThisCode, true);
    assert.equal(record.rawTextLength, 0);
});

test("only the provider's own account of itself confirms the model produced nothing", () => {
    const confirmed = failureRecord(
        outcomeFromReply(
            { text: "", finishReason: "stop", usage: { inputTokens: 80, outputTokens: 0 } },
            identity
        )
    );
    assert.equal(confirmed.emptiness, "provider_confirmed_empty");
    assert.equal(confirmed.lostByThisCode, false);
    assert.match(confirmed.detail, /produced nothing/);

    // Zero tokens with no finish reason is not a confirmation: the call may
    // have died before the provider decided anything.
    const unfinished = failureRecord(
        outcomeFromReply({ text: "", usage: { outputTokens: 0 } }, identity)
    );
    assert.equal(unfinished.emptiness, "observed_empty_at_adapter_boundary");

    // A finish reason with no usage at all is equally not a confirmation.
    const noUsage = failureRecord(outcomeFromReply({ text: "", finishReason: "stop" }, identity));
    assert.equal(noUsage.emptiness, "observed_empty_at_adapter_boundary");
});

test("a missing output-token count survives as unknown rather than becoming zero", () => {
    assert.equal(generatedTokens({}), null);
    assert.equal(generatedTokens({ inputTokens: 40 }), null);
    assert.equal(generatedTokens({ outputTokens: 0 }), 0);
    assert.equal(generatedTokens({ completion_tokens: 7 }), 7);
    // Were the absence to collapse to 0, this would read as the provider
    // confirming it generated nothing.
    assert.equal(
        classifyEmptiness({ ...identity, finishReason: "stop", usage: {}, rawTextLength: 0, traceId: null }),
        "observed_empty_at_adapter_boundary"
    );
});

test("an unattributable empty carries what somebody would need to go and ask", () => {
    const record = failureRecord(
        outcomeFromReply(
            { text: "", finishReason: "content_filter", usage: {}, traceId: "resp_01ABC" },
            identity
        )
    );
    assert.equal(record.emptiness, "observed_empty_at_adapter_boundary");
    assert.equal(record.arm, "auto");
    assert.equal(record.provider, "deepseek");
    assert.equal(record.apiModel, "deepseek-v4-flash");
    assert.equal(record.finishReason, "content_filter");
    assert.deepEqual(record.usage, {});
    assert.equal(record.traceId, "resp_01ABC");
});

test("a provider error is not classified as an emptiness at all", () => {
    const record = failureRecord({
        status: "failed",
        reason: "provider_error",
        detail: "ETIMEDOUT",
        metadata: { ...identity, finishReason: null, usage: {}, rawTextLength: 0, traceId: null },
    });
    assert.equal(record.emptiness, null);
    assert.equal(record.lostByThisCode, false);
});

test("a usable reply is trimmed and kept", () => {
    const outcome = outcomeFromReply({ text: "  the answer  ", finishReason: "stop" }, identity);
    assert.equal(outcome.status, "ok");
    assert.equal(outcome.text, "the answer");
    assert.equal(outcome.metadata.finishReason, "stop");
});

test("an empty arm loses that pair end to end, and is absent from the quality delta", () => {
    const autoEmpty = pair({ status: "excluded", reason: "auto_arm_empty" });
    const baselineEmpty = pair({ status: "excluded", reason: "baseline_arm_empty" });
    const bothEmpty = pair({ status: "excluded", reason: "both_arms_empty" });

    assert.equal(pairScore(autoEmpty), null);
    assert.equal(pairScore(baselineEmpty), null);
    assert.equal(pairScore(bothEmpty), null);

    assert.equal(outcomeScore(autoEmpty), -1);
    assert.equal(outcomeScore(baselineEmpty), 1);
    assert.equal(outcomeScore(bothEmpty), 0);
});

test("a provider error counts the same as an empty answer, so neither arm is favoured", () => {
    // An arm that hard-errors and an arm that returns nothing both left the
    // person with nothing. Counting only one would reward the other.
    assert.equal(outcomeScore(pair({ status: "excluded", reason: "auto_arm_failed" })), -1);
    assert.equal(outcomeScore(pair({ status: "excluded", reason: "baseline_arm_failed" })), 1);
});

test("the Router declining, blinding and judge failures stay out of both estimates", () => {
    for (const reason of ["no_candidate", "self_identified", "judge_failed"]) {
        assert.equal(outcomeScore(pair({ status: "excluded", reason })), null, reason);
    }
});

test("the four buckets add up to every pair, and say so when they do not", () => {
    const pairs = [
        pair({ status: "judged", verdict: "auto" }),
        pair({ status: "judged", verdict: "baseline" }),
        pair({ status: "excluded", reason: "auto_arm_empty" }),
        pair({ status: "excluded", reason: "baseline_arm_failed" }),
        pair({ status: "excluded", reason: "both_arms_empty" }),
        pair({ status: "excluded", reason: "self_identified" }),
        pair({ status: "excluded", reason: "no_candidate" }),
    ];
    const accounting = pairAccounting(pairs);
    assert.deepEqual(accounting, {
        total: 7,
        judgeable: 2,
        singleArmFailure: 2,
        doubleArmFailure: 1,
        otherExclusions: 2,
    });
    assert.deepEqual(pairAccountingProblems(accounting), []);
    assert.match(
        pairAccountingProblems({ ...accounting, total: 8 }).join(" "),
        /the buckets sum to 7 against 8 pairs/
    );
});

test("the two deltas answer different questions over different denominators", () => {
    // Auto wins both pairs it answered, and produced nothing on three others.
    const pairs = [
        pair({ status: "judged", verdict: "auto" }),
        pair({ status: "judged", verdict: "auto" }),
        pair({ status: "excluded", reason: "auto_arm_empty" }),
        pair({ status: "excluded", reason: "auto_arm_empty" }),
        pair({ status: "excluded", reason: "auto_arm_empty" }),
    ];
    const quality = computeWinRateDelta(pairs, { method: "normal_approximation" });
    const endToEnd = computeWinRateDelta(pairs, {
        method: "normal_approximation",
        score: outcomeScore,
    });

    assert.equal(quality.n, 2);
    assert.equal(quality.pointEstimatePp, 100);

    assert.equal(endToEnd.n, 5);
    assert.equal(endToEnd.pointEstimatePp, (2 - 3) / 5 * 100);

    // The point of reporting both: on these pairs Auto is flawless on quality
    // and behind on what the person received.
    assert.ok(quality.pointEstimatePp > 0 && endToEnd.pointEstimatePp < 0);
});

test("both arms empty is a zero in the denominator, not a pair nobody counted", () => {
    const pairs = [
        pair({ status: "judged", verdict: "auto" }),
        pair({ status: "excluded", reason: "both_arms_empty" }),
    ];
    const endToEnd = computeWinRateDelta(pairs, { method: "normal_approximation", score: outcomeScore });
    assert.equal(endToEnd.n, 2);
    assert.equal(endToEnd.wins, 1);
    assert.equal(endToEnd.losses, 0);
    assert.equal(endToEnd.ties, 1);
});

// The judge call in scripts/eval-router-quality.mjs is reachable only through
// `action: "judge"`. These are the ways a pair can arrive, and only one of
// them gets there.

const okAnswer = (arm) => outcomeFromReply({ text: "an answer", finishReason: "stop" }, { ...identity, arm });
const emptyAnswer = (arm) => outcomeFromReply({ text: "", finishReason: "length" }, { ...identity, arm });
const whitespaceAnswer = (arm) => outcomeFromReply({ text: "  \n " }, { ...identity, arm });
const erroredAnswer = (arm) => ({
    status: "failed",
    reason: "provider_error",
    detail: "socket hang up",
    metadata: { ...identity, arm, finishReason: null, usage: {}, rawTextLength: 0 },
});

test("no judge is called when either arm produced nothing", () => {
    assert.deepEqual(decidePairFromAnswers(okAnswer("auto"), okAnswer("baseline")), { action: "judge" });

    const autoOnly = decidePairFromAnswers(emptyAnswer("auto"), okAnswer("baseline"));
    assert.equal(autoOnly.action, "exclude");
    assert.equal(autoOnly.reason, "auto_arm_empty");
    assert.match(autoOnly.detail, /auto: empty_output/);

    const baselineOnly = decidePairFromAnswers(okAnswer("auto"), emptyAnswer("baseline"));
    assert.equal(baselineOnly.action, "exclude");
    assert.equal(baselineOnly.reason, "baseline_arm_empty");

    const both = decidePairFromAnswers(emptyAnswer("auto"), emptyAnswer("baseline"));
    assert.equal(both.action, "exclude");
    assert.equal(both.reason, "both_arms_empty");
    assert.match(both.detail, /auto: empty_output/);
    assert.match(both.detail, /baseline: empty_output/);
});

test("whitespace-only reaches the same exclusion as an empty string", () => {
    const decision = decidePairFromAnswers(whitespaceAnswer("auto"), okAnswer("baseline"));
    assert.equal(decision.action, "exclude");
    assert.equal(decision.reason, "auto_arm_empty");
    assert.match(decision.detail, /4 character\(s\) of whitespace/);
});

test("a provider error is excluded under its own reason, and still loses the pair", () => {
    const decision = decidePairFromAnswers(erroredAnswer("auto"), okAnswer("baseline"));
    assert.equal(decision.reason, "auto_arm_failed");
    assert.equal(outcomeScore(pair({ status: "excluded", reason: decision.reason })), -1);

    const baseline = decidePairFromAnswers(okAnswer("auto"), erroredAnswer("baseline"));
    assert.equal(baseline.reason, "baseline_arm_failed");
    assert.equal(outcomeScore(pair({ status: "excluded", reason: baseline.reason })), 1);
});
