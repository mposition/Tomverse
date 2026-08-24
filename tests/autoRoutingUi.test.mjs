import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AUTO_ROUTER_UI_FLAG,
  autoSelectionCapability,
  autoUiAvailability,
  isAutoRouterUiEnabled,
  mayStoreSelectionMode,
} from "../lib/autoRoutingUi.ts";
import {
  autoRoutingCopy,
  autoRoutingReason,
  autoRoutingReasonCopy,
} from "../lib/autoRoutingCopy.ts";
import { SELECTION_REASONS } from "../lib/routerSelection.ts";
import { SELECTION_MODES } from "../lib/conversationSelectionMode.ts";

// The UI is the last step of the rollout and the first thing a user reads as a
// promise. These tests are mostly about not making one the product cannot keep.

const ready = { ready: true, outstanding: [], problems: [] };
const openCohort = {
  killSwitch: false,
  rolloutPercent: 100,
  salt: "cohort-2026-08",
  eligiblePlans: ["Pro", "Max"],
};

const availability = (overrides = {}) =>
  autoUiAvailability({
    subjectKey: "user_abc",
    isGuest: false,
    plan: "Pro",
    flagEnabled: true,
    cohortConfig: openCohort,
    readiness: ready,
    ...overrides,
  });

test("the flag is off unless it is explicitly turned on", () => {
  assert.equal(isAutoRouterUiEnabled({}), false);
  assert.equal(isAutoRouterUiEnabled({ [AUTO_ROUTER_UI_FLAG]: "" }), false);
  assert.equal(isAutoRouterUiEnabled({ [AUTO_ROUTER_UI_FLAG]: "1" }), false);
  assert.equal(isAutoRouterUiEnabled({ [AUTO_ROUTER_UI_FLAG]: "yes" }), false);
  assert.equal(isAutoRouterUiEnabled({ [AUTO_ROUTER_UI_FLAG]: "true" }), true);
});

test("the option is offered only when it would actually route", () => {
  assert.equal(availability().offered, true);
  assert.equal(availability({ flagEnabled: false }).offered, false);
  assert.equal(availability({ plan: "Free" }).offered, false);
  assert.equal(availability({ isGuest: true }).offered, false);
  assert.equal(
    availability({ cohortConfig: { ...openCohort, killSwitch: true } }).offered,
    false
  );
  assert.equal(
    availability({ readiness: { ready: false, outstanding: ["shadow_report"], problems: [] } })
      .offered,
    false
  );
});

// A switch that flips, saves, renders as on and changes nothing is worse than
// an absent one: the user cannot tell "Auto chose this model" from "Auto is
// not running", and neither can support.
test("a flag with no cohort behind it does not offer the control", () => {
  const state = availability({
    cohortConfig: { ...openCohort, rolloutPercent: 0 },
  });
  assert.equal(state.offered, false);
  assert.equal(state.reason, "not_eligible");
});

// Nothing turns on the cohort when the flag is off, so hashing a subject to
// answer a question already answered is work the request does not need.
test("the cohort is not consulted while the flag is off", () => {
  const state = availability({ flagEnabled: false });
  assert.equal(state.reason, "ui_flag_off");
  assert.equal(state.cohort, null);
});

// A client that could read its bucket could work out the rollout percentage,
// and one that knew the salt could work out anyone's.
test("what crosses the wire is one boolean and no rollout state", () => {
  const refused = autoSelectionCapability(availability({ plan: "Free" }));
  assert.deepEqual(refused, { offered: false });

  const serialised = JSON.stringify(refused);
  assert.equal(serialised.includes("bucket"), false);
  assert.equal(serialised.includes("cohort"), false);
  assert.equal(serialised.includes("not_eligible"), false);
  assert.equal(serialised.includes("salt"), false);
});

// An account can leave the cohort while its conversations are still marked
// auto. Refusing manual would strand them in a mode they cannot act on, and
// manual is also what clears the sticky state the constraint expects gone.
test("returning to manual is always allowed, even with Auto unavailable", () => {
  const unavailable = availability({ flagEnabled: false });
  assert.equal(mayStoreSelectionMode("manual", unavailable), true);
  assert.equal(mayStoreSelectionMode("auto", unavailable), false);
  assert.equal(mayStoreSelectionMode("auto", availability()), true);
});

test("both stored modes are covered by the store rule", () => {
  for (const mode of SELECTION_MODES) {
    assert.equal(typeof mayStoreSelectionMode(mode, availability()), "boolean");
  }
});

// --- copy ---

const LANGUAGES = ["en", "ko", "zh", "fr", "de", "es", "pt"];

test("every supported language carries the whole control vocabulary", () => {
  for (const language of LANGUAGES) {
    const copy = autoRoutingCopy[language];
    assert.ok(copy, `${language} has no copy`);
    for (const key of [
      "label",
      "description",
      "activeSummary",
      "turnedOn",
      "turnedOff",
      "answeredBy",
    ]) {
      assert.equal(typeof copy[key], "string", `${language}.${key} missing`);
      assert.ok(copy[key].trim().length > 0, `${language}.${key} is empty`);
    }
  }
});

// The copy is a promise. Auto picks a model per turn; it does not promise the
// pick is good, and a user who reads it that way will read every answer they
// dislike as the router's fault.
test("no locale claims Auto picks a better model", () => {
  const forbidden = [
    "best",
    "optimal",
    "smartest",
    "most powerful",
    "최적",
    "가장 좋은",
    "최고",
    "最佳",
    "最好",
    "meilleur",
    "beste",
    "mejor",
    "melhor",
  ];
  for (const language of LANGUAGES) {
    const text = Object.values(autoRoutingCopy[language]).join(" ").toLowerCase();
    for (const word of forbidden) {
      assert.equal(
        text.includes(word.toLowerCase()),
        false,
        `${language} copy promises "${word}"`
      );
    }
  }
});

// A non-English locale left in English is the failure the repository already
// has a check for; this is the same rule applied to a record that check does
// not read.
test("no non-English locale is left showing the English sentence", () => {
  for (const language of LANGUAGES.filter((name) => name !== "en")) {
    for (const [key, value] of Object.entries(autoRoutingCopy[language])) {
      if (key === "label" && value === "Auto") continue; // a brand word, not a sentence
      assert.notEqual(
        value,
        autoRoutingCopy.en[key],
        `${language}.${key} is still the English string`
      );
    }
  }
});

// The identifiers belong to the router. A reason it can emit with no sentence
// here shows the user nothing at all, which is a silent gap.
test("every reason the router can emit on a routed turn has a sentence", () => {
  // `no_candidate` is a refusal: it never reaches a routed message, so it
  // deliberately has no user-facing copy.
  const routable = SELECTION_REASONS.filter((reason) => reason !== "no_candidate");
  assert.ok(routable.length > 0);

  for (const language of LANGUAGES) {
    for (const reason of routable) {
      assert.equal(
        typeof autoRoutingReasonCopy[language][reason],
        "string",
        `${language} has no sentence for ${reason}`
      );
    }
  }
});

test("no sentence is offered for a refusal that never reaches a message", () => {
  for (const language of LANGUAGES) {
    assert.equal(autoRoutingReasonCopy[language].no_candidate, undefined);
  }
});

// `fallback_order` in somebody's chat is a leak of internal vocabulary, not a
// translation.
test("an unknown identifier shows nothing rather than its raw form", () => {
  assert.equal(autoRoutingReason("en", "some_new_reason"), null);
  assert.equal(autoRoutingReason("ko", null), null);
  assert.equal(autoRoutingReason("ko", undefined), null);
  assert.equal(autoRoutingReason("ko", "sticky"), "이전 메시지에서 이어짐");
});

// --- the components' one hard rule ---

test("neither component renders anything without a routing decision behind it", () => {
  const toggle = readFileSync("components/chat/AutoRoutingToggle.tsx", "utf8");
  const badge = readFileSync("components/chat/AutoRoutedByBadge.tsx", "utf8");

  // A greyed-out Auto row would raise the one question the rollout cannot
  // answer, and its answer is internal rollout state.
  assert.match(toggle, /if \(!offered\) return null;/);
  // A badge on a fallback would claim a routing decision that did not happen.
  assert.match(badge, /if \(!routed \|\| !modelName\) return null;/);
});

// --- and neither does the place they are mounted ---

test("the picker's Auto wrapper is inside the condition, not around it", () => {
  // The component returning null is not enough once it is mounted: a wrapper
  // rendered anyway leaves an empty div carrying `mb-2` -- a margin and a row
  // height for a control that does not exist. "Renders nothing" has to mean
  // nothing.
  const picker = readFileSync("components/chat/ModelPickerPanel.tsx", "utf8");

  assert.match(picker, /\{autoSelectionOffered && onSelectionModeChange && \(/);
  // Above the list, never in it: Auto has no context window, price or
  // provider, and the footer's credit estimate would have nothing to show.
  const togglePosition = picker.indexOf("<AutoRoutingToggle");
  const selectedChipsPosition = picker.indexOf("model-picker-selected-list");
  assert.ok(togglePosition > 0, "the toggle is mounted");
  assert.ok(
    togglePosition < selectedChipsPosition,
    "the toggle sits above the selected models, not inside the catalogue"
  );
});

test("the badge is mounted only behind the server's own routed marker", () => {
  // `routedModelId` is set from a response header the server writes when the
  // Router chose the model and omits when it did not, so the client has no
  // way to render a badge for a turn nobody routed.
  const list = readFileSync("components/chat/ChatMessageList.tsx", "utf8");

  assert.match(list, /\{!isUser && msg\.routedModelId && \(/);
  assert.match(list, /<AutoRoutedByBadge/);
});

test("the routed marker is never derived on the client", () => {
  // The client reads the header and stores it. If it ever computed `routed`
  // from the model that answered differing from the one requested, a manual
  // model swap would grow a badge claiming Auto chose it.
  const app = readFileSync("components/chat/ChatApp.tsx", "utf8");

  assert.match(app, /res\.headers\.get\("X-Chat-Routed-Model"\)/);
  assert.match(app, /res\.headers\.get\("X-Chat-Routed-Reason"\)/);
  // A turn that fell back to another model produced the text, so the routed
  // badge must not survive it.
  assert.match(app, /routedModelId && !retryingWithModelId/);
});
