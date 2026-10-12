import assert from "node:assert/strict";
import { test } from "node:test";
import {
  APP_DEFAULTS,
  createGuestEligibilityCheck,
  createReplacementResolver,
  expectedLeadForStored,
  getGuestDefaultSelectedModels,
  GUEST_BRAND_TRIO_MODEL_IDS,
  GUEST_LINEUP_PROVIDERS,
  guestBrandTrioRejection,
  guestDefaultLeadRejection,
  guestLeadForLineup,
  GUEST_FALLBACK_MODEL_IDS,
  isOnePerLineupProvider,
  lineupSlotProviders,
  missingLineupProviders,
  parseGuestBrandTrio,
  resolveGuestDefaultSelectedModels,
} from "@/lib/appDefaults";
import {
  getModel,
  getModelUsageProfile,
  getWeightedUsageCredits,
  type AiModel,
} from "@/lib/models";

// The guest default and the credits shown for it are the same decision seen
// from two angles, so these lock down the resolver's shape (always three
// distinct guest-usable models) and the fact that the price is summed from
// that selection rather than tracked next to it. Nothing here hardcodes a
// credit total: the expected numbers are derived from the catalogue, so a
// change to any model's base cost updates both sides together.

const isGuestEligible = createGuestEligibilityCheck(getModel);

const baseCreditsFor = (modelIds: string[]) =>
  modelIds.reduce((sum, modelId) => {
    const model = getModel(modelId);
    return sum + (model ? getModelUsageProfile(model).credits : 0);
  }, 0);

// Mirrors what components/chat/ChatInput.tsx sums for the composer estimate.
const estimatedCreditsFor = (modelIds: string[], inputTokens = 1) =>
  modelIds.reduce((sum, modelId) => {
    const model = getModel(modelId);
    return sum + (model ? getWeightedUsageCredits(model, inputTokens) : 0);
  }, 0);

test("the guest default is the full brand trio", () => {
  const models = getGuestDefaultSelectedModels();

  assert.equal(models.length, APP_DEFAULTS.maxGuestSelectedModels);
  assert.equal(new Set(models).size, models.length);
  assert.deepEqual([...models].sort(), [...GUEST_BRAND_TRIO_MODEL_IDS].sort());
  for (const modelId of models) {
    assert.equal(isGuestEligible(modelId), true, modelId);
  }
});

test("the configured lead model only reorders the trio", () => {
  for (const leadModelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    const models = getGuestDefaultSelectedModels(leadModelId);
    assert.equal(models[0], leadModelId);
    assert.deepEqual([...models].sort(), [...GUEST_BRAND_TRIO_MODEL_IDS].sort());
  }
});

test("a lead model outside the trio is ignored, not added", () => {
  const outsider = GUEST_FALLBACK_MODEL_IDS[0];
  assert.equal(GUEST_BRAND_TRIO_MODEL_IDS.includes(outsider), false);

  const models = getGuestDefaultSelectedModels(outsider);
  assert.equal(models.includes(outsider), false);
  assert.deepEqual([...models].sort(), [...GUEST_BRAND_TRIO_MODEL_IDS].sort());
});

test("an unavailable trio model is backfilled instead of shrinking the default", () => {
  const unavailable = GUEST_BRAND_TRIO_MODEL_IDS[1];
  const models = resolveGuestDefaultSelectedModels({
    isEligible: (modelId) => modelId !== unavailable && isGuestEligible(modelId),
  });

  assert.equal(models.length, APP_DEFAULTS.maxGuestSelectedModels);
  assert.equal(models.includes(unavailable), false);
  assert.equal(new Set(models).size, models.length);
  assert.equal(
    models.some((modelId) => GUEST_FALLBACK_MODEL_IDS.includes(modelId)),
    true
  );
});

test("an empty catalogue degrades to no selection rather than an invalid one", () => {
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ isEligible: () => false }),
    []
  );
});

test("guest eligibility rejects deleted, plan-locked and higher-tier models", () => {
  const trioModel = getModel(GUEST_BRAND_TRIO_MODEL_IDS[0]) as AiModel;
  const check = (overrides: Partial<AiModel>) =>
    createGuestEligibilityCheck(() => ({ ...trioModel, ...overrides }))(
      trioModel.id
    );

  assert.equal(check({}), true);
  assert.equal(check({ enabled: false }), false);
  assert.equal(check({ catalogDeleted: true }), false);
  assert.equal(check({ minimumPlan: "Pro" }), false);
  assert.equal(check({ usageClass: "premium", creditWeight: undefined }), false);
  assert.equal(createGuestEligibilityCheck(() => undefined)(trioModel.id), false);
});

test("estimated credits are the sum of the selected models' costs", () => {
  const models = getGuestDefaultSelectedModels();

  assert.equal(estimatedCreditsFor(models), baseCreditsFor(models));
  // Every guest-eligible model is Standard tier, so the trio's estimate is
  // one credit per selected model -- the "3 credits" a new guest is quoted.
  assert.equal(estimatedCreditsFor(models), models.length);

  // Deselecting and reselecting moves the estimate by exactly that model's
  // own cost, which is what makes a separately stored total impossible.
  const [dropped, ...remaining] = models;
  assert.equal(
    estimatedCreditsFor(remaining),
    estimatedCreditsFor(models) - estimatedCreditsFor([dropped])
  );
  assert.equal(estimatedCreditsFor([]), 0);
});

// The write side of the same decision. The resolver above already ignores a
// lead outside the trio; these are what stop that from being reachable at all,
// because a setting that saves and then does nothing is worse than one that
// refuses -- the administrator gets a success either way.

test("only a brand-trio model may be stored as the guest lead", () => {
  for (const modelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    const model = getModel(modelId) as AiModel;
    assert.equal(
      guestDefaultLeadRejection({
        modelId,
        exists: true,
        guestEligible: true,
        usageCategory: getModelUsageProfile(model).category,
      }),
      null,
      modelId
    );
  }
});

test("an eligible model outside the trio is rejected as a no-op, not accepted", () => {
  const outsider = GUEST_FALLBACK_MODEL_IDS[0];
  assert.equal(
    isGuestEligible(outsider),
    true,
    "the fixture must pass every eligibility rule, so only the trio rule can reject it"
  );

  const rejection = guestDefaultLeadRejection({
    modelId: outsider,
    exists: true,
    guestEligible: true,
    usageCategory: "Standard",
  });
  assert.ok(rejection);
  assert.match(rejection, /stored but never applied/);
  // And the message has to name what would work, or it is just a refusal.
  for (const modelId of GUEST_BRAND_TRIO_MODEL_IDS) {
    assert.ok(rejection.includes(modelId), modelId);
  }
});

test("disabled, non-guest and non-Standard leads are each rejected on their own terms", () => {
  const lead = GUEST_BRAND_TRIO_MODEL_IDS[0];
  const base = {
    modelId: lead,
    exists: true,
    guestEligible: true,
    usageCategory: "Standard",
  };

  assert.match(
    guestDefaultLeadRejection({ ...base, exists: false }) ?? "",
    /not an enabled model/
  );
  assert.match(
    guestDefaultLeadRejection({ ...base, guestEligible: false }) ?? "",
    /not available to guests/
  );
  assert.match(
    guestDefaultLeadRejection({ ...base, usageCategory: "Premium" }) ?? "",
    /not Standard/
  );
  assert.match(
    guestDefaultLeadRejection({ ...base, usageCategory: null }) ?? "",
    /not Standard/
  );
});

// Platform strategy, operator decision 2026-10-12: a guest's default lineup
// always holds one OpenAI, one Anthropic and one Gemini model
// (docs/policy/credit-and-cost-limits.md).
test("the compiled trio is one OpenAI, one Anthropic and one Gemini model", () => {
  const providers = GUEST_BRAND_TRIO_MODEL_IDS.map((id) => getModel(id)?.provider);
  assert.deepEqual([...providers].sort(), ["anthropic", "google", "openai"]);
});

// A catalogue in which the trio's members can be retired. Every row starts as
// the compiled row, so only the fields a test names differ from production.
const catalogueWith = (overrides: Record<string, Partial<AiModel>>) => {
  const rows = new Map<string, AiModel>();
  for (const [id, change] of Object.entries(overrides)) {
    const base = getModel(id) ?? getModel(GUEST_BRAND_TRIO_MODEL_IDS[0])!;
    rows.set(id, { ...base, id, ...change } as AiModel);
  }
  const lookup = (id: string) => rows.get(id) ?? getModel(id);
  return {
    isEligible: createGuestEligibilityCheck(lookup),
    resolveReplacement: createReplacementResolver(lookup),
  };
};
const retired = (replacementModelId: string): Partial<AiModel> => ({
  enabled: false,
  status: "disabled",
  publiclyListed: false,
  replacementModelId,
});
const [OPENAI_SLOT, ANTHROPIC_SLOT, GOOGLE_SLOT] = GUEST_BRAND_TRIO_MODEL_IDS;

test("a retired trio member is succeeded in its own slot", () => {
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-next"),
    "claude-haiku-next": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, "claude-haiku-next", GOOGLE_SLOT]
  );
});

test("a retired lead is succeeded as the lead", () => {
  const catalogue = catalogueWith({
    [OPENAI_SLOT]: retired("gpt-luna-next"),
    "gpt-luna-next": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    ["gpt-luna-next", ANTHROPIC_SLOT, GOOGLE_SLOT]
  );
});

test("the chain is followed through a retired successor", () => {
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-next"),
    "claude-haiku-next": retired("claude-haiku-after"),
    "claude-haiku-after": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, "claude-haiku-after", GOOGLE_SLOT]
  );
});

test("a successor guests cannot use leaves the slot to the fallback list", () => {
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-next"),
    "claude-haiku-next": { enabled: true, status: "enabled", publiclyListed: true, minimumPlan: "Pro", replacementModelId: undefined },
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, GOOGLE_SLOT, GUEST_FALLBACK_MODEL_IDS[0]]
  );
});

test("a successor already selected is not counted twice", () => {
  const catalogue = catalogueWith({ [ANTHROPIC_SLOT]: retired(GOOGLE_SLOT) });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, GOOGLE_SLOT, GUEST_FALLBACK_MODEL_IDS[0]]
  );
});

test("a replacement cycle ends in the fallback list, not in a loop", () => {
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-next"),
    "claude-haiku-next": retired(ANTHROPIC_SLOT),
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, GOOGLE_SLOT, GUEST_FALLBACK_MODEL_IDS[0]]
  );
});

test("without a resolver a retired member still falls to the fallback list", () => {
  const { isEligible } = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-next"),
    "claude-haiku-next": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ isEligible, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, GOOGLE_SLOT, GUEST_FALLBACK_MODEL_IDS[0]]
  );
});

// The administrator's default lineup (AppSetting["guestBrandTrioModelIds"]).

test("a stored lineup parses only as exactly three distinct ids", () => {
  const lineup = ["gpt-5-6-luna", "claude-sonnet-5", "gemini-2-5-flash"];
  assert.deepEqual(parseGuestBrandTrio(JSON.stringify(lineup)), lineup);
  assert.deepEqual(parseGuestBrandTrio(lineup), lineup);
  assert.deepEqual(parseGuestBrandTrio([" gpt-5-6-luna ", "claude-sonnet-5", "gemini-2-5-flash"]), lineup);
  for (const bad of [
    null,
    undefined,
    "",
    "not json",
    "{}",
    JSON.stringify(lineup.slice(0, 2)),
    JSON.stringify([...lineup, "mistral-small-4"]),
    JSON.stringify(["gpt-5-6-luna", "gpt-5-6-luna", "gemini-2-5-flash"]),
    JSON.stringify(["gpt-5-6-luna", "", "gemini-2-5-flash"]),
    JSON.stringify(["gpt-5-6-luna", 7, "gemini-2-5-flash"]),
  ]) {
    assert.equal(parseGuestBrandTrio(bad), null, String(bad));
  }
});

test("the resolver opens on the administrator's lineup, in its order", () => {
  const lineup = ["gemini-flash-lite-latest", "deepseek-v4-flash", "mistral-small-4"];
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ isEligible: isGuestEligible, trio: lineup, leadModelId: lineup[0] }),
    lineup
  );
  // The lead reorders within that lineup, and a lead outside it is ignored.
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ isEligible: isGuestEligible, trio: lineup, leadModelId: "mistral-small-4" }),
    ["mistral-small-4", "gemini-flash-lite-latest", "deepseek-v4-flash"]
  );
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ isEligible: isGuestEligible, trio: lineup, leadModelId: GUEST_BRAND_TRIO_MODEL_IDS[0] }),
    lineup
  );
});

test("a lead is checked against the lineup it would order", () => {
  const lineup = ["gemini-flash-lite-latest", "deepseek-v4-flash", "mistral-small-4"];
  const base = { exists: true, guestEligible: true, usageCategory: "Standard" };
  assert.equal(guestDefaultLeadRejection({ ...base, modelId: "deepseek-v4-flash", trio: lineup }), null);
  assert.match(
    guestDefaultLeadRejection({ ...base, modelId: GUEST_BRAND_TRIO_MODEL_IDS[0], trio: lineup }) ?? "",
    /not one of the guest brand trio/
  );
});

test("a lineup is refused for a wrong size, a repeat, or any member guests could not be shown or priced", () => {
  const good = { exists: true, guestEligible: true, usageCategory: "Standard", priced: true, provider: "openai" as string | null };
  const providerOf: Record<string, string> = { a: "openai", b: "anthropic", c: "google" };
  const factsFor = (overrides: Record<string, Partial<typeof good>>) => (id: string) => ({
    ...good,
    provider: providerOf[id] ?? null,
    ...(overrides[id] ?? {}),
  });
  const lineup = ["a", "b", "c"];
  assert.equal(guestBrandTrioRejection({ modelIds: lineup, facts: factsFor({}) }), null);
  assert.match(guestBrandTrioRejection({ modelIds: ["a", "b"], facts: factsFor({}) }) ?? "", /exactly 3/);
  assert.match(guestBrandTrioRejection({ modelIds: ["a", "a", "c"], facts: factsFor({}) }) ?? "", /same model twice/);
  assert.match(guestBrandTrioRejection({ modelIds: lineup, facts: factsFor({ b: { exists: false } }) }) ?? "", /"b" is not an enabled model/);
  assert.match(guestBrandTrioRejection({ modelIds: lineup, facts: factsFor({ b: { guestEligible: false } }) }) ?? "", /not available to guests/);
  assert.match(guestBrandTrioRejection({ modelIds: lineup, facts: factsFor({ c: { usageCategory: "Premium" } }) }) ?? "", /not Standard/);
  assert.match(guestBrandTrioRejection({ modelIds: lineup, facts: factsFor({ a: { priced: false } }) }) ?? "", /no verified price/);
});

test("a lineup must hold one OpenAI, one Anthropic and one Gemini model", () => {
  const facts = (provider: string) => () => ({
    exists: true,
    guestEligible: true,
    usageCategory: "Standard",
    priced: true,
    provider,
  });
  const providers: Record<string, string> = { a: "openai", b: "anthropic", c: "google", d: "openai", e: "deepseek" };
  const factsById = (id: string) => facts(providers[id])();
  assert.equal(guestBrandTrioRejection({ modelIds: ["a", "b", "c"], facts: factsById }), null);
  assert.match(
    guestBrandTrioRejection({ modelIds: ["a", "d", "c"], facts: factsById }) ?? "",
    /one OpenAI, one Anthropic and one Gemini model; this one is openai, openai, google/
  );
  assert.match(
    guestBrandTrioRejection({ modelIds: ["a", "b", "e"], facts: factsById }) ?? "",
    /one OpenAI, one Anthropic and one Gemini/
  );
  assert.deepEqual([...GUEST_LINEUP_PROVIDERS].sort(), ["anthropic", "google", "openai"]);
});

test("the chain walks past a successor guests cannot use to a later one they can", () => {
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-pro-only"),
    "claude-haiku-pro-only": {
      enabled: true,
      status: "enabled",
      publiclyListed: true,
      minimumPlan: "Pro",
      replacementModelId: "claude-haiku-after",
    },
    "claude-haiku-after": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, "claude-haiku-after", GOOGLE_SLOT]
  );
});

test("a stored lead inside the lineup is handed over even when retired, so its successor leads", () => {
  const lineup = [OPENAI_SLOT, ANTHROPIC_SLOT, GOOGLE_SLOT];
  assert.equal(guestLeadForLineup(ANTHROPIC_SLOT, lineup), ANTHROPIC_SLOT);
  assert.equal(guestLeadForLineup("not-in-the-lineup", lineup), APP_DEFAULTS.guestDefaultModelId);
  assert.equal(guestLeadForLineup(null, lineup), APP_DEFAULTS.guestDefaultModelId);
  // End to end with the resolver: the retired lead's successor leads.
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-next"),
    "claude-haiku-next": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({
      ...catalogue,
      trio: lineup,
      leadModelId: guestLeadForLineup(ANTHROPIC_SLOT, lineup),
    }),
    ["claude-haiku-next", OPENAI_SLOT, GOOGLE_SLOT]
  );
});

test("a successor that is only limited is walked past, as the selection would drop it", () => {
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-limited"),
    "claude-haiku-limited": {
      enabled: true,
      status: "limited",
      publiclyListed: true,
      replacementModelId: "claude-haiku-after",
    },
    "claude-haiku-after": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.equal(catalogue.resolveReplacement(ANTHROPIC_SLOT), "claude-haiku-after");
  assert.deepEqual(
    resolveGuestDefaultSelectedModels({ ...catalogue, leadModelId: OPENAI_SLOT }),
    [OPENAI_SLOT, "claude-haiku-after", GOOGLE_SLOT]
  );
});

test("a stored lead that was succeeded expects its successor; any other stored lead expects itself", () => {
  const lineup = [OPENAI_SLOT, ANTHROPIC_SLOT, GOOGLE_SLOT];
  const catalogue = catalogueWith({
    [ANTHROPIC_SLOT]: retired("claude-haiku-next"),
    "claude-haiku-next": { enabled: true, status: "enabled", publiclyListed: true, replacementModelId: undefined },
  });
  assert.equal(
    expectedLeadForStored({ ...catalogue, stored: ANTHROPIC_SLOT, lineup }),
    "claude-haiku-next"
  );
  assert.equal(expectedLeadForStored({ ...catalogue, stored: OPENAI_SLOT, lineup }), OPENAI_SLOT);
  // Outside the lineup the resolver never reads it, so nothing is succeeded.
  assert.equal(
    expectedLeadForStored({ ...catalogue, stored: "not-in-the-lineup", lineup }),
    "not-in-the-lineup"
  );
  // A retired lead with no successor guests can use expects itself, so the
  // audit still reports it as not applied.
  const stranded = catalogueWith({ [ANTHROPIC_SLOT]: retired("missing-model") });
  assert.equal(expectedLeadForStored({ ...stranded, stored: ANTHROPIC_SLOT, lineup }), ANTHROPIC_SLOT);
});

test("an editor slot offers a provider the lineup is missing instead of the one that breaks the rule", () => {
  assert.deepEqual(lineupSlotProviders(["openai", "anthropic", "google"]), ["openai", "anthropic", "google"]);
  assert.deepEqual(lineupSlotProviders(["google", "openai", "anthropic"]), ["google", "openai", "anthropic"]);
  // A provider outside the rule is handed the missing one.
  assert.deepEqual(lineupSlotProviders(["openai", "mistral", "google"]), ["openai", "anthropic", "google"]);
  // A duplicate gives up both slots to the missing providers, in rule order.
  assert.deepEqual(lineupSlotProviders(["openai", "openai", "google"]), ["openai", "anthropic", "google"]);
  assert.deepEqual(lineupSlotProviders(["anthropic", "anthropic", null]), ["openai", "anthropic", "google"]);
  // Every slot names a provider of the rule, and together they are one each.
  for (const providers of [
    ["openai", "mistral", "google"],
    ["openai", "openai", "google"],
    ["anthropic", "anthropic", null],
    [null, null, null],
    ["xai", "deepseek", "mistral"],
  ]) {
    const slots = lineupSlotProviders(providers);
    assert.ok(isOnePerLineupProvider(slots), `${providers.join(",")} -> ${slots.join(",")}`);
  }
});

test("a selection's missing providers name both an absent and a doubled provider", () => {
  assert.deepEqual(missingLineupProviders(["openai", "anthropic", "google"]), []);
  assert.deepEqual(missingLineupProviders(["openai", "google", "deepseek"]), ["anthropic"]);
  assert.deepEqual(missingLineupProviders(["openai", "openai", "google"]), ["openai", "anthropic"]);
  assert.equal(isOnePerLineupProvider(["openai", "anthropic", "google"]), true);
  assert.equal(isOnePerLineupProvider(["openai", "anthropic", "google", "xai"]), false);
});
