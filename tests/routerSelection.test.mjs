import assert from "node:assert/strict";
import test from "node:test";

import {
    ROUTER_COST_TIE_EPSILON_RATIO,
    ROUTER_SCORE_POLICY_VERSION,
    ROUTER_STICKY_HYSTERESIS_TURNS,
    ROUTER_STICKY_SWITCH_MARGIN_BANDS,
    ROUTER_SUCCESS_RATE_TIE_EPSILON,
    ROUTER_TTFT_TIE_EPSILON_MS,
} from "../lib/routerScorePolicy.ts";
import {
    ROUTER_SELECTION_VERSION,
    SELECTION_REASONS,
    selectRouterModel,
} from "../lib/routerSelection.ts";
import { buildTaskProfile } from "../lib/taskProfileCore.ts";

/**
 * Router Pass 1's choice, in shadow mode.
 *
 * Two things these tests are about. The tie-break, because with every quality
 * band neutral it is what actually decides -- and it has to decide the same
 * way twice, from measured signals, abstaining where it has none. And *not*
 * changing model: a router that picks a slightly different winner every turn
 * is worse than one that picks a mediocre model and stays, because the user
 * sees the answer's character change between two questions that felt identical
 * to them and nothing on screen explains it.
 */

const candidates = (...modelIds) =>
    modelIds.map((modelId) => ({ modelId, outputTokens: 4_000 }));

const codingTurn = buildTaskProfile({ text: "이 정규식 디버그해 줘" });
const plainTurn = buildTaskProfile({ text: "안녕" });

test("no eligible candidate selects nothing and says so", () => {
    // The caller must not invent a model here. An empty candidate set is the
    // filters having refused everything, and substituting one would undo them.
    const result = selectRouterModel({ profile: codingTurn, eligible: [] });
    assert.equal(result.selectedModelId, null);
    assert.equal(result.reason, "no_candidate");
    assert.equal(result.decidedBy, null);
    assert.equal(result.version, ROUTER_SELECTION_VERSION);
    assert.equal(result.policyVersion, ROUTER_SCORE_POLICY_VERSION);
});

test("every reason is one of the declared identifiers", () => {
    for (const eligible of [
        [],
        candidates("gpt-5-6-luna"),
        candidates("gpt-5-6-luna", "deepseek-v4-flash"),
    ]) {
        const result = selectRouterModel({ profile: codingTurn, eligible });
        assert.ok(SELECTION_REASONS.includes(result.reason), result.reason);
    }
});

test("a single candidate wins without consulting a preference", () => {
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("qwen3.6-flash"),
    });
    assert.equal(result.selectedModelId, "qwen3.6-flash");
    assert.equal(result.reason, "only_candidate");
    assert.equal(result.margin, 0);
    assert.equal(result.decidedBy, null);
});

// The state of the snapshot, pinned deliberately rather than assumed. Every
// band is neutral because nothing has been measured, so quality separates
// nobody and the tie-break below is the whole decision. When the first
// approved evidence record lands this test is the one that should fail.
test("with no evidence in the snapshot, quality decides nothing", () => {
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash", "gpt-5-6-luna", "kimi-k3"),
    });
    assert.notEqual(result.decidedBy, "quality_band");
    assert.notEqual(result.reason, "task_preference");
    assert.equal(result.margin, 0);
});

test("the tie-break applies its criteria in the documented order", () => {
    const eligible = candidates("model-a", "model-b");

    // 2. Cost, once quality is level.
    const byCost = selectRouterModel({
        profile: plainTurn,
        eligible,
        signals: {
            expectedTotalCostUsdByModelId: { "model-a": 0.9, "model-b": 0.2 },
            recentSuccessRateByModelId: { "model-a": 1, "model-b": 0.5 },
            ttftP95MsByModelId: { "model-a": 100, "model-b": 9_000 },
        },
    });
    assert.equal(byCost.selectedModelId, "model-b");
    assert.equal(byCost.decidedBy, "expected_total_cost");

    // 3. Success rate, once cost is level too.
    const bySuccess = selectRouterModel({
        profile: plainTurn,
        eligible,
        signals: {
            expectedTotalCostUsdByModelId: { "model-a": 0.5, "model-b": 0.5 },
            recentSuccessRateByModelId: { "model-a": 0.99, "model-b": 0.6 },
            ttftP95MsByModelId: { "model-a": 9_000, "model-b": 100 },
        },
    });
    assert.equal(bySuccess.selectedModelId, "model-a");
    assert.equal(bySuccess.decidedBy, "recent_success_rate");

    // 4. Time to first token, once the two above are level.
    const byLatency = selectRouterModel({
        profile: plainTurn,
        eligible,
        signals: {
            expectedTotalCostUsdByModelId: { "model-a": 0.5, "model-b": 0.5 },
            recentSuccessRateByModelId: { "model-a": 0.9, "model-b": 0.9 },
            ttftP95MsByModelId: { "model-a": 5_000, "model-b": 400 },
        },
    });
    assert.equal(byLatency.selectedModelId, "model-b");
    assert.equal(byLatency.decidedBy, "ttft_p95");

    // 5. The stable identifier, when nothing above separated them.
    const byId = selectRouterModel({ profile: plainTurn, eligible });
    assert.equal(byId.selectedModelId, "model-a");
    assert.equal(byId.decidedBy, "model_id");
    assert.equal(byId.reason, "fallback_order");
});

// A model nobody has ever called must not outrank one with a measured record
// by virtue of having no record. Unknown is unknown, not perfect and not zero.
test("a missing signal abstains instead of winning or losing", () => {
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("model-z", "model-a"),
        signals: {
            // Only one side is priced, so cost cannot decide at all.
            expectedTotalCostUsdByModelId: { "model-z": 0.000_1 },
            recentSuccessRateByModelId: { "model-z": 0.2, "model-a": 0.99 },
        },
    });
    assert.equal(result.selectedModelId, "model-a");
    assert.equal(result.decidedBy, "recent_success_rate");
});

test("differences inside the policy's thresholds are not differences", () => {
    const eligible = candidates("model-a", "model-b");
    const nearlyEqualCost = 1;
    const result = selectRouterModel({
        profile: plainTurn,
        eligible,
        signals: {
            expectedTotalCostUsdByModelId: {
                // Inside the cost epsilon, so cost abstains ...
                "model-a": nearlyEqualCost,
                "model-b":
                    nearlyEqualCost * (1 + ROUTER_COST_TIE_EPSILON_RATIO / 2),
            },
            recentSuccessRateByModelId: {
                // ... and so does the success rate ...
                "model-a": 0.9,
                "model-b": 0.9 + ROUTER_SUCCESS_RATE_TIE_EPSILON / 2,
            },
            ttftP95MsByModelId: {
                // ... and the latency, leaving the stable identifier.
                "model-a": 1_000,
                "model-b": 1_000 - ROUTER_TTFT_TIE_EPSILON_MS / 2,
            },
        },
    });
    assert.equal(result.decidedBy, "model_id");
    assert.equal(result.selectedModelId, "model-a");
});

test("the answer does not depend on the order the filters emitted", () => {
    const signals = {
        expectedTotalCostUsdByModelId: { "model-a": 0.5, "model-b": 0.5 },
    };
    const eligible = candidates("qwen3.6-flash", "mistral-small-4");
    const result = selectRouterModel({ profile: plainTurn, eligible, signals });
    assert.equal(
        selectRouterModel({
            profile: plainTurn,
            eligible: [...eligible].reverse(),
            signals,
        }).selectedModelId,
        result.selectedModelId
    );
});

// The previous fallback was position in the model finder's six-model order, so
// every model outside it sorted last and identically. Enrolment plus a stable
// identifier is what replaced that.
test("a model outside the six the finder lists is ranked, not parked", () => {
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("kimi-k3", "perplexity/sonar-pro"),
        signals: {
            expectedTotalCostUsdByModelId: {
                "kimi-k3": 5,
                "perplexity/sonar-pro": 0.5,
            },
        },
    });
    assert.equal(result.selectedModelId, "perplexity/sonar-pro");
    assert.equal(result.decidedBy, "expected_total_cost");
});

// Stickiness is measured in bands, because a switch is a claim that the other
// model is better -- not that it is cheaper, which is a reason to have started
// somewhere else rather than to change mid-conversation. With every band
// neutral no challenger can clear the margin, so Auto holds its model. That is
// the correct behaviour for a scale with no measurements in it, and it is the
// first thing an approved evidence record will change.
test("a cheaper challenger does not move the conversation", () => {
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
        sticky: { modelId: "qwen3.6-flash", turnsFavouringChallenger: 0 },
        signals: {
            expectedTotalCostUsdByModelId: {
                "deepseek-v4-flash": 0.01,
                "qwen3.6-flash": 5,
            },
        },
    });
    assert.equal(result.selectedModelId, "qwen3.6-flash");
    assert.equal(result.reason, "sticky");
    assert.equal(result.challengerModelId, "deepseek-v4-flash");
    assert.ok(result.margin < ROUTER_STICKY_SWITCH_MARGIN_BANDS);
    assert.equal(result.turnsFavouringChallenger, 0);
});

test("the streak does not advance while the margin is unmet", () => {
    let sticky = { modelId: "qwen3.6-flash", turnsFavouringChallenger: 0 };
    for (let turn = 0; turn < ROUTER_STICKY_HYSTERESIS_TURNS + 2; turn += 1) {
        const result = selectRouterModel({
            profile: codingTurn,
            eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
            sticky,
        });
        assert.equal(result.selectedModelId, "qwen3.6-flash");
        assert.equal(result.turnsFavouringChallenger, 0);
        sticky = {
            modelId: result.selectedModelId,
            turnsFavouringChallenger: result.turnsFavouringChallenger,
        };
    }
});

test("stickiness never keeps a model that failed a filter", () => {
    // It lost on a hard rule, and hard rules do not lose to continuity.
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash"),
        sticky: { modelId: "qwen3.6-flash", turnsFavouringChallenger: 5 },
    });
    assert.equal(result.selectedModelId, "deepseek-v4-flash");
    assert.notEqual(result.reason, "sticky");
});

test("the model already in use reports its own reason, not stickiness", () => {
    // "sticky" has to mean the rule changed the outcome. Reporting it when the
    // ranking agreed anyway would make the telemetry unable to say how often
    // continuity actually overrode a different winner.
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
        sticky: { modelId: "deepseek-v4-flash", turnsFavouringChallenger: 0 },
        signals: {
            expectedTotalCostUsdByModelId: {
                "deepseek-v4-flash": 0.01,
                "qwen3.6-flash": 5,
            },
        },
    });
    assert.equal(result.selectedModelId, "deepseek-v4-flash");
    assert.notEqual(result.reason, "sticky");
});

// A turn whose kind rests on nothing must not rank on that kind's column. The
// profiler only produces "none" together with "general" today, so this is an
// invariant rather than a visible change -- which is exactly why it is pinned.
test("an unsupported kind is routed on the general column", () => {
    const unsupported = buildTaskProfile({ text: "안녕" });
    assert.equal(unsupported.kindConfidence, "none");
    const result = selectRouterModel({
        profile: { ...unsupported, kind: "coding" },
        eligible: candidates("deepseek-v4-flash", "gpt-5-6-luna"),
    });
    const asGeneral = selectRouterModel({
        profile: { ...unsupported, kind: "general" },
        eligible: candidates("deepseek-v4-flash", "gpt-5-6-luna"),
    });
    assert.equal(result.selectedModelId, asGeneral.selectedModelId);
});

test("the result carries no request content", () => {
    const secret = "myuniquesecrettoken";
    const result = selectRouterModel({
        profile: buildTaskProfile({ text: `debug ${secret} please` }),
        eligible: candidates("deepseek-v4-flash", "gpt-5-6-luna"),
    });
    assert.ok(!JSON.stringify(result).includes(secret));
});

test("the same turn always selects the same way", () => {
    const input = {
        profile: codingTurn,
        eligible: candidates("gpt-5-6-luna", "deepseek-v4-flash"),
        sticky: { modelId: "gpt-5-6-luna", turnsFavouringChallenger: 0 },
    };
    assert.deepEqual(selectRouterModel(input), selectRouterModel(input));
});

// §6: an automatic fallback's candidate must pass the same compatibility
// filters as the primary. The ranking is the only place a set that has is also
// in a defensible order, so it has to leave this module rather than be
// recomputed downstream by a second filter free to disagree.

test("the ranking names every eligible model, best first", () => {
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("deepseek-v4-flash", "gpt-5-6-luna"),
    });
    assert.equal(result.rankedModelIds.length, 2);
    assert.equal(result.rankedModelIds[0], result.selectedModelId);
    assert.equal(new Set(result.rankedModelIds).size, 2);
});

test("nothing eligible ranks nothing", () => {
    const result = selectRouterModel({ profile: plainTurn, eligible: [] });
    assert.deepEqual(result.rankedModelIds, []);
});

test("the ranking still holds the sticky winner, so the caller must remove it", () => {
    // Stickiness can select a model the ranking did not put first. The list is
    // the *ranking*, not "the alternatives" -- removing the chosen model is the
    // caller's job precisely because which one was chosen is not always the top.
    const eligible = candidates("deepseek-v4-flash", "gpt-5-6-luna");
    const natural = selectRouterModel({ profile: plainTurn, eligible });
    const other = eligible.find(
        (candidate) => candidate.modelId !== natural.selectedModelId
    );
    const sticky = selectRouterModel({
        profile: plainTurn,
        eligible,
        sticky: { modelId: other.modelId, turnsFavouringChallenger: 0 },
    });
    assert.equal(sticky.selectedModelId, other.modelId);
    assert.ok(sticky.rankedModelIds.includes(other.modelId));
});
