import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
    ACTIVE_ESTIMATOR_VERSION,
    atLeastOneToken,
    createTokenEstimateAccumulator,
    estimateTokenBreakdown,
    toReservedInputTokens,
} from "../lib/chatTokenEstimate.ts";

/**
 * Why `createChatBudget` takes a breakdown rather than a token count.
 *
 * The reservation widens each character segment by its own margin, so that a
 * recalibrated Hangul coefficient leaves a Latin, code or JSON request exactly
 * where it was. A caller that adds its pieces into one number has already
 * thrown that mix away, and `toReservedInputTokens` is then left widening the
 * total by the largest margin any segment carries -- correct, in that it
 * cannot under-reserve, but wrong for every request that is not all Korean.
 *
 * Under `generic_multilingual_v1` every margin is 1, so none of this is
 * visible today. That is exactly why it needs a test: the difference only
 * appears the day a calibration with real margins goes active, which is the
 * worst moment to discover a surface that quietly opted out.
 */

const accumulate = (parts) =>
    parts
        .reduce(
            (accumulator, part) =>
                typeof part === "number"
                    ? accumulator.addTokens(part)
                    : accumulator.addText(part),
            createTokenEstimateAccumulator()
        )
        .breakdown();

test("an accumulated breakdown totals what the pieces totalled separately", () => {
    // The migration's whole risk: the surfaces used to sum per-piece estimates,
    // and the breakdown has to reproduce that sum exactly or every reservation
    // moves.
    const pieces = ["안녕하세요 반갑습니다", "hello world", "こんにちは"];
    const separately = pieces.reduce(
        (sum, piece) => sum + estimateTokenBreakdown(piece).rawTotal,
        0
    );
    assert.equal(accumulate(pieces).rawTotal, separately);
});

test("opaque tokens are counted but never widened", () => {
    // An attachment allowance is not a tokenizer prediction, so no tokenizer
    // margin belongs on it. Checked against the one shipped calibration that
    // has a margin above 1.
    const withOpaque = accumulate(["안녕하세요", 500]);
    const textOnly = accumulate(["안녕하세요"]);

    assert.equal(withOpaque.opaqueTokens, 500);
    assert.equal(withOpaque.rawTotal, textOnly.rawTotal + 500);

    const v2 = createTokenEstimateAccumulator("hangul_segment_v2")
        .addText("안녕하세요")
        .addTokens(500)
        .breakdown();
    const v2TextOnly = createTokenEstimateAccumulator("hangul_segment_v2")
        .addText("안녕하세요")
        .breakdown();

    // The Hangul term is widened by 1.2; the 500 passes through untouched.
    assert.equal(
        toReservedInputTokens(v2) - toReservedInputTokens(v2TextOnly),
        500
    );
    assert.ok(
        toReservedInputTokens(v2TextOnly) > v2TextOnly.rawTotal,
        "the Hangul segment should be widened under hangul_segment_v2"
    );
});

test("a segment margin reaches only its own segment", () => {
    // The reason the breakdown exists at all. Latin text must be untouched by
    // a Hangul recalibration.
    const latin = createTokenEstimateAccumulator("hangul_segment_v2")
        .addText("the quick brown fox jumps over the lazy dog")
        .breakdown();
    assert.equal(toReservedInputTokens(latin), latin.rawTotal);
});

test("a bare total is widened by the largest margin, never the smallest", () => {
    // The fallback still has to be safe for a caller that arrives later with
    // only a number: over-reserving is refunded at settlement, under-reserving
    // is a request that ran on credits nobody held.
    const total = 1_000;
    const reserved = toReservedInputTokens(total, {
        version: "hangul_segment_v2",
    });
    assert.equal(reserved, 1_200);
});

test("the one-token floor lands as an opaque token, not as text", () => {
    const empty = atLeastOneToken(accumulate([]));
    assert.equal(empty.rawTotal, 1);
    assert.equal(empty.opaqueTokens, 1);
    assert.deepEqual(empty.tokensBySegment, { hangul: 0, hanKana: 0, nonCjk: 0 });
    // A non-empty estimate is returned untouched.
    const real = accumulate(["hello"]);
    assert.equal(atLeastOneToken(real), real);
});

test("the accumulator records the active calibration", () => {
    assert.equal(accumulate(["x"]).version, ACTIVE_ESTIMATOR_VERSION);
});

test("no reservation surface passes createChatBudget a bare number", () => {
    // The guard that keeps this migration from rotting. A new surface that
    // sums its pieces into a number still compiles -- the numeric overload is
    // deliberately kept as a safe floor -- so nothing would fail until a
    // calibration with real margins went active and that surface silently
    // reserved by the wrong one.
    const CALL_SITES = [
        "app/api/chat/route.ts",
        "app/api/chat/preflight/route.ts",
        "app/api/chat/availability/route.ts",
        "app/api/chat/compare-summary/route.ts",
        "app/api/conversations/[conversationId]/compare-summary/route.ts",
        "app/api/conversations/[conversationId]/comparison-reviews/verify-item/route.ts",
        "lib/comparisonReviewService.ts",
    ];
    // `app/api/chat/route.ts` is absent from the byte/4 ban below and present
    // in the breakdown check above, deliberately: it still estimates *output*
    // tokens that way when settling a cancelled stream. That is a different
    // quantity on a different side of the request, and this estimator predicts
    // prompt tokens only.
    const INPUT_ESTIMATE_SITES = CALL_SITES.filter(
        (path) => path !== "app/api/chat/route.ts"
    );

    const withoutComments = (source) =>
        source
            .split("\n")
            .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
            .join("\n");

    for (const path of CALL_SITES) {
        const source = withoutComments(readFileSync(path, "utf8"));
        assert.match(
            source,
            /createTokenEstimateAccumulator|TokenEstimateBreakdown|estimateComparisonReviewTokens/,
            `${path} calls createChatBudget but never builds a breakdown`
        );
    }

    for (const path of INPUT_ESTIMATE_SITES) {
        const source = withoutComments(readFileSync(path, "utf8"));
        assert.doesNotMatch(
            source,
            /Buffer\.byteLength\([^)]*\)\s*\/\s*4/,
            `${path} still carries its own byte/4 input estimate; use lib/chatTokenEstimate.ts`
        );
    }
});
