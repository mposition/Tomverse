import assert from "node:assert/strict";
import test from "node:test";

import { AVAILABLE_MODELS } from "../lib/models.ts";
import { selectAutoModel, selectionDisclosure } from "../lib/autoModelSelection.ts";
import {
  DEFAULT_SELECTION_MODE,
  parseSelectionMode,
  selectionModeTransition,
  stickyStateAfterRoutedTurn,
  stickyStateFor,
  storedSelectionMode,
} from "../lib/conversationSelectionMode.ts";

// The seam decides which model answers. Most of what matters is what it does
// when it declines, because every decline has to land on the same behaviour --
// the user gets the model they would have got, and nothing records a routing
// result for a turn the Router did not decide.

const ready = { ready: true, outstanding: [], problems: [] };
const cohortConfig = {
  killSwitch: false,
  rolloutPercent: 100,
  salt: "cohort-2026-08",
  eligiblePlans: ["Pro", "Max"],
};

const autoConversation = (overrides = {}) => ({
  selectionMode: "auto",
  routerModelId: null,
  routerChallengerTurns: 0,
  ...overrides,
});

const input = (overrides = {}) => ({
  requestedModelId: "gpt-5-6-luna",
  conversation: autoConversation(),
  subjectKey: "user_abc",
  isGuest: false,
  plan: "Pro",
  text: "이 문장을 영어로 번역해 주세요.",
  attachments: [],
  webSearchRequested: false,
  models: AVAILABLE_MODELS,
  reservedInputTokens: 1_200,
  requestOutputCapTokens: 4_000,
  cohortConfig,
  readiness: ready,
  ...overrides,
});

test("an Auto conversation in an open cohort is routed by the Router", () => {
  const selection = selectAutoModel(input());
  assert.equal(selection.routed, true);
  assert.equal(typeof selection.modelId, "string");
  assert.equal(selection.cohort.eligible, true);
  assert.ok(selection.record.selectionReason);
  // The record carries fixed identifiers and counts, never the turn.
  assert.equal(JSON.stringify(selection.record).includes("번역"), false);
});

// Every decline lands on the same behaviour, so a fallback is never a failure.
test("every refusal falls back to the model the user would have had", () => {
  const cases = [
    ["no_conversation", input({ conversation: null })],
    ["conversation_is_manual", input({ conversation: autoConversation({ selectionMode: "manual" }) })],
    ["cohort_refused", input({ readiness: { ready: false, outstanding: ["shadow_report"], problems: [] } })],
    ["cohort_refused", input({ isGuest: true })],
    ["cohort_refused", input({ plan: "Free" })],
    ["cohort_refused", input({ cohortConfig: { ...cohortConfig, killSwitch: true } })],
  ];

  for (const [reason, candidate] of cases) {
    const selection = selectAutoModel(candidate);
    assert.equal(selection.routed, false, `${reason} routed anyway`);
    assert.equal(selection.reason, reason);
    assert.equal(selection.fallbackModelId, "gpt-5-6-luna");
    // Nothing on the refusal branch can be read as a routing result.
    assert.equal("modelId" in selection, false);
    assert.equal("sticky" in selection, false);
  }
});

// A manual conversation is not a cohort refusal: the account may be in the
// cohort right now, on a different conversation.
test("a manual conversation never consults the cohort", () => {
  const selection = selectAutoModel(
    input({ conversation: autoConversation({ selectionMode: "manual" }) })
  );
  assert.equal(selection.reason, "conversation_is_manual");
  assert.equal(selection.cohort, undefined);
});

test("an unknown stored mode reads as manual rather than as Auto", () => {
  const selection = selectAutoModel(
    input({ conversation: autoConversation({ selectionMode: "AUTO_v2" }) })
  );
  assert.equal(selection.routed, false);
  assert.equal(selection.reason, "conversation_is_manual");
});

// Nothing eligible is a refusal, not a licence to pick something.
test("no candidate falls back and explains itself rather than guessing", () => {
  const selection = selectAutoModel(
    input({
      // A budget of zero credits with per-model prices leaves nothing
      // affordable, which is the filter's own refusal path.
      availableCredits: 0,
      creditsByModelId: Object.fromEntries(
        AVAILABLE_MODELS.map((model) => [model.id, 5])
      ),
    })
  );
  assert.equal(selection.routed, false);
  assert.equal(selection.reason, "no_candidate");
  assert.equal(selection.fallbackModelId, "gpt-5-6-luna");
  assert.ok(selection.record, "a no_candidate refusal carries the record that explains it");
  assert.ok(selection.record.rejections.length > 0);
});

test("sticky state from the conversation reaches the Router", () => {
  const withHistory = selectAutoModel(
    input({
      conversation: autoConversation({
        routerModelId: "deepseek-v4-flash",
        routerChallengerTurns: 1,
      }),
    })
  );
  assert.equal(withHistory.routed, true);
  // Whatever it decides, the streak it reports is the one to store next.
  assert.equal(typeof withHistory.sticky.turnsFavouringChallenger, "number");
  assert.ok(withHistory.sticky.turnsFavouringChallenger >= 0);
});

// --- disclosure ---

test("a routed turn discloses the model and the Router's own reason", () => {
  const disclosure = selectionDisclosure(selectAutoModel(input()), "auto");
  assert.equal(disclosure.routed, true);
  assert.equal(disclosure.selectionMode, "auto");
  assert.ok(disclosure.reason);
});

test("a manual turn discloses no routing reason at all", () => {
  const selection = selectAutoModel(
    input({ conversation: autoConversation({ selectionMode: "manual" }) })
  );
  const disclosure = selectionDisclosure(selection, "manual");
  assert.equal(disclosure.routed, false);
  assert.equal(disclosure.reason, null, "a manual turn would enter the Auto metrics");
  assert.equal(disclosure.modelId, "gpt-5-6-luna");
});

test("an Auto turn that fell back says which refusal it was", () => {
  const selection = selectAutoModel(input({ plan: "Free" }));
  const disclosure = selectionDisclosure(selection, "auto");
  assert.equal(disclosure.routed, false);
  assert.equal(disclosure.reason, "cohort_refused");
});

// --- mode and sticky lifecycle ---

test("an unrecognised requested mode is refused rather than defaulted", () => {
  assert.equal(parseSelectionMode("auto"), "auto");
  assert.equal(parseSelectionMode("manual"), "manual");
  assert.equal(parseSelectionMode("Auto"), null);
  assert.equal(parseSelectionMode(""), null);
  assert.equal(parseSelectionMode(undefined), null);
  // A stored value is different: a row is data, and unknown data reads safe.
  assert.equal(storedSelectionMode("nonsense"), "manual");
  assert.equal(storedSelectionMode(undefined), DEFAULT_SELECTION_MODE);
});

// The reason the transition exists. A streak accumulated under Auto would
// otherwise decide the first switch after Auto is turned back on, using turns
// the user routed by hand.
test("switching to manual discards the model and the challenger streak", () => {
  const transition = selectionModeTransition(
    { selectionMode: "auto", routerModelId: "deepseek-v4-flash", routerChallengerTurns: 2 },
    "manual"
  );
  assert.deepEqual(transition.patch, {
    selectionMode: "manual",
    routerModelId: null,
    routerChallengerTurns: 0,
  });
  assert.equal(transition.clearedStickyState, true);
});

test("switching to Auto starts from scratch rather than from leftovers", () => {
  const transition = selectionModeTransition(
    { selectionMode: "manual", routerModelId: null, routerChallengerTurns: 0 },
    "auto"
  );
  assert.equal(transition.patch.selectionMode, "auto");
  assert.equal(transition.patch.routerModelId, null);
  assert.equal(transition.patch.routerChallengerTurns, 0);
});

test("restating the current mode writes nothing", () => {
  for (const mode of ["manual", "auto"]) {
    const transition = selectionModeTransition(
      { selectionMode: mode, routerModelId: null, routerChallengerTurns: 0 },
      mode
    );
    assert.deepEqual(transition.patch, {}, `${mode} produced a needless write`);
  }
});

// Leftover columns on a manual row must not make the first Auto turn behave
// as a continuation of a conversation Auto never took part in.
test("sticky state is read only from an Auto conversation", () => {
  assert.equal(
    stickyStateFor({
      selectionMode: "manual",
      routerModelId: "deepseek-v4-flash",
      routerChallengerTurns: 3,
    }),
    null
  );
  assert.deepEqual(
    stickyStateFor({
      selectionMode: "auto",
      routerModelId: "deepseek-v4-flash",
      routerChallengerTurns: 3,
    }),
    { modelId: "deepseek-v4-flash", turnsFavouringChallenger: 3 }
  );
  assert.equal(stickyStateFor(null), null);
  assert.equal(
    stickyStateFor({ selectionMode: "auto", routerModelId: null, routerChallengerTurns: 0 }),
    null
  );
});

test("a negative stored streak is read as zero, not as a negative streak", () => {
  assert.equal(
    stickyStateFor({
      selectionMode: "auto",
      routerModelId: "m",
      routerChallengerTurns: -4,
    }).turnsFavouringChallenger,
    0
  );
  assert.equal(stickyStateAfterRoutedTurn("m", -1).routerChallengerTurns, 0);
});
