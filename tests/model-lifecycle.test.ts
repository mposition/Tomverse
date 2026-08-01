import assert from "node:assert/strict";
import test from "node:test";

import {
  AVAILABLE_MODELS,
  PUBLIC_MODELS,
  PUBLIC_MODEL_PROVIDERS,
  isPreLaunchModel,
  isPubliclySelectableModel,
  isRetiredModel,
  isWithdrawnFromOfferModel,
  type AiModel,
} from "../lib/models";

// UX-F003. Two independent defects let a model no provider would serve stay
// selectable:
//
//  * the client catalog's "public" filter checked only
//    publiclyListed/catalogDeleted, never enabled/status, and
//  * the registry bootstrap only ever INSERTed the static catalog
//    (createMany + skipDuplicates), so retiring a model in lib/models.ts never
//    reached a runtime row that already existed.
//
// These pin the shared lifecycle contract both sites now use.

// AVAILABLE_MODELS is declared as a literal tuple so each entry keeps its
// exact type; widening it once here lets these checks read optional lifecycle
// fields that only some entries carry.
const CATALOG = AVAILABLE_MODELS as readonly AiModel[];

const model = (overrides: Partial<AiModel>): AiModel =>
  ({
    id: "test-model",
    name: "Test Model",
    apiModel: "test-model",
    provider: "openai",
    icon: "*",
    bestFor: "testing",
    minimumPlan: "Free",
    usageClass: "standard",
    enabled: true,
    status: "enabled",
    ...overrides,
  }) as AiModel;

test("a delisted, disabled model with status disabled counts as retired", () => {
  assert.equal(
    isRetiredModel(
      model({ enabled: false, publiclyListed: false, status: "disabled" })
    ),
    true
  );
});

test("a merely disabled model is not retired", () => {
  // Temporarily disabled by an operator is a different state from retired:
  // it must not trigger the bootstrap's retirement replay.
  assert.equal(isRetiredModel(model({ enabled: false })), false);
  assert.equal(
    isRetiredModel(model({ enabled: false, status: "disabled" })),
    false
  );
});

test("a retired model is never publicly selectable", () => {
  assert.equal(
    isPubliclySelectableModel(
      model({ enabled: false, publiclyListed: false, status: "disabled" })
    ),
    false
  );
});

test("a disabled model is not selectable even while still publicly listed", () => {
  // The exact shape the runtime registry was left in: the row kept
  // publiclyListed=true after the catalog disabled the model.
  assert.equal(
    isPubliclySelectableModel(
      model({ enabled: false, status: "disabled", publiclyListed: true })
    ),
    false
  );
});

test("catalogDeleted and coming-soon models are not selectable", () => {
  assert.equal(isPubliclySelectableModel(model({ catalogDeleted: true })), false);
  assert.equal(isPubliclySelectableModel(model({ status: "coming-soon" })), false);
});

test("an ordinary enabled model is selectable", () => {
  assert.equal(isPubliclySelectableModel(model({})), true);
});

test("every retired model in the catalog names a live replacement", () => {
  const selectableIds = new Set(
    CATALOG.filter(isPubliclySelectableModel).map((entry) => entry.id)
  );
  const retired = CATALOG.filter(isRetiredModel);

  assert.ok(
    retired.length > 0,
    "expected the catalog to still carry retired models to cover"
  );

  for (const entry of retired) {
    assert.ok(
      entry.replacementModelId,
      `retired model ${entry.id} must name a replacement`
    );
    assert.ok(
      selectableIds.has(entry.replacementModelId!),
      `retired model ${entry.id} points at ${entry.replacementModelId}, which is not selectable`
    );
  }
});

test("no publicly selectable model is simultaneously retired", () => {
  const contradictory = CATALOG.filter(
    (entry) => isPubliclySelectableModel(entry) && isRetiredModel(entry)
  );
  assert.deepEqual(contradictory.map((entry) => entry.id), []);
});

test("groq llama-4-scout stays retired and unselectable", () => {
  // The specific model the audit found still on offer through the live API.
  const scout = CATALOG.find((entry) => entry.id === "llama-4-scout");
  assert.ok(scout, "llama-4-scout should remain in the catalog for history");
  assert.equal(isRetiredModel(scout!), true);
  assert.equal(isPubliclySelectableModel(scout!), false);
  // Repointed off llama-3-3 when that model was retired too: a retirement
  // that names another retired model leaves users nowhere to go.
  assert.equal(scout!.replacementModelId, "gemini-3-5-flash");
});

// ---------------------------------------------------------------------------
// Catalogue policy: Llama is retired with Groq's public hosting, xAI is
// consolidated on Grok 4.5, and Groq's suggested GPT-OSS successors are
// deliberately not adopted.
// ---------------------------------------------------------------------------

const RETIRED_LLAMA_IDS = ["llama-3-1", "llama-3-3", "llama-4-scout"] as const;
const RETIRED_GROK_IDS = ["grok-4", "grok-3", "grok-3-mini"] as const;

const entry = (id: string) => CATALOG.find((model) => model.id === id);

test("no Llama model is publicly listed or selectable", () => {
  for (const id of RETIRED_LLAMA_IDS) {
    const model = entry(id);
    assert.ok(model, `${id} must stay in the catalog for stored conversations`);
    assert.equal(isRetiredModel(model!), true, `${id} must be retired`);
    assert.equal(isPubliclySelectableModel(model!), false);
    assert.equal(model!.publiclyListed, false);
    assert.equal(model!.enabled, false);
    assert.equal(model!.status, "disabled");
  }

  assert.deepEqual(
    PUBLIC_MODELS.filter((model) => /llama/i.test(`${model.id} ${model.name} ${model.apiModel}`))
      .map((model) => model.id),
    []
  );
});

test("each retired Llama names the active model that took over its role", () => {
  assert.equal(entry("llama-3-1")!.replacementModelId, "deepseek-v4-flash");
  assert.equal(entry("llama-3-3")!.replacementModelId, "mistral-medium-3-1");
  assert.equal(entry("llama-4-scout")!.replacementModelId, "gemini-3-5-flash");
});

test("groq has no publicly selectable model left", () => {
  assert.deepEqual(
    CATALOG.filter(
      (model) => model.provider === "groq" && isPubliclySelectableModel(model)
    ).map((model) => model.id),
    []
  );
  // The provider itself is deliberately kept wired up for internal
  // evaluation and incident response -- only its public catalogue is empty.
  assert.ok(
    CATALOG.some((model) => model.provider === "groq"),
    "the groq provider connection must stay in the catalog"
  );
});

// Standing decision, reaffirmed after Groq's deprecation notice named
// openai/gpt-oss-* as the Llama successors -- see the note above
// AVAILABLE_MODELS' Llama block for why it is declined. Asserted against the
// whole catalogue rather than only the public list, because the tempting way
// in is a hidden row existing purely to be a retirement's replacement target.
test("GPT-OSS is absent from the catalogue entirely", () => {
  const matchesGptOss = (model: AiModel) =>
    /gpt-?oss/i.test(`${model.id} ${model.name} ${model.apiModel}`);

  assert.deepEqual(CATALOG.filter(matchesGptOss).map((model) => model.id), []);
  assert.deepEqual(
    PUBLIC_MODELS.filter(matchesGptOss).map((model) => model.id),
    []
  );
  // Not reachable as a replacement either, hidden or otherwise.
  assert.deepEqual(
    CATALOG.filter((model) => /gpt-?oss/i.test(model.replacementModelId ?? ""))
      .map((model) => model.id),
    []
  );
});

test("xai exposes Grok 4.5 and nothing else", () => {
  const publicXai = PUBLIC_MODELS.filter(
    (model) => model.provider === "xai" && isPubliclySelectableModel(model)
  );
  assert.deepEqual(publicXai.map((model) => model.id), ["grok-4-5"]);

  const grok45 = entry("grok-4-5")!;
  assert.equal(grok45.apiModel, "grok-4.5");
  assert.equal(grok45.enabled, true);
  assert.equal(grok45.status, "enabled");
  assert.notEqual(grok45.publiclyListed, false);
});

test("older Grok models stay resolvable as history but cannot be selected", () => {
  for (const id of RETIRED_GROK_IDS) {
    const model = entry(id);
    assert.ok(model, `${id} must stay resolvable for stored conversations`);
    assert.ok(model!.name, `${id} must keep a display name for old transcripts`);
    assert.equal(isRetiredModel(model!), true);
    assert.equal(isPubliclySelectableModel(model!), false);
    assert.equal(model!.replacementModelId, "grok-4-5");
  }
});

test("Kimi K3 and Kimi K2.7 are two distinct models, not a rename", () => {
  const k3 = entry("kimi-k3");
  const k27 = entry("kimi-k2.7-code");
  assert.ok(k3, "kimi-k3 must exist");
  assert.ok(k27, "kimi-k2.7-code must stay published alongside it");
  assert.notEqual(k3!.apiModel, k27!.apiModel);
  assert.equal(k3!.apiModel, "kimi-k3");
  assert.equal(k27!.apiModel, "kimi-k2.7-code");
  assert.equal(k3!.provider, "moonshot");
  assert.equal(k27!.provider, "moonshot");
  assert.equal(k3!.icon, k27!.icon);
  // The coding-specialised model is unaffected by K3 being withheld.
  assert.equal(isPubliclySelectableModel(k27!), true);
  // Officially documented capability fields only -- see lib/models.ts. None
  // of these is a price, and none of them makes the model launchable.
  assert.equal(k3!.contextWindowTokens, 1_048_576);
  assert.equal(k3!.inputCapabilities?.image, true);
  assert.equal(k3!.reasoning, "high");
});

// Kimi K3's unit economics are not established: no published price, no
// explicit chat reasoning effort, no output cap, no reasoning_content
// handling, and a flat 3x ceiling on long-input credits against a 1M-token
// window. Until those are settled it is registered but withheld, and this is
// what stops "enabled: true" being restored without them.
test("Kimi K3 is registered but not launched", () => {
  const k3 = entry("kimi-k3")!;
  assert.equal(isPreLaunchModel(k3), true);
  assert.equal(k3.enabled, false);
  assert.equal(k3.publiclyListed, false);
  assert.equal(k3.status, "coming-soon");
  assert.equal(isPubliclySelectableModel(k3), false);
  // Withheld, not retired: it has nothing to hand users off to, and it must
  // not be described to them as a model that used to work.
  assert.equal(isRetiredModel(k3), false);
  assert.equal(k3.replacementModelId, undefined);
  // No price may be asserted for it while it is unpriced.
  assert.equal(k3.inputUsdPerMillionTokens, undefined);
  assert.equal(k3.outputUsdPerMillionTokens, undefined);
});

test("a pre-launch model is withdrawn from the offer just like a retired one", () => {
  // Both are replayed onto existing registry rows by the bootstrap, which is
  // the only thing that can correct an environment that received an earlier
  // build with the model enabled.
  assert.equal(isWithdrawnFromOfferModel(entry("kimi-k3")!), true);
  assert.equal(isWithdrawnFromOfferModel(entry("grok-3")!), true);
  assert.equal(isWithdrawnFromOfferModel(entry("grok-4-5")!), false);
});

// Models known to have no published provider price yet. getModelBillingProfile
// always returns a number -- an unpriced model silently inherits its usage
// class's fallback -- so nothing downstream can tell that a price is missing.
// Listing them here is what makes it visible, and the assertion below is what
// stops one being offered while it is still on the list.
// Two selectable models may share one provider model id -- that is how a
// "Thinking" variant is built -- but only if the request Tomverse sends for
// them actually differs. gpt-5-5-thinking shared apiModel "gpt-5.5" with
// gpt-5-5 while the chat route sent no reasoning parameter at all, so the two
// were the same upstream call at 16 credits versus 8. The route now sends
// reasoningEffort for OpenAI reasoning models; this pins the pairing so a
// future duplicate cannot reintroduce a name-only variant.
const REASONING_FORWARDED_PROVIDERS = new Set(["openai"]);

test("a shared apiModel is only allowed when the request really differs", () => {
  const byApiModel = new Map<string, AiModel[]>();
  for (const model of CATALOG) {
    if (!isPubliclySelectableModel(model)) continue;
    const group = byApiModel.get(model.apiModel) ?? [];
    group.push(model);
    byApiModel.set(model.apiModel, group);
  }

  for (const [apiModel, group] of byApiModel) {
    if (group.length < 2) continue;
    const efforts = new Set(group.map((model) => model.reasoning ?? "none"));
    assert.equal(
      efforts.size,
      group.length,
      `${group.map((m) => m.id).join(", ")} all send apiModel "${apiModel}" with the same reasoning effort, so they are the same request at different prices`
    );
    for (const model of group) {
      assert.equal(
        REASONING_FORWARDED_PROVIDERS.has(model.provider),
        true,
        `${model.id} shares apiModel "${apiModel}" but its provider (${model.provider}) is not one the chat route forwards reasoning effort to, so the variants are indistinguishable upstream`
      );
    }
  }
});

const UNPRICED_MODEL_IDS = ["kimi-k3"];

test("a model with no published price is never offered to users", () => {
  for (const modelId of UNPRICED_MODEL_IDS) {
    const model = entry(modelId);
    assert.ok(model, `${modelId} should be in the catalogue`);
    assert.equal(
      isPubliclySelectableModel(model!),
      false,
      `${modelId} is selectable while unpriced -- register its provider price profile first, then remove it from UNPRICED_MODEL_IDS`
    );
  }
});

test("the public provider and model counts are derived, not hard-coded", () => {
  const selectable = PUBLIC_MODELS.filter(isPubliclySelectableModel);
  const derivedProviders = new Set(selectable.map((model) => model.provider));

  // Whatever the catalogue currently says, the exported counts must agree
  // with it -- this is what keeps the marketing provider count honest after
  // a retirement empties a provider.
  assert.deepEqual(
    [...PUBLIC_MODEL_PROVIDERS].sort(),
    [...derivedProviders].sort()
  );
  assert.equal(derivedProviders.has("groq"), false);
  assert.ok(PUBLIC_MODEL_PROVIDERS.length > 0);
  assert.ok(selectable.length > 0);
});
