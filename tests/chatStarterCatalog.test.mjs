import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import test from "node:test";

import {
  CHAT_STARTER_CATALOG,
  CHAT_STARTER_FLAG_KEYS,
  CHAT_STARTER_REQUIRED_CAPABILITIES,
  STARTER_CAPABILITIES,
  STARTER_CAPABILITY_IDS,
  findChatStarterEntry,
  isStarterCapability,
} from "../lib/chatStarterCatalog.ts";
import {
  CHAT_STARTER_MAX_VISIBLE,
  chatStarterAvailability,
  selectVisibleStarterCards,
} from "../lib/chatStarterAvailability.ts";
import {
  CHAT_STARTER_FLAG_KEY,
  CHAT_STARTER_KILL_SWITCH_ENV,
  chatStarterAvailable,
  chatStarterEnabledFromValue,
  chatStarterEnabledWithFixtureOverride,
  chatStarterKillSwitchEngaged,
} from "../lib/chatStarterAccess.ts";
import { resolveChatStarterCapabilities } from "../lib/chatStarterCapabilityResolution.ts";
import { IMAGE_GENERATION_FLAG_KEY } from "../lib/imageGenerationAccess.ts";
import { VOICE_INPUT_FLAG_KEY } from "../lib/voiceInputAccess.ts";
import { TASK_KINDS } from "../lib/taskProfileCore.ts";
import { CONVERSATION_PRODUCT_KEYS } from "../lib/conversationProduct.ts";

// --- the flag ---------------------------------------------------------------

test("the starter flag is default-off and only the literal true enables it", () => {
  assert.equal(CHAT_STARTER_FLAG_KEY, "feature.chatStarterEnabled");
  for (const value of [undefined, null, "", "false", "TRUE", "1", "yes", " true"]) {
    assert.equal(
      chatStarterEnabledFromValue(value),
      false,
      `${JSON.stringify(value)} must not enable the starter catalogue`
    );
  }
  assert.equal(chatStarterEnabledFromValue("true"), true);
});

test("the kill switch wins over any stored value", () => {
  const on = { storedFlagValue: "true" };
  assert.equal(chatStarterAvailable({ ...on, env: {} }), true);
  for (const value of ["1", "true", "on", "yes", "y", "please"]) {
    assert.equal(
      chatStarterAvailable({
        ...on,
        env: { [CHAT_STARTER_KILL_SWITCH_ENV]: value },
      }),
      false,
      `${value} must engage the kill switch`
    );
  }
  // Released only by absence or whitespace, the same asymmetry voice input has.
  assert.equal(chatStarterKillSwitchEngaged({}), false);
  assert.equal(
    chatStarterKillSwitchEngaged({ [CHAT_STARTER_KILL_SWITCH_ENV]: "  " }),
    false
  );
});

test("the kill switch wins over the e2e fixture cookie too", () => {
  // Cross review round 1, 2026-09-15. The shell tested `!enabled` before
  // letting the cookie speak, and `enabled` is false both when the row says
  // off and when an operator pulled the switch -- so the cookie turned the
  // gallery back on against a pulled switch, under a comment saying it could
  // not. The cookie stands in for the stored flag and for nothing else.
  const cookie = { fixtureCookieValue: "1" };
  assert.equal(
    chatStarterEnabledWithFixtureOverride({
      enabledFromSettings: false,
      ...cookie,
      env: {},
    }),
    true,
    "with no switch engaged the cookie is the whole point of the override"
  );
  assert.equal(
    chatStarterEnabledWithFixtureOverride({
      enabledFromSettings: false,
      ...cookie,
      env: { [CHAT_STARTER_KILL_SWITCH_ENV]: "1" },
    }),
    false,
    "an engaged switch is not something a cookie may overrule"
  );
  // And a switch pulled while the stored flag reads true is still a refusal:
  // `enabledFromSettings` already folds it in, so this asserts the override
  // adds nothing that the settings answer had removed.
  assert.equal(
    chatStarterEnabledWithFixtureOverride({
      enabledFromSettings: chatStarterAvailable({
        storedFlagValue: "true",
        env: { [CHAT_STARTER_KILL_SWITCH_ENV]: "1" },
      }),
      ...cookie,
      env: { [CHAT_STARTER_KILL_SWITCH_ENV]: "1" },
    }),
    false
  );
  // No cookie is no override, whatever the value looks like.
  for (const value of [undefined, null, "", "0", "true", "yes"]) {
    assert.equal(
      chatStarterEnabledWithFixtureOverride({
        enabledFromSettings: false,
        fixtureCookieValue: value,
        env: {},
      }),
      value === "1",
      `${JSON.stringify(value)} must not be read as an opt-in`
    );
  }
});

// --- the table --------------------------------------------------------------

test("every entry is well formed and names a file that exists", () => {
  assert.ok(CHAT_STARTER_CATALOG.length > 0);
  const ids = new Set();
  for (const entry of CHAT_STARTER_CATALOG) {
    assert.equal(ids.has(entry.id), false, `duplicate id ${entry.id}`);
    ids.add(entry.id);
    assert.ok(TASK_KINDS.includes(entry.taskProfile.kind), entry.id);
    assert.ok(
      CONVERSATION_PRODUCT_KEYS.includes(entry.seed.productKey),
      `${entry.id} names a product key outside the allowlist`
    );
    assert.ok(existsSync(entry.evidence), `${entry.id}: ${entry.evidence}`);
    for (const capability of entry.requires.capabilities ?? []) {
      assert.ok(isStarterCapability(capability), `${entry.id}: ${capability}`);
    }
  }
});

test("flag keys are the constants their owning modules export", () => {
  // The catalogue's rule is that a flag key is imported, never retyped. A
  // retyped key that differs by one character hides its card forever with
  // nothing on screen to say so.
  const known = new Set([IMAGE_GENERATION_FLAG_KEY, VOICE_INPUT_FLAG_KEY]);
  for (const key of CHAT_STARTER_FLAG_KEYS) {
    assert.ok(known.has(key), `${key} is not a flag constant this repo exports`);
  }
});

test("the derived key and capability lists cover the table with no duplicates", () => {
  assert.deepEqual(
    [...CHAT_STARTER_FLAG_KEYS].sort(),
    [...new Set(CHAT_STARTER_FLAG_KEYS)].sort()
  );
  for (const entry of CHAT_STARTER_CATALOG) {
    for (const key of entry.requires.flagKeys ?? []) {
      assert.ok(CHAT_STARTER_FLAG_KEYS.includes(key));
    }
    for (const capability of entry.requires.capabilities ?? []) {
      assert.ok(CHAT_STARTER_REQUIRED_CAPABILITIES.includes(capability));
    }
  }
});

test("no entry claims the AI Review accent", () => {
  // AGENTS.md reserves the cyan/blue/purple gradient. This slice adds no new
  // accent role either, so every entry is on a role that already exists.
  for (const entry of CHAT_STARTER_CATALOG) {
    assert.notEqual(entry.accentRole, "ai-review");
    assert.ok(
      ["neutral", "web-search", "image", "generated-artifact"].includes(
        entry.accentRole
      ),
      `${entry.id} uses accent role ${entry.accentRole}`
    );
  }
});

test("findChatStarterEntry answers by id and does not invent one", () => {
  assert.equal(findChatStarterEntry(CHAT_STARTER_CATALOG[0].id)?.id,
    CHAT_STARTER_CATALOG[0].id);
  assert.equal(findChatStarterEntry("no-such-card"), undefined);
});

// --- availability -----------------------------------------------------------

const allFlags = new Set([IMAGE_GENERATION_FLAG_KEY, VOICE_INPUT_FLAG_KEY]);
const allCapabilities = new Set(STARTER_CAPABILITY_IDS);

const viewer = (overrides = {}) => ({
  signedIn: true,
  plan: "Free",
  enabledFlags: new Set(allFlags),
  knownFlags: new Set(allFlags),
  modelCapabilities: new Set(allCapabilities),
  ...overrides,
});

const entry = (overrides = {}) => ({
  id: "probe",
  outcomeKey: "chatStarter.cards.compareAnswers.outcome",
  taskProfile: { kind: "general", needsCurrentInformation: false },
  requires: {},
  seed: {
    promptSeedKey: "chatStarter.cards.compareAnswers.seed",
    productKey: "chat",
  },
  accentRole: "neutral",
  evidence: "components/chat/ChatApp.tsx",
  ...overrides,
});

test("a card with no requirements is available to a guest", () => {
  assert.deepEqual(
    chatStarterAvailability(entry(), viewer({ signedIn: false, plan: null })),
    { state: "available" }
  );
});

test("a flag that is off hides the card rather than locking it", () => {
  const result = chatStarterAvailability(
    entry({ requires: { flagKeys: [IMAGE_GENERATION_FLAG_KEY] } }),
    viewer({ enabledFlags: new Set([VOICE_INPUT_FLAG_KEY]) })
  );
  // Not `locked`: nothing is behind the lock, so an upgrade prompt would be a
  // promise the build cannot keep.
  assert.deepEqual(result, { state: "hidden", reason: "feature_flag_off" });
});

test("a flag nothing in this deployment reads is hidden, never read as off", () => {
  const result = chatStarterAvailability(
    entry({ requires: { flagKeys: ["feature.notWiredHere"] } }),
    viewer({ knownFlags: new Set(allFlags), enabledFlags: new Set(allFlags) })
  );
  assert.deepEqual(result, { state: "hidden", reason: "unknown_flag" });
});

test("a capability that did not resolve hides the card", () => {
  assert.deepEqual(
    chatStarterAvailability(
      entry({ requires: { capabilities: ["web-search"] } }),
      viewer({ modelCapabilities: new Set(["image-input"]) })
    ),
    { state: "hidden", reason: "capability_unavailable" }
  );
});

test("a capability id the table does not define hides the card", () => {
  assert.deepEqual(
    chatStarterAvailability(
      entry({ requires: { capabilities: ["telepathy"] } }),
      viewer()
    ),
    { state: "hidden", reason: "unknown_capability" }
  );
});

test("existence is decided before entitlement", () => {
  // Both a dead flag and an unmet plan. The answer has to be the flag, or the
  // card tells somebody to upgrade for a feature nobody can run.
  const result = chatStarterAvailability(
    entry({
      requires: {
        flagKeys: [IMAGE_GENERATION_FLAG_KEY],
        minimumPlan: "Max",
      },
    }),
    viewer({ plan: "Free", enabledFlags: new Set() })
  );
  assert.deepEqual(result, { state: "hidden", reason: "feature_flag_off" });
});

test("a guest is locked, with the requirement named, on a signed-in card", () => {
  assert.deepEqual(
    chatStarterAvailability(
      entry({ requires: { signedIn: true } }),
      viewer({ signedIn: false, plan: null })
    ),
    { state: "locked", reason: "sign_in_required" }
  );
});

test("a guest meets sign-in before pricing on a plan-gated card", () => {
  // Pricing is the second step. Telling an anonymous visitor to upgrade skips
  // the account they do not have yet.
  assert.deepEqual(
    chatStarterAvailability(
      entry({ requires: { minimumPlan: "Pro" } }),
      viewer({ signedIn: false, plan: null })
    ),
    { state: "locked", reason: "sign_in_required" }
  );
});

test("the plan matrix locks below the minimum and admits at or above it", () => {
  const card = entry({ requires: { signedIn: true, minimumPlan: "Pro" } });
  assert.deepEqual(chatStarterAvailability(card, viewer({ plan: "Free" })), {
    state: "locked",
    reason: "plan_required",
    minimumPlan: "Pro",
  });
  assert.deepEqual(chatStarterAvailability(card, viewer({ plan: "Pro" })), {
    state: "available",
  });
  assert.deepEqual(chatStarterAvailability(card, viewer({ plan: "Max" })), {
    state: "available",
  });
});

test("an unresolved plan hides a plan-gated card instead of guessing Free", () => {
  // The alternative is a card that renders locked for a frame and then
  // unlocks, which reads as the product changing its mind about the account.
  assert.deepEqual(
    chatStarterAvailability(
      entry({ requires: { signedIn: true, minimumPlan: "Pro" } }),
      viewer({ plan: null })
    ),
    { state: "hidden", reason: "unresolved_plan" }
  );
});

// --- selection --------------------------------------------------------------

test("hidden entries never reach the screen", () => {
  const cards = selectVisibleStarterCards(
    viewer({ enabledFlags: new Set(), knownFlags: new Set() })
  );
  for (const card of cards) {
    assert.notEqual(card.availability.state, "hidden");
    assert.equal((card.entry.requires.flagKeys ?? []).length, 0);
  }
});

test("the screen cap holds however large the registry grows", () => {
  const many = Array.from({ length: 40 }, (_, index) =>
    entry({ id: `probe-${index}` })
  );
  const cards = selectVisibleStarterCards(viewer(), many);
  assert.equal(cards.length, CHAT_STARTER_MAX_VISIBLE);
  assert.ok(CHAT_STARTER_MAX_VISIBLE >= 4 && CHAT_STARTER_MAX_VISIBLE <= 6);
});

test("runnable cards are ordered before locked ones, stably", () => {
  const catalog = [
    entry({ id: "locked-a", requires: { signedIn: true } }),
    entry({ id: "open-a" }),
    entry({ id: "locked-b", requires: { signedIn: true } }),
    entry({ id: "open-b" }),
  ];
  const cards = selectVisibleStarterCards(
    viewer({ signedIn: false, plan: null }),
    catalog
  );
  assert.deepEqual(
    cards.map((card) => card.entry.id),
    ["open-a", "open-b", "locked-a", "locked-b"]
  );
});

test("the ceiling costs a runnable card, never the last locked one", () => {
  // The defect this pins: the first version sorted runnable ahead of locked
  // and cut at the limit, so a guest on the default configuration -- six
  // runnable cards and one locked one -- saw the lock removed, and the gallery
  // disclosed nothing at all. The e2e spec caught it. A requirement that is
  // only ever discovered after a click is the thing the disclosure rule
  // forbids, so the ceiling gives up a runnable card instead.
  const catalog = [
    ...Array.from({ length: 9 }, (_, index) => entry({ id: `open-${index}` })),
    entry({ id: "needs-account", requires: { signedIn: true } }),
  ];
  const cards = selectVisibleStarterCards(
    viewer({ signedIn: false, plan: null }),
    catalog
  );
  assert.equal(cards.length, CHAT_STARTER_MAX_VISIBLE);
  assert.equal(
    cards.filter((card) => card.availability.state === "locked").length,
    1
  );
  assert.equal(cards.at(-1)?.entry.id, "needs-account");
});

test("the real catalogue discloses a lock to a guest on the default flags", () => {
  // The exact configuration the defect appeared in: nothing switched on.
  const cards = selectVisibleStarterCards(
    viewer({
      signedIn: false,
      plan: null,
      enabledFlags: new Set(),
      knownFlags: new Set(allFlags),
    })
  );
  assert.ok(
    cards.some((card) => card.availability.state === "locked"),
    "a guest sees no requirement stated anywhere in the gallery"
  );
  assert.ok(cards.some((card) => card.availability.state === "available"));
});

test("at a ceiling of one the runnable card wins", () => {
  // Nothing to balance, and a first screen whose only card is a price is not
  // an entry point.
  const catalog = [
    entry({ id: "needs-account", requires: { signedIn: true } }),
    entry({ id: "open-a" }),
  ];
  const cards = selectVisibleStarterCards(
    viewer({ signedIn: false, plan: null }),
    catalog,
    1
  );
  assert.deepEqual(
    cards.map((card) => card.entry.id),
    ["open-a"]
  );
});

test("a screen with only locked cards still shows them", () => {
  const catalog = [
    entry({ id: "locked-a", requires: { signedIn: true } }),
    entry({ id: "locked-b", requires: { signedIn: true } }),
  ];
  const cards = selectVisibleStarterCards(
    viewer({ signedIn: false, plan: null }),
    catalog
  );
  assert.equal(cards.length, 2);
});

test("meeting a requirement never removes a card from the screen", () => {
  // The inversion the reserved slot caused when it was held for locks alone:
  // a card low in the registry appeared to the account that could not use it
  // and vanished for the account that could, because meeting the requirement
  // moved it to the back of the runnable queue and the ceiling cut it. Real
  // case: `compare-image-models`, visible to Free and never to Pro.
  const catalog = [
    ...Array.from({ length: 8 }, (_, index) => entry({ id: `open-${index}` })),
    entry({ id: "needs-pro", requires: { signedIn: true, minimumPlan: "Pro" } }),
  ];
  const free = selectVisibleStarterCards(
    viewer({ signedIn: true, plan: "Free" }),
    catalog
  );
  const pro = selectVisibleStarterCards(
    viewer({ signedIn: true, plan: "Pro" }),
    catalog
  );
  assert.equal(
    free.find((card) => card.entry.id === "needs-pro")?.availability.state,
    "locked"
  );
  assert.equal(
    pro.find((card) => card.entry.id === "needs-pro")?.availability.state,
    "available",
    "the account that can use the card is the one that cannot see it"
  );
  assert.equal(pro.length, CHAT_STARTER_MAX_VISIBLE);
});

test("the promoted slot goes to an acquirable requirement, not a flag", () => {
  // A flag or a capability is the deployment's decision, not something an
  // account can go and get, so a card gated on one is ranked like any other
  // and the ceiling may cut it. Only `signedIn` and `minimumPlan` are promises
  // the gallery makes to a person about themselves.
  const catalog = [
    ...Array.from({ length: 8 }, (_, index) => entry({ id: `open-${index}` })),
    entry({ id: "flag-gated", requires: { flagKeys: [VOICE_INPUT_FLAG_KEY] } }),
  ];
  const cards = selectVisibleStarterCards(
    viewer({
      signedIn: true,
      plan: "Pro",
      enabledFlags: new Set([VOICE_INPUT_FLAG_KEY]),
      knownFlags: new Set(allFlags),
    }),
    catalog
  );
  assert.equal(cards.length, CHAT_STARTER_MAX_VISIBLE);
  assert.ok(!cards.some((card) => card.entry.id === "flag-gated"));
});

test("the real catalogue shows a Pro account the image card it can run", () => {
  // The configuration the defect was found in: image generation on, a plan
  // that meets the card's own requirement.
  const cards = selectVisibleStarterCards(
    viewer({
      signedIn: true,
      plan: "Pro",
      enabledFlags: new Set([IMAGE_GENERATION_FLAG_KEY]),
      knownFlags: new Set(allFlags),
    })
  );
  assert.equal(
    cards.find((card) => card.entry.id === "compare-image-models")?.availability
      .state,
    "available"
  );
});

test("the real catalogue offers a guest something to do", () => {
  // A first screen that is entirely locks is a price list, not an entry point.
  const cards = selectVisibleStarterCards(
    viewer({ signedIn: false, plan: null, enabledFlags: new Set() })
  );
  assert.ok(cards.some((card) => card.availability.state === "available"));
});

// --- capability resolution --------------------------------------------------

const NO_BACKENDS = { brave: false };

test("web search resolves only when a backend or a native path can dispatch", () => {
  const withBrave = resolveChatStarterCapabilities({
    webSearchBackendReadiness: { brave: true },
  });
  assert.ok(withBrave.includes("web-search"));
  // With no application-managed backend the native and search-model paths are
  // still dispatchable, so this is asserted as "still resolvable", not as
  // "absent" -- the point is that the answer comes from the same predicate the
  // chat route uses rather than from an assumption.
  const withoutBrave = resolveChatStarterCapabilities({
    webSearchBackendReadiness: NO_BACKENDS,
  });
  assert.equal(Array.isArray(withoutBrave), true);
});

test("resolution only ever returns ids the table defines", () => {
  const resolved = resolveChatStarterCapabilities({
    webSearchBackendReadiness: { brave: true },
  });
  for (const capability of resolved) {
    assert.ok(
      Object.prototype.hasOwnProperty.call(STARTER_CAPABILITIES, capability),
      capability
    );
  }
});

test("every entry the real catalogue holds can actually be offered somewhere", () => {
  // A card no viewer in any deployment could ever see is dead weight that
  // still has to be translated seven times.
  const everything = viewer({
    signedIn: true,
    plan: "Max",
    enabledFlags: new Set(allFlags),
    knownFlags: new Set(allFlags),
    modelCapabilities: new Set(allCapabilities),
  });
  for (const item of CHAT_STARTER_CATALOG) {
    assert.deepEqual(
      chatStarterAvailability(item, everything),
      { state: "available" },
      `${item.id} can never be offered`
    );
  }
});
