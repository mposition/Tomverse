import assert from "node:assert/strict";
import test from "node:test";

import {
    ROUTER_SELECTION_VERSION,
    ROUTER_STICKY_HYSTERESIS_TURNS,
    ROUTER_STICKY_SWITCH_MARGIN,
    SELECTION_REASONS,
    selectRouterModel,
} from "../lib/routerSelection.ts";
import { buildTaskProfile } from "../lib/taskProfileCore.ts";

/**
 * Router Pass 1's choice, in shadow mode.
 *
 * The interesting tests are about *not* changing model. A router that picks a
 * slightly different winner every turn is worse than one that picks a mediocre
 * model and stays: the user sees the answer's character change between two
 * questions that felt identical to them, and nothing on screen explains it.
 */

const candidates = (...modelIds) =>
    modelIds.map((modelId) => ({ modelId, outputTokens: 4_000 }));

// `TASK_SCORES.coding` prefers deepseek-v4-flash (12), then gpt-5-6-luna (3),
// then qwen3.6-flash (2). Used rather than restated so the tests move with the
// curated table instead of pinning a copy of it.
const codingTurn = buildTaskProfile({ text: "이 정규식 디버그해 줘" });
const plainTurn = buildTaskProfile({ text: "안녕" });

test("no eligible candidate selects nothing and says so", () => {
    // The caller must not invent a model here. An empty candidate set is the
    // filters having refused everything, and substituting one would undo them.
    const result = selectRouterModel({ profile: codingTurn, eligible: [] });
    assert.equal(result.selectedModelId, null);
    assert.equal(result.reason, "no_candidate");
    assert.equal(result.version, ROUTER_SELECTION_VERSION);
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
});

test("the curated preference decides a coding turn", () => {
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("gpt-5-6-luna", "deepseek-v4-flash"),
    });
    assert.equal(result.selectedModelId, "deepseek-v4-flash");
    assert.equal(result.reason, "task_preference");
    assert.ok(result.margin > 0);
});

test("a model the preference does not name still loses to one it does", () => {
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("mistral-small-4", "deepseek-v4-flash"),
    });
    assert.equal(result.selectedModelId, "deepseek-v4-flash");
});

test("with no preference to apply, catalogue order decides deterministically", () => {
    const eligible = candidates("qwen3.6-flash", "mistral-small-4");
    const result = selectRouterModel({ profile: plainTurn, eligible });
    // Both score zero for a general turn, so the answer must still be stable
    // rather than dependent on the order the filters happened to emit.
    assert.equal(result.reason, "fallback_order");
    assert.equal(result.margin, 0);
    assert.equal(
        selectRouterModel({
            profile: plainTurn,
            eligible: [...eligible].reverse(),
        }).selectedModelId,
        result.selectedModelId
    );
});

test("a model outside the curated order is still ordered, not dropped", () => {
    // The catalogue can carry a model the table has not caught up with. It
    // sorts last, but it is selectable when it is the only thing eligible.
    const result = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("some-new-model"),
    });
    assert.equal(result.selectedModelId, "some-new-model");

    const contested = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("some-new-model", "gpt-5-6-luna"),
    });
    assert.equal(contested.selectedModelId, "gpt-5-6-luna");
});

test("a marginally better challenger does not move the conversation", () => {
    // gpt-5-6-luna (3) against qwen3.6-flash (2) on a coding turn is a
    // difference of one, below the switch margin.
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("gpt-5-6-luna", "qwen3.6-flash"),
        sticky: { modelId: "qwen3.6-flash", turnsFavouringChallenger: 0 },
    });
    assert.equal(result.selectedModelId, "qwen3.6-flash");
    assert.equal(result.reason, "sticky");
    assert.equal(result.challengerModelId, "gpt-5-6-luna");
    assert.equal(result.turnsFavouringChallenger, 0);
});

test("a clearly better challenger still needs consecutive turns", () => {
    // deepseek-v4-flash (12) against qwen3.6-flash (2) clears the margin, so
    // the streak advances -- but one turn is not a trend.
    const first = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
        sticky: { modelId: "qwen3.6-flash", turnsFavouringChallenger: 0 },
    });
    assert.equal(first.selectedModelId, "qwen3.6-flash");
    assert.equal(first.reason, "sticky");
    assert.equal(first.turnsFavouringChallenger, 1);

    const second = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
        sticky: {
            modelId: "qwen3.6-flash",
            turnsFavouringChallenger: first.turnsFavouringChallenger,
        },
    });
    assert.equal(second.selectedModelId, "deepseek-v4-flash");
    // The switch happened, so the streak starts again for the next comparison.
    assert.equal(second.turnsFavouringChallenger, 0);
});

test("the streak resets rather than accumulating across unrelated turns", () => {
    // A coding question, then a plain one, then coding again must not switch:
    // consecutive is the point, and an accumulating counter would make a
    // conversation that occasionally mentions code drift to a code model.
    const afterCoding = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
        sticky: { modelId: "qwen3.6-flash", turnsFavouringChallenger: 0 },
    });
    assert.equal(afterCoding.turnsFavouringChallenger, 1);

    const afterPlain = selectRouterModel({
        profile: plainTurn,
        eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
        sticky: {
            modelId: "qwen3.6-flash",
            turnsFavouringChallenger: afterCoding.turnsFavouringChallenger,
        },
    });
    assert.equal(afterPlain.selectedModelId, "qwen3.6-flash");
    assert.equal(afterPlain.turnsFavouringChallenger, 0);
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
    // preference agreed anyway would make the telemetry unable to say how
    // often continuity actually overrode a different winner.
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates("deepseek-v4-flash", "qwen3.6-flash"),
        sticky: { modelId: "deepseek-v4-flash", turnsFavouringChallenger: 0 },
    });
    assert.equal(result.selectedModelId, "deepseek-v4-flash");
    assert.equal(result.reason, "task_preference");
});

test("the challenger is measured against the model in use, not the runner-up", () => {
    // Three candidates where the model in use is last. Comparing the winner
    // with the runner-up would report a small margin and never switch, however
    // far behind the conversation's model had fallen.
    const result = selectRouterModel({
        profile: codingTurn,
        eligible: candidates(
            "deepseek-v4-flash",
            "gpt-5-6-luna",
            "qwen3.6-flash"
        ),
        sticky: {
            modelId: "qwen3.6-flash",
            turnsFavouringChallenger: ROUTER_STICKY_HYSTERESIS_TURNS - 1,
        },
    });
    assert.equal(result.selectedModelId, "deepseek-v4-flash");
    assert.ok(result.margin >= ROUTER_STICKY_SWITCH_MARGIN);
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
    profile: { kind: "general", confidence: 1 },
    eligible: [
      { modelId: "deepseek-v4-flash", outputTokens: 1000 },
      { modelId: "gpt-5-6-luna", outputTokens: 1000 },
    ],
  });
  assert.equal(result.rankedModelIds.length, 2);
  assert.equal(result.rankedModelIds[0], result.selectedModelId);
  assert.deepEqual(new Set(result.rankedModelIds).size, 2);
});

test("nothing eligible ranks nothing", () => {
  const result = selectRouterModel({
    profile: { kind: "general", confidence: 1 },
    eligible: [],
  });
  assert.deepEqual(result.rankedModelIds, []);
});

test("the ranking still holds the sticky winner, so the caller must remove it", () => {
  // Stickiness can select a model the ranking did not put first. The list is
  // the *ranking*, not "the alternatives" -- removing the chosen model is the
  // caller's job precisely because which one was chosen is not always the top.
  const eligible = [
    { modelId: "deepseek-v4-flash", outputTokens: 1000 },
    { modelId: "gpt-5-6-luna", outputTokens: 1000 },
  ];
  const natural = selectRouterModel({
    profile: { kind: "general", confidence: 1 },
    eligible,
  });
  const other = eligible.find(
    (candidate) => candidate.modelId !== natural.selectedModelId
  );
  const sticky = selectRouterModel({
    profile: { kind: "general", confidence: 1 },
    eligible,
    sticky: { modelId: other.modelId, turnsFavouringChallenger: 0 },
  });
  assert.equal(sticky.selectedModelId, other.modelId);
  assert.ok(sticky.rankedModelIds.includes(other.modelId));
});
