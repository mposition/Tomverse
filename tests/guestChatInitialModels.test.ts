import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createDefaultLineupEligibilityCheck,
  createGuestEligibilityCheck,
  createReplacementResolver,
  getGuestDefaultSelectedModels,
  GUEST_BRAND_TRIO_MODEL_IDS,
} from "@/lib/appDefaults";
import {
  GUEST_ACTIVE_CHAT_STORAGE_KEY,
  GUEST_CHAT_ACTIVE_CHAT_STORAGE_KEY,
  GUEST_CHAT_CONVERSATIONS_STORAGE_KEY,
  GUEST_CONVERSATIONS_STORAGE_KEY,
  guestWorkspaceStorageKeys,
  newGuestConversationId,
  resolveGuestInitialSelectedModels,
  resolveGuestInitialWebSearchMode,
  type GuestInitialModelEnvironment,
} from "@/lib/guestChatInitialModels";
import { getModel, isEnabledModelId, type AiModel } from "@/lib/models";

// This resolver runs during the chat page's first render on both the server
// and the client, so what it returns *is* the guest's first painted model
// count and estimated credits. Every case below asserts the answer is
// already final -- there is no later correction to fall back on.

const catalogue = {
  isEnabledModelId,
  isGuestEligible: createGuestEligibilityCheck(getModel),
  isDefaultEligible: createDefaultLineupEligibilityCheck(getModel, createGuestEligibilityCheck(getModel)),
};

const resolve = (environment: GuestInitialModelEnvironment = {}) =>
  resolveGuestInitialSelectedModels({ catalogue, environment });

const storage = (entries: Record<string, string>) => ({
  getItem: (key: string) => entries[key] ?? null,
});

const guestConversationEnvironment = (
  conversationId: string,
  conversation: Record<string, unknown>,
  product: "chat" | "review" = "review"
): GuestInitialModelEnvironment => ({
  sessionStorage: storage({
    [guestWorkspaceStorageKeys(product).activeChatKey]: conversationId,
  }),
  localStorage: storage({
    [guestWorkspaceStorageKeys(product).conversationsKey]: JSON.stringify([
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

test("Guest Chat has its own storage namespace and starts on one eligible model", () => {
  assert.deepEqual(guestWorkspaceStorageKeys("review"), {
    activeChatKey: GUEST_ACTIVE_CHAT_STORAGE_KEY,
    conversationsKey: GUEST_CONVERSATIONS_STORAGE_KEY,
  });
  assert.deepEqual(guestWorkspaceStorageKeys("chat"), {
    activeChatKey: GUEST_CHAT_ACTIVE_CHAT_STORAGE_KEY,
    conversationsKey: GUEST_CHAT_CONVERSATIONS_STORAGE_KEY,
  });
  assert.equal(newGuestConversationId("review", 42), "guest_42");
  assert.equal(newGuestConversationId("chat", 42), "guest_chat_42");

  const resolved = resolveGuestInitialSelectedModels({
    catalogue,
    product: "chat",
  });
  assert.equal(resolved.source, "guest_default");
  assert.deepEqual(resolved.models, guestDefault.slice(0, 1));
});

test("Guest Chat clamps URL and restored selections to one without reading Review storage", () => {
  const requested = resolveGuestInitialSelectedModels({
    catalogue,
    product: "chat",
    environment: {
      ...guestConversationEnvironment("guest_chat_1", {
        selectedModels: GUEST_BRAND_TRIO_MODEL_IDS,
      }, "chat"),
      search: `?models=${GUEST_BRAND_TRIO_MODEL_IDS.join(",")}`,
    },
  });
  assert.equal(requested.source, "url_models_param");
  assert.deepEqual(requested.models, GUEST_BRAND_TRIO_MODEL_IDS.slice(0, 1));

  const restored = resolveGuestInitialSelectedModels({
    catalogue,
    product: "chat",
    environment: guestConversationEnvironment("guest_chat_2", {
      selectedModels: GUEST_BRAND_TRIO_MODEL_IDS,
    }, "chat"),
  });
  assert.equal(restored.source, "restored_conversation");
  assert.deepEqual(restored.models, GUEST_BRAND_TRIO_MODEL_IDS.slice(0, 1));

  const reviewOnlyEnvironment = guestConversationEnvironment("guest_review", {
    selectedModels: [GUEST_BRAND_TRIO_MODEL_IDS[2]],
  });
  const isolated = resolveGuestInitialSelectedModels({
    catalogue,
    product: "chat",
    environment: reviewOnlyEnvironment,
  });
  assert.equal(isolated.source, "guest_default");
  assert.deepEqual(isolated.models, guestDefault.slice(0, 1));
});

test("Guest Chat restores web search only from its own product namespace", () => {
  assert.equal(resolveGuestInitialWebSearchMode(
    guestConversationEnvironment("guest_chat_3", { webSearchMode: "off" }, "chat"),
    "chat"
  ), "off");
  assert.equal(resolveGuestInitialWebSearchMode(
    guestConversationEnvironment("guest_review", { webSearchMode: "off" }),
    "chat"
  ), "always");
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

test("a new guest conversation starts with web search on", () => {
  assert.equal(resolveGuestInitialWebSearchMode(), "always");
  assert.equal(resolveGuestInitialWebSearchMode({ search: "" }), "always");
});

test("a restored guest conversation keeps its own search switch from the first render", () => {
  // Pricing a restored search-off conversation as a new one for a frame is
  // the same one-frame price flicker as STG-F006, one input over.
  assert.equal(
    resolveGuestInitialWebSearchMode(
      guestConversationEnvironment("guest_off", { webSearchMode: "off" })
    ),
    "off"
  );
  assert.equal(
    resolveGuestInitialWebSearchMode(
      guestConversationEnvironment("guest_on", { webSearchMode: "always" })
    ),
    "always"
  );
  // The retired and unreadable values read as off, exactly as the restore
  // effect reads them -- never as the new-conversation default.
  for (const webSearchMode of ["auto", undefined, 7]) {
    assert.equal(
      resolveGuestInitialWebSearchMode(
        guestConversationEnvironment("guest_legacy", { webSearchMode })
      ),
      "off"
    );
  }
});

test("a models link does not change the restored conversation's search switch", () => {
  const environment = {
    ...guestConversationEnvironment("guest_off", { webSearchMode: "off" }),
    search: "?models=gpt-5-6-luna",
  };
  assert.equal(resolveGuestInitialWebSearchMode(environment), "off");
});

test("the first paint succeeds a retired trio member through the catalogue's resolver", () => {
  const [openai, anthropic, google] = GUEST_BRAND_TRIO_MODEL_IDS;
  const successor: AiModel = { ...getModel(anthropic)!, id: "claude-haiku-next", replacementModelId: undefined };
  const rows = new Map<string, AiModel>([
    [anthropic, { ...getModel(anthropic)!, enabled: false, status: "disabled" as const, publiclyListed: false, replacementModelId: successor.id }],
    [successor.id, successor],
  ]);
  const lookup = (id: string) => rows.get(id) ?? getModel(id);
  const retiredCatalogue = {
    isEnabledModelId: (id: string) => Boolean(lookup(id)?.enabled),
    isGuestEligible: createGuestEligibilityCheck(lookup),
    isDefaultEligible: createDefaultLineupEligibilityCheck(lookup, createGuestEligibilityCheck(lookup)),
    resolveReplacement: createReplacementResolver(lookup),
  };
  const selection = resolveGuestInitialSelectedModels({
    catalogue: retiredCatalogue,
    leadModelId: openai,
  });
  assert.deepEqual(selection.models, [openai, successor.id, google]);
});

test("a lineup member later limited or unlisted is succeeded in the default, but a guest who picks it keeps it", () => {
  const [openai, anthropic, google] = GUEST_BRAND_TRIO_MODEL_IDS;
  const successor: AiModel = { ...getModel(anthropic)!, id: "claude-haiku-next", replacementModelId: undefined };
  for (const change of [{ status: "limited" as const }, { publiclyListed: false }]) {
    // Still enabled, guest and Standard: the plain guest check passes it.
    const rows = new Map<string, AiModel>([
      [anthropic, { ...getModel(anthropic)!, ...change, replacementModelId: successor.id }],
      [successor.id, successor],
    ]);
    const lookup = (id: string) => rows.get(id) ?? getModel(id);
    const isGuestEligible = createGuestEligibilityCheck(lookup);
    assert.equal(isGuestEligible(anthropic), true);
    const limitedCatalogue = {
      isEnabledModelId: (id: string) => Boolean(lookup(id)?.enabled),
      isGuestEligible,
      isDefaultEligible: createDefaultLineupEligibilityCheck(lookup, isGuestEligible),
      resolveReplacement: createReplacementResolver(lookup),
    };
    assert.deepEqual(
      resolveGuestInitialSelectedModels({ catalogue: limitedCatalogue, leadModelId: openai }).models,
      [openai, successor.id, google],
      JSON.stringify(change)
    );
    // A models link that names it is the guest's own pick, clamped by the
    // plain guest check, so a runnable model is not taken away.
    assert.ok(
      resolveGuestInitialSelectedModels({
        catalogue: limitedCatalogue,
        environment: { search: `?models=${anthropic}` },
      }).models.includes(anthropic),
      JSON.stringify(change)
    );
  }
});
