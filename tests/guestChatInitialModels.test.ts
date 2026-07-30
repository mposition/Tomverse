import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createGuestEligibilityCheck,
  getGuestDefaultSelectedModels,
  GUEST_BRAND_TRIO_MODEL_IDS,
} from "@/lib/appDefaults";
import {
  GUEST_ACTIVE_CHAT_STORAGE_KEY,
  GUEST_CONVERSATIONS_STORAGE_KEY,
  resolveGuestInitialSelectedModels,
  type GuestInitialModelEnvironment,
} from "@/lib/guestChatInitialModels";
import { getModel, isEnabledModelId } from "@/lib/models";

// This resolver runs during the chat page's first render on both the server
// and the client, so what it returns *is* the guest's first painted model
// count and estimated credits. Every case below asserts the answer is
// already final -- there is no later correction to fall back on.

const catalogue = {
  isEnabledModelId,
  isGuestEligible: createGuestEligibilityCheck(getModel),
};

const resolve = (environment: GuestInitialModelEnvironment = {}) =>
  resolveGuestInitialSelectedModels({ catalogue, environment });

const storage = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

const guestConversationEnvironment = (
  conversationId: string,
  conversation: Record<string, unknown>
): GuestInitialModelEnvironment => ({
  sessionStorage: storage({
    [GUEST_ACTIVE_CHAT_STORAGE_KEY]: conversationId,
  }),
  localStorage: storage({
    [GUEST_CONVERSATIONS_STORAGE_KEY]: JSON.stringify([
      { id: conversationId, ...conversation },
    ]),
  }),
});

const guestDefault = getGuestDefaultSelectedModels();

test("a brand-new guest starts on the full brand trio", () => {
  const resolved = resolve();

  assert.equal(resolved.source, "guest_default");
  assert.deepEqual(resolved.models, guestDefault);
});

test("server rendering resolves the same selection as the browser", () => {
  // No search string and no storage is exactly the environment
  // readGuestInitialModelEnvironment() reports when `window` is undefined.
  assert.deepEqual(resolve().models, resolve({ search: "" }).models);
});

test("the configured lead model orders the first paint's trio", () => {
  for (const leadModelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    const resolved = resolveGuestInitialSelectedModels({
      catalogue,
      leadModelId,
    });
    assert.deepEqual(resolved.models, getGuestDefaultSelectedModels(leadModelId));
    assert.equal(resolved.models[0], leadModelId);
  }
});

test("an explicit ?models= link outranks the guest default", () => {
  const requested = GUEST_BRAND_TRIO_MODEL_IDS.slice(0, 2);
  const resolved = resolve({ search: `?models=${requested.join(",")}&lang=en` });

  assert.equal(resolved.source, "url_models_param");
  assert.deepEqual(resolved.models, requested);
});

test("a ?models= link naming only unknown models falls back to the default", () => {
  const resolved = resolve({ search: "?models=not-a-model,also-not-a-model" });

  assert.equal(resolved.source, "guest_default");
  assert.deepEqual(resolved.models, guestDefault);
});

test("a ?models= link outranks the conversation this tab had open", () => {
  const requested = [GUEST_BRAND_TRIO_MODEL_IDS[2]];
  const resolved = resolve({
    ...guestConversationEnvironment("guest_1", {
      selectedModels: GUEST_BRAND_TRIO_MODEL_IDS,
    }),
    search: `?models=${requested.join(",")}`,
  });

  assert.equal(resolved.source, "url_models_param");
  assert.deepEqual(resolved.models, requested);
});

test("a saved guest conversation is restored at its own size", () => {
  for (const size of [1, 2, 3]) {
    const saved = GUEST_BRAND_TRIO_MODEL_IDS.slice(0, size);
    const resolved = resolve(
      guestConversationEnvironment("guest_1", { selectedModels: saved })
    );

    assert.equal(resolved.source, "restored_conversation", `size ${size}`);
    assert.deepEqual(resolved.models, saved);
  }
});

test("a double-encoded saved selection is still restored", () => {
  const saved = GUEST_BRAND_TRIO_MODEL_IDS.slice(0, 2);
  const resolved = resolve(
    guestConversationEnvironment("guest_1", {
      selectedModels: JSON.stringify(saved),
    })
  );

  assert.equal(resolved.source, "restored_conversation");
  assert.deepEqual(resolved.models, saved);
});

test("saved selections that no longer exist degrade to the guest default", () => {
  for (const selectedModels of [
    ["retired-model-id"],
    [],
    "not-json-at-all",
    null,
    { nope: true },
  ]) {
    const resolved = resolve(
      guestConversationEnvironment("guest_1", { selectedModels })
    );

    assert.equal(resolved.source, "guest_default", JSON.stringify(selectedModels));
    assert.deepEqual(resolved.models, guestDefault);
  }
});

test("a partially retired saved selection keeps only what still exists", () => {
  const survivor = GUEST_BRAND_TRIO_MODEL_IDS[0];
  const resolved = resolve(
    guestConversationEnvironment("guest_1", {
      selectedModels: [survivor, "retired-model-id"],
    })
  );

  assert.equal(resolved.source, "restored_conversation");
  assert.deepEqual(resolved.models, [survivor]);
});

test("an active chat id with no matching conversation uses the default", () => {
  const resolved = resolve({
    sessionStorage: storage({ [GUEST_ACTIVE_CHAT_STORAGE_KEY]: "guest_missing" }),
    localStorage: storage({
      [GUEST_CONVERSATIONS_STORAGE_KEY]: JSON.stringify([
        { id: "guest_other", selectedModels: [GUEST_BRAND_TRIO_MODEL_IDS[0]] },
      ]),
    }),
  });

  assert.equal(resolved.source, "guest_default");
  assert.deepEqual(resolved.models, guestDefault);
});

test("unreadable storage degrades to the default instead of throwing", () => {
  const throwingStorage = {
    getItem: () => {
      throw new Error("storage is blocked");
    },
  };
  const resolved = resolve({
    sessionStorage: throwingStorage,
    localStorage: throwingStorage,
  });

  assert.equal(resolved.source, "guest_default");
  assert.deepEqual(resolved.models, guestDefault);
});

test("corrupt guest conversation storage degrades to the default", () => {
  const resolved = resolve({
    sessionStorage: storage({ [GUEST_ACTIVE_CHAT_STORAGE_KEY]: "guest_1" }),
    localStorage: storage({ [GUEST_CONVERSATIONS_STORAGE_KEY]: "{ broken" }),
  });

  assert.equal(resolved.source, "guest_default");
  assert.deepEqual(resolved.models, guestDefault);
});

test("no selection ever exceeds the guest model cap", () => {
  const resolved = resolve({
    search: `?models=${[...GUEST_BRAND_TRIO_MODEL_IDS, ...GUEST_BRAND_TRIO_MODEL_IDS].join(",")}`,
  });

  assert.equal(resolved.models.length, guestDefault.length);
  assert.equal(new Set(resolved.models).size, resolved.models.length);
});

// -- AUD-R003: additional URL-preset hardening cases --

test("a ?models= link mixing valid and unknown models keeps only the valid ones, in order", () => {
  const [first, , third] = GUEST_BRAND_TRIO_MODEL_IDS;
  const resolved = resolve({
    search: `?models=not-a-model,${first},also-fake,${third}`,
  });

  assert.equal(resolved.source, "url_models_param");
  assert.deepEqual(resolved.models, [first, third]);
});

test("a ?models= link naming a plan-locked (Pro-only) model drops it, never granting guest access", () => {
  // gpt-5-5 is minimumPlan: "Pro" -- enabled, but never guest-eligible.
  const resolved = resolve({ search: "?models=gpt-5-5" });

  assert.equal(resolved.source, "guest_default");
  assert.ok(!resolved.models.includes("gpt-5-5"));
});

test("a ?models= link naming a non-Standard-tier model (Free plan but not guest tier) drops it", () => {
  // claude-sonnet-5 is minimumPlan: "Free" but usageClass "advanced", so it
  // passes the plan check but fails the guest Standard-tier requirement.
  const resolved = resolve({ search: "?models=claude-sonnet-5" });

  assert.equal(resolved.source, "guest_default");
  assert.ok(!resolved.models.includes("claude-sonnet-5"));
});

test("a plan-locked model mixed with an eligible one keeps only the eligible model", () => {
  const eligible = GUEST_BRAND_TRIO_MODEL_IDS[0];
  const resolved = resolve({ search: `?models=gpt-5-5,${eligible}` });

  assert.equal(resolved.source, "url_models_param");
  assert.deepEqual(resolved.models, [eligible]);
});

test("an extremely long ?models= query degrades safely to the guest default rather than throwing", () => {
  const junk = Array.from({ length: 5_000 }, (_, i) => `not-a-model-${i}`).join(",");
  const resolved = resolve({ search: `?models=${junk}` });

  assert.equal(resolved.source, "guest_default");
  assert.deepEqual(resolved.models, guestDefault);
});

test("a query key shaped like a prototype-pollution attempt has no effect on the resolved models", () => {
  const eligible = GUEST_BRAND_TRIO_MODEL_IDS[0];
  const resolved = resolve({
    search: `?models=${eligible}&__proto__[polluted]=1&constructor[prototype][polluted]=1`,
  });

  assert.equal(resolved.source, "url_models_param");
  assert.deepEqual(resolved.models, [eligible]);
  assert.equal((Object.prototype as Record<string, unknown>).polluted, undefined);
});

test("a ?models= link cannot smuggle credit, plan, or provider-shaped keys into the resolved selection", () => {
  const eligible = GUEST_BRAND_TRIO_MODEL_IDS[0];
  const resolved = resolve({
    search: `?models=${eligible}&plan=Max&credits=999999&providerApiKey=leaked`,
  });

  assert.deepEqual(Object.keys(resolved).sort(), ["models", "source"]);
  assert.deepEqual(resolved.models, [eligible]);
});
