import assert from "node:assert/strict";
import test from "node:test";
import {
  deriveComparisonReadiness,
  isComparisonRailSteadyState,
  shouldShowVisualStatus,
} from "../lib/comparisonReadiness.ts";

const MODELS = ["a", "b", "c"];

const readiness = (modelStatuses, overrides = {}) =>
  deriveComparisonReadiness({
    selectedModelIds: MODELS,
    disabledModelIds: [],
    modelStatuses,
    hasComparableConversation: true,
    ...overrides,
  });

test("an empty or single-model conversation never shows the rail", () => {
  assert.equal(
    deriveComparisonReadiness({
      selectedModelIds: MODELS,
      disabledModelIds: [],
      modelStatuses: { a: "idle", b: "idle", c: "idle" },
      hasComparableConversation: false,
    }).isVisible,
    false
  );
  assert.equal(
    deriveComparisonReadiness({
      selectedModelIds: ["a"],
      disabledModelIds: [],
      modelStatuses: { a: "idle" },
      hasComparableConversation: true,
    }).isVisible,
    false
  );
});

test("0 of 3 with nothing in flight hides the rail rather than disabling it", () => {
  const state = readiness({});
  assert.equal(state.isVisible, false);
  assert.equal(state.state, "hidden");
  assert.equal(state.canRun, false);
});

test("every answer failed leaves nothing to compare, so the rail stays hidden", () => {
  const state = readiness({ a: "error", b: "error", c: "cancelled" });
  assert.equal(state.isVisible, false);
  assert.equal(state.excludedCount, 3);
});

test("0 of 3 while generating shows a progress state with both actions blocked", () => {
  const state = readiness({ a: "responding", b: "loading", c: "loading" });
  assert.equal(state.isVisible, true);
  assert.equal(state.state, "generating");
  assert.equal(state.readyCount, 0);
  assert.equal(state.generatingCount, 3);
  assert.equal(state.canRun, false);
  assert.equal(state.blockedReason, "generating");
});

test("1 of 3 complete keeps both actions blocked and asks for one more answer", () => {
  const state = readiness({ a: "idle", b: "error", c: "cancelled" });
  assert.equal(state.isVisible, true);
  assert.equal(state.state, "needsMore");
  assert.equal(state.readyCount, 1);
  assert.equal(state.canRun, false);
  assert.equal(state.blockedReason, "needsMore");
});

test("2 complete while a third streams stays runnable and reports both counts", () => {
  const state = readiness({ a: "idle", b: "idle", c: "responding" });
  assert.equal(state.state, "ready");
  assert.equal(state.readyCount, 2);
  assert.equal(state.generatingCount, 1);
  assert.equal(state.canRun, true);
});

test("2 completed plus 1 failed is runnable and reports the exclusion", () => {
  const state = readiness({ a: "idle", b: "idle", c: "error" });
  assert.equal(state.state, "ready");
  assert.equal(state.readyCount, 2);
  assert.equal(state.excludedCount, 1);
  assert.equal(state.canRun, true);
  assert.equal(state.blockedReason, null);
});

test("3 of 3 complete is runnable with nothing excluded", () => {
  const state = readiness({ a: "idle", b: "idle", c: "idle" });
  assert.equal(state.state, "ready");
  assert.equal(state.readyCount, 3);
  assert.equal(state.excludedCount, 0);
  assert.equal(state.canRun, true);
});

test("paused panels leave the comparable population, not just the count", () => {
  const state = deriveComparisonReadiness({
    selectedModelIds: MODELS,
    disabledModelIds: ["c"],
    modelStatuses: { a: "idle", b: "idle", c: "paused" },
    hasComparableConversation: true,
  });
  assert.equal(state.comparableCount, 2);
  assert.equal(state.readyCount, 2);
  assert.equal(state.excludedCount, 0);
  assert.equal(state.canRun, true);
});

test("an in-flight comparison blocks a duplicate run", () => {
  const state = readiness({ a: "idle", b: "idle", c: "idle" }, { isBusy: true });
  assert.equal(state.state, "ready");
  assert.equal(state.canRun, false);
  assert.equal(state.blockedReason, "busy");
});

test("insufficient credits is its own blocked reason, not a readiness problem", () => {
  const state = readiness(
    { a: "idle", b: "idle", c: "idle" },
    { hasInsufficientCredits: true }
  );
  assert.equal(state.state, "ready");
  assert.equal(state.canRun, false);
  assert.equal(state.blockedReason, "insufficientCredits");
});

// ---------------------------------------------------------------------------
// The steady state: the one state where the rail's status sentence has nothing
// left to tell a sighted user, so mobile hides it visually (never removes it).
// Every other state has something the user has to act on and keeps it on
// screen, which is what these cases pin down.
// ---------------------------------------------------------------------------

test("three completed answers with nothing else going on is the steady state", () => {
  const state = readiness({ a: "idle", b: "idle", c: "idle" });
  assert.equal(isComparisonRailSteadyState({ readiness: state }), true);
  assert.equal(state.selectedCount, 3);
  assert.equal(state.comparableCount, 3);
  assert.equal(state.pausedCount, 0);
});

test("a still-generating answer is not the steady state", () => {
  const state = readiness({ a: "idle", b: "idle", c: "responding" });
  assert.equal(state.state, "ready");
  assert.equal(isComparisonRailSteadyState({ readiness: state }), false);
});

test("an excluded failure is not the steady state", () => {
  const state = readiness({ a: "idle", b: "idle", c: "error" });
  assert.equal(state.state, "ready");
  assert.equal(state.excludedCount, 1);
  assert.equal(isComparisonRailSteadyState({ readiness: state }), false);
});

test("a paused panel is not the steady state, even with two clean answers", () => {
  // Two completed answers, so the actions run -- but the comparison covers
  // fewer models than the user selected, which is worth saying out loud.
  const state = readiness(
    { a: "idle", b: "idle", c: "paused" },
    { disabledModelIds: ["c"] }
  );
  assert.equal(state.state, "ready");
  assert.equal(state.canRun, true);
  assert.equal(state.selectedCount, 3);
  assert.equal(state.comparableCount, 2);
  assert.equal(state.pausedCount, 1);
  assert.equal(isComparisonRailSteadyState({ readiness: state }), false);
});

test("needsMore and generating are never the steady state", () => {
  assert.equal(
    isComparisonRailSteadyState({
      readiness: readiness({ a: "idle", b: "error", c: "error" }),
    }),
    false
  );
  assert.equal(
    isComparisonRailSteadyState({
      readiness: readiness({ a: "responding", b: "loading", c: "loading" }),
    }),
    false
  );
});

test("a running analysis or an unaffordable action leaves the steady state", () => {
  const state = readiness({ a: "idle", b: "idle", c: "idle" });
  assert.equal(isComparisonRailSteadyState({ readiness: state, isBusy: true }), false);
  assert.equal(
    isComparisonRailSteadyState({ readiness: state, isAnyActionUnaffordable: true }),
    false
  );
});

// ---------------------------------------------------------------------------
// shouldShowVisualStatus: the one policy both shells ask. The state matrix
// lives here rather than in a browser, so a regression is a unit-test failure
// rather than a screenshot argument. See
// docs/ui-contracts/comparison-action-rail.md.
// ---------------------------------------------------------------------------

test("the status row is hidden only in the steady state, whatever the shell", () => {
  const steady = readiness({ a: "idle", b: "idle", c: "idle" });
  assert.equal(shouldShowVisualStatus({ readiness: steady }), false);

  // Every exception earns the row back.
  const cases = [
    ["generating", readiness({ a: "idle", b: "idle", c: "responding" })],
    ["needsMore", readiness({ a: "idle", b: "error", c: "error" })],
    ["excluded", readiness({ a: "idle", b: "idle", c: "error" })],
    [
      "paused",
      readiness({ a: "idle", b: "idle", c: "paused" }, { disabledModelIds: ["c"] }),
    ],
  ];
  for (const [label, state] of cases) {
    assert.equal(shouldShowVisualStatus({ readiness: state }), true, label);
  }

  assert.equal(shouldShowVisualStatus({ readiness: steady, isBusy: true }), true);
  assert.equal(
    shouldShowVisualStatus({ readiness: steady, isAnyActionUnaffordable: true }),
    true
  );
});

test("a collapsed rail hides the row even when there is an exception to show", () => {
  // The disclosure button that replaces the rail carries the same sentence
  // through its own description; the row itself has nowhere to paint.
  const excluded = readiness({ a: "idle", b: "idle", c: "error" });
  assert.equal(shouldShowVisualStatus({ readiness: excluded }), true);
  assert.equal(
    shouldShowVisualStatus({ readiness: excluded, isCollapsed: true }),
    false
  );
});

test("the policy is a pure function of state, not of the shell", () => {
  // There is no shell argument to pass -- which is the point: desktop and
  // mobile cannot answer this question differently.
  const steady = readiness({ a: "idle", b: "idle", c: "idle" });
  assert.deepEqual(Object.keys({ readiness: steady }), ["readiness"]);
  assert.equal(shouldShowVisualStatus({ readiness: steady }), false);
  assert.equal(
    shouldShowVisualStatus({ readiness: steady }),
    !isComparisonRailSteadyState({ readiness: steady })
  );
});
