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

// A degraded model is still a candidate -- refusal is a hard filter and this
// is not one -- but it loses to a model nothing is reporting problems with,
// and it loses before price is asked about.

test("a degraded model loses to a healthy one, even when it is cheaper", () => {
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("model-a", "model-b"),
        signals: {
            degradedModelIds: ["model-a"],
            expectedTotalCostUsdByModelId: { "model-a": 0.01, "model-b": 5 },
        },
    });
    assert.equal(result.selectedModelId, "model-b");
    assert.equal(result.decidedBy, "health_degraded");
});

test("degradation does not decide when both sides carry it", () => {
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("model-a", "model-b"),
        signals: {
            degradedModelIds: ["model-a", "model-b"],
            expectedTotalCostUsdByModelId: { "model-a": 5, "model-b": 0.5 },
        },
    });
    assert.equal(result.selectedModelId, "model-b");
    assert.equal(result.decidedBy, "expected_total_cost");
});

test("a model nothing has probed is not demoted for being unprobed", () => {
    // Absence from the set is "not known to be degraded", which covers a
    // healthy model and an unprobed one alike. Uncertainty demotes nobody --
    // the same rule that keeps unprobed models out of the hard filter.
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("model-a", "model-b"),
        signals: {
            degradedModelIds: [],
            expectedTotalCostUsdByModelId: { "model-a": 5, "model-b": 0.5 },
        },
    });
    assert.equal(result.decidedBy, "expected_total_cost");
    assert.equal(result.selectedModelId, "model-b");
});


/**
 * The cycle a pairwise comparator produced, and the order that replaced it.
 *
 * Criterion 3 is cost and criterion 6 is the model id. Give two candidates a
 * cost and the third none, and a pairwise comparator answers three questions
 * with two different criteria:
 *
 *   model-c vs model-a -> both priced  -> cost      -> model-c (cheaper)
 *   model-a vs model-b -> b unpriced   -> model id  -> model-a
 *   model-b vs model-c -> b unpriced   -> model id  -> model-b
 *
 * which is `model-c > model-a > model-b > model-c`. `Array.prototype.sort`
 * meets that with an implementation-defined order rather than an error, so the
 * winner depended on the order the filters happened to emit.
 *
 * The partition refinement answers it once: cost cannot speak for every member
 * of the group, so it abstains for the group rather than for two of its three
 * pairs, and the model id -- which is total -- decides.
 */
test("a criterion one candidate cannot answer no longer cycles", () => {
    const signals = {
        expectedTotalCostUsdByModelId: { "model-c": 0.1, "model-a": 0.5 },
    };
    const eligible = candidates("model-c", "model-a", "model-b");
    const result = selectRouterModel({ profile: plainTurn, eligible, signals });

    assert.equal(result.selectedModelId, "model-a");
    assert.equal(result.decidedBy, "model_id");
    assert.deepEqual(result.rankedModelIds, ["model-a", "model-b", "model-c"]);
});

/**
 * Permutation invariance, which is the observable half of transitivity.
 *
 * A comparator that is not a total preorder does not announce itself; it just
 * returns a different winner for a different input order. So the property is
 * checked over every permutation rather than over one reversal, and with
 * signals deliberately missing for some candidates -- a complete snapshot is
 * the case that was never in doubt.
 */
const permutations = (items) =>
    items.length <= 1
        ? [items]
        : items.flatMap((item, index) =>
              permutations([
                  ...items.slice(0, index),
                  ...items.slice(index + 1),
              ]).map((rest) => [item, ...rest])
          );

test("the ranking is the same for every order the filters could emit", () => {
    const cases = [
        {
            name: "one candidate unpriced",
            modelIds: ["model-a", "model-b", "model-c"],
            signals: {
                expectedTotalCostUsdByModelId: { "model-c": 0.1, "model-a": 0.5 },
            },
        },
        {
            name: "success rate known for some",
            modelIds: ["model-a", "model-b", "model-c", "model-d"],
            signals: {
                expectedTotalCostUsdByModelId: {
                    "model-a": 1,
                    "model-b": 1,
                    "model-c": 1,
                    "model-d": 1,
                },
                recentSuccessRateByModelId: { "model-a": 0.99, "model-c": 0.5 },
            },
        },
        {
            name: "latency and degradation together",
            modelIds: ["model-a", "model-b", "model-c", "model-d"],
            signals: {
                degradedModelIds: ["model-a"],
                expectedTotalCostUsdByModelId: {
                    "model-b": 2,
                    "model-c": 2.05,
                    "model-d": 4,
                },
                ttftP95MsByModelId: { "model-b": 900, "model-c": 100 },
            },
        },
    ];

    for (const { name, modelIds, signals } of cases) {
        const orders = permutations(modelIds).map(
            (order) =>
                selectRouterModel({
                    profile: plainTurn,
                    eligible: candidates(...order),
                    signals,
                }).rankedModelIds
        );
        for (const order of orders) {
            assert.deepEqual(order, orders[0], name);
        }
    }
});

/**
 * The epsilon chain, which is intransitive on its own.
 *
 * At a 5% ratio 100 ties 104 and 104 ties 108, while 100 beats 108 outright,
 * so "within epsilon is the same value" cannot be evaluated per pair. Each
 * bucket is anchored to its own first value instead: 104 is within 5% of 100
 * and joins it, 108 is not and starts the next bucket.
 */
test("an epsilon chain buckets deterministically rather than per pair", () => {
    const costs = { "model-b": 100, "model-c": 104, "model-a": 108 };
    assert.ok(Math.abs(104 - 100) / 104 <= ROUTER_COST_TIE_EPSILON_RATIO);
    assert.ok(Math.abs(108 - 104) / 108 <= ROUTER_COST_TIE_EPSILON_RATIO);
    assert.ok(Math.abs(108 - 100) / 108 > ROUTER_COST_TIE_EPSILON_RATIO);

    for (const order of permutations(["model-a", "model-b", "model-c"])) {
        const result = selectRouterModel({
            profile: plainTurn,
            eligible: candidates(...order),
            signals: { expectedTotalCostUsdByModelId: costs },
        });
        // model-b and model-c share the cheapest bucket and the model id
        // separates them; model-a is a bucket of its own and ranks last
        // despite tying its neighbour pairwise.
        assert.deepEqual(result.rankedModelIds, [
            "model-b",
            "model-c",
            "model-a",
        ]);
    }
});

test("the criterion named as deciding is one that actually separates", () => {
    const signals = {
        degradedModelIds: ["model-d"],
        expectedTotalCostUsdByModelId: {
            "model-a": 1,
            "model-b": 3,
            "model-c": 1,
            "model-d": 1,
        },
        recentSuccessRateByModelId: {
            "model-a": 0.99,
            "model-b": 0.99,
            "model-c": 0.5,
            "model-d": 0.99,
        },
    };
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("model-a", "model-b", "model-c", "model-d"),
        signals,
    });
    // model-d is degraded and loses at criterion 2; model-b is dearer and
    // loses at 3; model-a and model-c share a price, so the success rate they
    // both carry is what separates the top two.
    assert.equal(result.selectedModelId, "model-a");
    assert.equal(result.decidedBy, "recent_success_rate");
    assert.equal(result.rankedModelIds[3], "model-d");
});

/**
 * Values that are not numbers in the sense the bucketing needs.
 *
 * `partitionByMetric` groups by value, and a reading that is not equal to
 * itself lands in no bucket: the candidate would leave that criterion with a
 * shorter rank key than everybody else, and the final sort would fall back to
 * input order for it -- the failure the whole ranking exists to remove. So a
 * non-finite reading abstains the criterion, and `rankCandidates` checks that
 * a partition covered its group rather than trusting it to.
 */
test("a non-finite measurement abstains rather than losing its candidate", () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
        const signals = {
            expectedTotalCostUsdByModelId: {
                "model-a": 1,
                "model-b": bad,
                "model-c": 3,
            },
        };
        const orders = permutations(["model-a", "model-b", "model-c"]).map(
            (order) =>
                selectRouterModel({
                    profile: plainTurn,
                    eligible: candidates(...order),
                    signals,
                }).rankedModelIds
        );
        for (const order of orders) {
            assert.deepEqual(order, orders[0], String(bad));
        }
        // Cost could not speak for the whole group, so the model id did.
        assert.deepEqual(orders[0], ["model-a", "model-b", "model-c"], String(bad));
    }
});

test("negative zero and positive zero are one reading", () => {
    const orders = permutations(["model-a", "model-b"]).map(
        (order) =>
            selectRouterModel({
                profile: plainTurn,
                eligible: candidates(...order),
                signals: {
                    expectedTotalCostUsdByModelId: { "model-a": 0, "model-b": -0 },
                },
            }).rankedModelIds
    );
    for (const order of orders) assert.deepEqual(order, orders[0]);
    assert.deepEqual(orders[0], ["model-a", "model-b"]);
});

test("a duplicated model id leaves the ranking well defined", () => {
    // The candidate type does not forbid it even though the catalogue does.
    // Nothing separates the two, so they stay adjacent and the length is kept.
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("model-a", "model-a", "model-b"),
        signals: {},
    });
    assert.equal(result.rankedModelIds.length, 3);
    assert.deepEqual(result.rankedModelIds, ["model-a", "model-a", "model-b"]);
    assert.equal(result.decidedBy, "model_id");
});
