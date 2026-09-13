import assert from "node:assert/strict";
import test from "node:test";
import {
  ADOPTION_PENDING_VALIDATIONS,
  adoptionPreflightRefusal,
  blankTokenFieldValues,
  buildAdoptionDraft,
  requestOutputCapFromProvider,
  suggestReasoning,
  isCreditFloor,
  registryIdFromApiModel,
  remainingValidations,
  suggestCreditFloor,
  WORST_CASE_INPUT_TOKENS,
} from "../lib/modelAdoptionDraft.ts";
import { resolveModelPricing } from "../lib/modelPricing.ts";
import { readFileSync } from "node:fs";
import {
  anthropicModelFromPricing,
  parseAnthropicPricingPage,
  parseOpenAiModelPage,
  parseOpenAiStandardPricingTable,
} from "../lib/providerModelDocsCore.ts";
import {
  adoptionTransitionPath,
  TERMINAL_WORK_ITEM_STATUSES,
  WORK_ITEM_STATUSES,
  workItemTransitionRefusal,
  type WorkItemStatus,
} from "../lib/modelLifecycleWorkItemCore.ts";
import {
  chatUserMaxInputTokens,
  CHAT_USER_MAX_INPUT_TOKENS_DEFAULT,
} from "../lib/chatInputLimits.ts";

test("the floor is the cheapest class that covers the worst accepted turn", () => {
  // The example worked through in lib/chatCostGuardrails.ts: US$5 in, US$25
  // out, 8,192-token cap. 128,000 x 5 + 8,192 x 25 = 844,800 micro-USD, and
  // premium's 8 credits x3 x 40,000 = 960,000 covers it.
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    maxOutputTokens: 8_192,
  });
  assert.ok(isCreditFloor(floor));
  assert.equal(floor.worstCaseMicroUsd, 844_800);
  assert.equal(floor.usageClass, "premium");
  assert.equal(floor.credits, 8);
  assert.equal(floor.inputTokens, WORST_CASE_INPUT_TOKENS);
  assert.ok(floor.coverMicroUsd >= floor.worstCaseMicroUsd);
});

test("a cheap model does not have to be sold as premium", () => {
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens: 0.1,
    outputUsdPerMillionTokens: 0.4,
    maxOutputTokens: 4_096,
  });
  assert.ok(isCreditFloor(floor));
  assert.equal(floor.usageClass, "standard");
  assert.equal(floor.credits, 1);
});

test("an unknown price produces no floor rather than a cheap one", () => {
  // The failure this prevents: an empty price field reading as free, and a
  // frontier model landing on 1 credit because nothing objected.
  for (const priced of [
    { inputUsdPerMillionTokens: null, outputUsdPerMillionTokens: 25 },
    { inputUsdPerMillionTokens: 5, outputUsdPerMillionTokens: null },
    { inputUsdPerMillionTokens: 0, outputUsdPerMillionTokens: 0 },
  ]) {
    const floor = suggestCreditFloor({ ...priced, maxOutputTokens: 8_192 });
    assert.equal(isCreditFloor(floor), false);
    assert.equal(isCreditFloor(floor) ? null : floor.reason, "price_unknown");
  }
});

test("an unknown output cap produces no floor either", () => {
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    maxOutputTokens: null,
  });
  assert.equal(isCreditFloor(floor), false);
  assert.equal(isCreditFloor(floor) ? null : floor.reason, "output_cap_unknown");
});

test("a price beyond every class is refused, not rounded up to the top one", () => {
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens: 500,
    outputUsdPerMillionTokens: 2_000,
    maxOutputTokens: 32_000,
  });
  assert.equal(isCreditFloor(floor), false);
  assert.equal(isCreditFloor(floor) ? null : floor.reason, "above_every_class");
  assert.ok((isCreditFloor(floor) ? 0 : floor.worstCaseMicroUsd ?? 0) > 0);
});

test("a registry id spells the model the way the catalogue already does", () => {
  assert.equal(registryIdFromApiModel("gpt-5.6-sol"), "gpt-5-6-sol");
  assert.equal(registryIdFromApiModel("claude-fable-5-1"), "claude-fable-5-1");
  assert.equal(registryIdFromApiModel("ZHIPU/GLM-5.3"), "zhipu-glm-5-3");
});

test("a suggested id never collides with one the registry holds", () => {
  assert.equal(
    registryIdFromApiModel("claude-fable-5-1", ["claude-fable-5-1"]),
    "claude-fable-5-1-2"
  );
  assert.equal(
    registryIdFromApiModel("claude-fable-5-1", [
      "claude-fable-5-1",
      "claude-fable-5-1-2",
    ]),
    "claude-fable-5-1-3"
  );
});

test("the draft copies what the provider said and nothing else", () => {
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: {
      displayName: "Claude Fable 5.1",
      metadata: {
        contextLength: 1_000_000,
        outputTokenLimit: 64_000,
        vision: true,
        thinking: true,
      },
    },
  });
  assert.equal(draft.fields.id, "claude-fable-5-1");
  assert.equal(draft.fields.name, "Claude Fable 5.1");
  assert.equal(draft.fields.apiModel, "claude-fable-5-1");
  assert.equal(draft.fields.contextWindowTokens, 1_000_000);
  assert.equal(draft.fields.supportsImage, true);
  assert.equal(draft.sources.contextWindowTokens, "provider_catalogue");
  // 64,000 of output plus the largest prompt still fits in 1M, so the ceiling
  // is safe as the request cap and is copied; it is also still reported.
  assert.equal(draft.fields.maxOutputTokens, 64_000);
  assert.equal(draft.sources.maxOutputTokens, "provider_catalogue");
  assert.equal(draft.observedCapabilities.providerMaxOutputTokens, 64_000);
});

test("a new model is born switched off and unlisted", () => {
  const draft = buildAdoptionDraft({ provider: "openai", apiModel: "gpt-5.7" });
  assert.equal(draft.fields.status, "coming-soon");
  assert.equal(draft.fields.publiclyListed, false);
});

test("every money and product decision is named rather than filled in", () => {
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-5.7",
    observation: { metadata: { thinking: true } },
  });
  const unknowns = draft.unknowns.join("\n");
  for (const owed of ["단가", "등급", "최소 플랜", "추론 강도"]) {
    assert.match(unknowns, new RegExp(owed), `${owed} must be named`);
  }
  // The reservation is no longer owed: a blank resolves to the policy default,
  // which the panel shows. It is named as settled instead.
  assert.match(draft.notes.join("\n"), /예약 출력/);
  // Nothing about price or sale class is proposed in the fields themselves.
  // The plan is the exception and is set to the most restrictive tier: the
  // column cannot hold "undecided", so the draft picks the value that keeps a
  // model shut rather than the one that opens it to guests.
  assert.equal("creditWeight" in draft.fields, false);
  assert.equal("usageClass" in draft.fields, false);
  assert.equal(draft.fields.minimumPlan, "Pro");
});

test("what the provider did not say is reported as missing", () => {
  const draft = buildAdoptionDraft({ provider: "openai", apiModel: "gpt-5.7" });
  assert.equal(draft.fields.contextWindowTokens, null);
  assert.equal(draft.fields.maxOutputTokens, null);
  assert.match(draft.unknowns.join("\n"), /컨텍스트 윈도우/);
  assert.match(draft.unknowns.join("\n"), /최대 출력 토큰/);
});

test("every hop an adoption walks is one the state machine allows", () => {
  // The whole point of the path: it saves clicks, not rules. A hop the machine
  // would refuse is a hop that would roll the registry row back at save time.
  for (const from of WORK_ITEM_STATUSES) {
    const path = adoptionTransitionPath(from);
    if (path === null) continue;
    let current: WorkItemStatus = from;
    for (const to of path) {
      const refusal = workItemTransitionRefusal({
        from: current,
        to,
        // The route records the decision on the `approved` hop, exactly here.
        hasDecision: to === "approved",
        pendingValidations: [],
        communicationRequired: false,
        actorEmail: "operator@tomverse.app",
      });
      assert.equal(refusal, null, `${from}: ${current} -> ${to} was refused`);
      current = to;
    }
  }
});

test("an adoption that walks anywhere ends at validation_pending", () => {
  for (const from of WORK_ITEM_STATUSES) {
    const path = adoptionTransitionPath(from);
    if (!path || path.length === 0) continue;
    assert.equal(path.at(-1), "validation_pending", from);
  }
});

test("a closed decision cannot be adopted", () => {
  for (const from of TERMINAL_WORK_ITEM_STATUSES) {
    assert.equal(adoptionTransitionPath(from), null, from);
  }
});

test("an item already past implementation keeps its place in the queue", () => {
  for (const from of [
    "validation_pending",
    "rollout_pending",
    "communication_pending",
  ] as const) {
    assert.deepEqual(adoptionTransitionPath(from), [], from);
  }
});

// Independent review, 2026-09-12. Every case below is a defect the first cut
// shipped with: the draft wrote numbers the panel was calling undecided, and
// the floor claimed to cover a turn it had not priced.

test("undecided money and limit fields are left null, never zeroed", () => {
  // A zero in a price column is not "unknown", it is an administrator override
  // that says free -- and it keeps saying it after a pricing profile lands.
  const draft = buildAdoptionDraft({ provider: "openai", apiModel: "gpt-5.7" });
  assert.equal(draft.fields.inputUsdPerMillionTokens, null);
  assert.equal(draft.fields.outputUsdPerMillionTokens, null);
  assert.equal(draft.fields.cachedInputPriceMultiplier, null);
  assert.equal(draft.fields.reservationOutputTokens, null);
});

test("a ceiling with no known context window is reported, not copied", () => {
  // Without the window there is no way to tell whether the ceiling leaves room
  // for input, and Kimi K3 is what happens when it does not.
  const draft = buildAdoptionDraft({
    provider: "moonshot",
    apiModel: "kimi-k4",
    observation: { metadata: { outputTokenLimit: 524_288 } },
  });
  assert.equal(draft.fields.maxOutputTokens, null);
  assert.equal(draft.observedCapabilities.providerMaxOutputTokens, 524_288);
  assert.match(draft.unknowns.join("\n"), /524,288/);
  assert.match(draft.unknowns.join("\n"), /컨텍스트 윈도우를 몰라/);
});

test("an unmade plan decision cannot open a model to guests", () => {
  const draft = buildAdoptionDraft({ provider: "openai", apiModel: "gpt-5.7" });
  assert.equal(draft.fields.minimumPlan, "Pro");
});

test("an absent vision field is reported rather than saved as unsupported", () => {
  const silent = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-5.7",
    observation: { metadata: { contextLength: 400_000 } },
  });
  assert.equal(silent.fields.supportsImage, false);
  assert.match(silent.unknowns.join("\n"), /이미지 입력 지원/);

  // An explicit `false` is an answer, and is not reported as missing.
  const answered = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-5.7",
    observation: { metadata: { vision: false } },
  });
  assert.doesNotMatch(answered.unknowns.join("\n"), /이미지 입력 지원/);
});

test("the floor prices the costliest input token, not the list price", () => {
  // US$5/US$25 with an 8,192 cap sits inside premium on list prices alone
  // (844,800 of 960,000 micro-USD). Every input token written to Anthropic's
  // five-minute cache costs 1.25x, and the same turn then costs 1,004,800 --
  // above what premium covers.
  const listOnly = suggestCreditFloor({
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    maxOutputTokens: 8_192,
  });
  assert.ok(isCreditFloor(listOnly));
  assert.equal(listOnly.usageClass, "premium");

  const withCacheWrite = suggestCreditFloor({
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    maxOutputTokens: 8_192,
    inputPriceMultiplier: 1.25,
  });
  assert.ok(isCreditFloor(withCacheWrite));
  assert.equal(withCacheWrite.worstCaseMicroUsd, 1_004_800);
  assert.ok(
    withCacheWrite.coverMicroUsd >= withCacheWrite.worstCaseMicroUsd,
    "the floor must cover the turn it priced"
  );
  assert.equal(withCacheWrite.usageClass, "reasoning");
});

// The refusals the adoption query parameter makes possible at all. Pure, so
// they are testable without a database -- which is where the first cut left
// them, and why the review found four of them by reading rather than running.

const adoptable = {
  id: 'wi_1',
  status: 'discovered',
  action: 'add',
  provider: 'anthropic',
  apiModel: 'claude-fable-5-1',
  modelId: null as string | null,
};

/** A saved form that would be accepted, for overriding one field at a time. */
const adoptBody = {
  id: 'claude-fable-5-1',
  apiModel: 'claude-fable-5-1',
  provider: 'anthropic',
  status: 'coming-soon',
  publiclyListed: false,
  // Priced, because an adoption that cannot compute a floor is refused. The
  // sale columns cannot hold "undecided" -- they are non-nullable -- so an
  // unpriced adoption would save one credit by default.
  usageClass: 'premium' as string,
  creditWeight: 8,
  inputUsdPerMillionTokens: 5 as number | null,
  outputUsdPerMillionTokens: 25 as number | null,
  maxOutputTokens: 8_192 as number | null,
};

test("an adoption that names a different model is refused", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: { ...adoptBody, apiModel: "gpt-other" },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /claude-fable-5-1/);
});

test("a spelling no provider returned is refused, even within the family", () => {
  // The family answers "is this the same decision". It does not answer "may we
  // send this string upstream", and only a scan can: the api model is the
  // literal identifier every request carries.
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: { ...adoptBody, apiModel: "claude-fable-5-1-20260901" },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /No catalogue scan has seen/);
});

test("a dated snapshot a scan did return may be registered", () => {
  assert.equal(
    adoptionPreflightRefusal({
      workItem: adoptable,
      body: { ...adoptBody, apiModel: "claude-fable-5-1-20260901" },
      observedPairs: [
        { provider: "anthropic", apiModel: "claude-fable-5-1" },
        { provider: "anthropic", apiModel: "claude-fable-5-1-20260901" },
      ],
    }),
    null
  );
});

test("one sighting's provider cannot carry another sighting's identifier", () => {
  // Qwen returned `ANTHROPIC/CLAUDE-FABLE-5-1`; Anthropic returned
  // `claude-fable-5-1`. Splitting the pairs apart would let a row tell Qwen to
  // serve a string it has never returned.
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: { ...adoptBody, provider: "qwen", apiModel: "claude-fable-5-1" },
    observedPairs: [
      { provider: "anthropic", apiModel: "claude-fable-5-1" },
      { provider: "qwen", apiModel: "ANTHROPIC/CLAUDE-FABLE-5-1" },
    ],
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /qwen/);
});

test("a work item already adopted cannot be adopted again", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: { ...adoptable, status: "validation_pending", modelId: "claude-fable-5-1" },
    body: { ...adoptBody },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /already adopted/);
});

test("an image generation model is not adopted into the chat registry", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: { ...adoptable, apiModel: "gpt-image-3" },
    body: { ...adoptBody, apiModel: "gpt-image-3" },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /Image Studio/);
});

test("a retirement item is not an adoption", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: { ...adoptable, action: "retire" },
    body: { ...adoptBody },
  });
  assert.equal(refusal?.status, 409);
});

test("a closed decision is refused before anything is created", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: { ...adoptable, status: "closed_no_action" },
    body: { ...adoptBody },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /new work item/);
});

test("a missing work item is a 404, not a silent plain create", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: null,
    body: { ...adoptBody },
  });
  assert.equal(refusal?.status, 404);
});

test("an adopted item owes the validations the rollout gate reads", () => {
  // `validation_pending` with an empty list is not "nothing to check", it is
  // "no check": the rollout refusal only fires on a non-empty list.
  assert.ok(ADOPTION_PENDING_VALIDATIONS.length > 0);
  assert.equal(
    workItemTransitionRefusal({
      from: "validation_pending",
      to: "rollout_pending",
      hasDecision: true,
      pendingValidations: [...ADOPTION_PENDING_VALIDATIONS],
      communicationRequired: false,
      actorEmail: "operator@tomverse.app",
    })?.code,
    "validations_outstanding"
  );
});

// Round 2 of the independent review. Each of these is a way the first set of
// fixes could still be walked around.

test("a provider no scan has seen serving this model is refused", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: { ...adoptBody, provider: "openai" },
    observedPairs: [{ provider: "anthropic", apiModel: "claude-fable-5-1" }],
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /openai/);
});

test("a second provider that does serve it is a legitimate choice", () => {
  // The same model reaching us through two catalogues is the normal case; which
  // one carries the requests is a registry decision.
  assert.equal(
    adoptionPreflightRefusal({
      workItem: adoptable,
      body: { ...adoptBody, provider: "qwen" },
      observedPairs: [
        { provider: "anthropic", apiModel: "claude-fable-5-1" },
        { provider: "qwen", apiModel: "claude-fable-5-1" },
      ],
    }),
    null
  );
});

test("a second row for a model the registry already serves is refused", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: { ...adoptBody },
    providerPairRegistered: true,
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /already serves/);
});

test("an adopted model cannot be born enabled or listed", () => {
  for (const status of ["enabled", "limited"]) {
    const refusal = adoptionPreflightRefusal({
      workItem: adoptable,
      body: { ...adoptBody, status },
    });
    assert.equal(refusal?.status, 409, status);
    assert.match(refusal!.message, /switched off/);
  }
  const listed = adoptionPreflightRefusal({
    workItem: adoptable,
    body: { ...adoptBody, publiclyListed: true },
  });
  assert.equal(listed?.status, 409);
  assert.match(listed!.message, /unlisted/);
});

test("a class below the floor is refused at the save, not just warned about", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: {
      ...adoptBody,
      usageClass: "standard",
      creditWeight: 1,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
      maxOutputTokens: 8_192,
    },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /at least 8 credits/);
});

test("a class at or above the floor is accepted", () => {
  assert.equal(
    adoptionPreflightRefusal({
      workItem: adoptable,
      body: {
        ...adoptBody,
        usageClass: "premium",
        creditWeight: 8,
        inputUsdPerMillionTokens: 5,
        outputUsdPerMillionTokens: 25,
        maxOutputTokens: 8_192,
      },
    }),
    null
  );
});

test("an item already past the state that holds validations is refused", () => {
  // Adoption files what a model still owes. An item at rollout_pending would
  // have those owed checks written behind it and could complete anyway.
  for (const status of ["validation_pending", "rollout_pending", "communication_pending"]) {
    const refusal = adoptionPreflightRefusal({
      workItem: { ...adoptable, status },
      body: { ...adoptBody },
    });
    assert.equal(refusal?.status, 409, status);
    assert.match(refusal!.message, /past the state/);
  }
});

test("the floor follows the input limit this deployment actually accepts", () => {
  // A deployment that raised CHAT_USER_MAX_INPUT_TOKENS to 200,000 was shown a
  // floor priced for 128,000, short by 14,800 micro-USD with no extra credits
  // to cover it: the multiplier stops rising above 100,000 tokens.
  const floor = suggestCreditFloor({
    inputUsdPerMillionTokens: 5,
    outputUsdPerMillionTokens: 25,
    maxOutputTokens: 8_192,
    inputPriceMultiplier: 1.25,
    worstCaseInputTokens: 200_000,
  });
  assert.ok(isCreditFloor(floor));
  assert.equal(floor.inputTokens, 200_000);
  assert.equal(floor.worstCaseMicroUsd, 1_454_800);
  assert.ok(floor.coverMicroUsd >= floor.worstCaseMicroUsd);
});

test("clearing a validation leaves the rest, and names what was not owed", () => {
  const outcome = remainingValidations(["pricing", "access", "staging"], ["pricing"]);
  assert.deepEqual(outcome.remaining, ["access", "staging"]);
  assert.deepEqual(outcome.unknown, []);

  // A typo clears nothing and says so, rather than reading as a satisfied check.
  const typo = remainingValidations(["pricing"], ["pricng"]);
  assert.deepEqual(typo.remaining, ["pricing"]);
  assert.deepEqual(typo.unknown, ["pricng"]);

  // An item that owes nothing is the state the rollout gate lets through.
  assert.deepEqual(
    remainingValidations(["pricing"], ["pricing"]).remaining,
    []
  );
});

test("an adoption with no price is refused rather than sold for one credit", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: {
      ...adoptBody,
      usageClass: "standard",
      creditWeight: 1,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
    },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /input and output prices/);
});

test("an adoption no class can cover is refused, not saved at one credit", () => {
  // The panel says "this model waits". The save has to say it too.
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: {
      ...adoptBody,
      usageClass: "standard",
      creditWeight: 1,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
      maxOutputTokens: 8_192,
    },
    worstCaseInputTokens: 400_000,
    inputPriceMultiplier: 1.25,
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /No usage class covers/);
});

test("the adoption floor reads the input limit the way the runtime does", () => {
  // `1e6` is a valid limit to the runtime and reads as 1 to parseInt. The two
  // must not disagree: a one-token worst case passes a class that covers a
  // thirtieth of the real one.
  assert.equal(chatUserMaxInputTokens({ CHAT_USER_MAX_INPUT_TOKENS: "1e6" }), 1_000_000);
  assert.equal(chatUserMaxInputTokens({ CHAT_USER_MAX_INPUT_TOKENS: "200000" }), 200_000);
  for (const invalid of ["", "0", "-5", "abc", undefined]) {
    assert.equal(
      chatUserMaxInputTokens({ CHAT_USER_MAX_INPUT_TOKENS: invalid }),
      CHAT_USER_MAX_INPUT_TOKENS_DEFAULT,
      String(invalid)
    );
  }
});

test("a model priced by a code profile keeps its columns null", () => {
  // A null price column inherits the versioned, tiered profile; a number
  // replaces it permanently and flattens both. Requiring the form's own numbers
  // would force every adopted model into an override.
  assert.equal(
    adoptionPreflightRefusal({
      workItem: adoptable,
      body: {
        ...adoptBody,
        inputUsdPerMillionTokens: null,
        outputUsdPerMillionTokens: null,
        maxOutputTokens: null,
      },
      profilePrice: {
        inputUsdPerMillionTokens: 5,
        outputUsdPerMillionTokens: 25,
        maxOutputTokens: 8_192,
      },
    }),
    null
  );
});

test("the profile's price still has to clear the floor", () => {
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: {
      ...adoptBody,
      usageClass: "standard",
      creditWeight: 1,
      inputUsdPerMillionTokens: null,
      outputUsdPerMillionTokens: null,
      maxOutputTokens: null,
    },
    profilePrice: {
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
      maxOutputTokens: 8_192,
    },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /at least 8 credits/);
});

test("the form's own price wins over the profile when both are present", () => {
  // An override is an override: if somebody typed a number, that is the number
  // the row will bill at, so it is the number the floor must cover.
  const refusal = adoptionPreflightRefusal({
    workItem: adoptable,
    body: {
      ...adoptBody,
      usageClass: "standard",
      creditWeight: 1,
      inputUsdPerMillionTokens: 5,
      outputUsdPerMillionTokens: 25,
      maxOutputTokens: 8_192,
    },
    // One credit would have cleared the profile's price. It is the typed number
    // that will bill, so it is the number the class has to cover.
    profilePrice: {
      inputUsdPerMillionTokens: 0.1,
      outputUsdPerMillionTokens: 0.4,
      maxOutputTokens: 8_192,
    },
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /at least 8 credits/);
});

test("a model with a pricing profile is told to leave its price columns empty", () => {
  // Telling an operator to type a price they already have is telling them to
  // replace the profile with a flat override for good.
  const inherited = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    hasPricingProfile: true,
  });
  assert.match(inherited.notes.join("\n"), /상속합니다/);
  assert.match(inherited.notes.join("\n"), /비워 두세요/);

  const unpriced = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
  });
  assert.match(unpriced.unknowns.join("\n"), /공식 가격표/);
  assert.doesNotMatch(
    [...unpriced.unknowns, ...unpriced.notes].join("\n"),
    /상속합니다/
  );
});

test("an inherited price is a settled note, not an open question", () => {
  // The two lists ask for opposite actions. A "leave this alone" line filed
  // under "still to decide" is an instruction to act on it.
  const inherited = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    hasPricingProfile: true,
  });
  assert.match(inherited.notes.join("\n"), /상속합니다/);
  assert.doesNotMatch(inherited.unknowns.join("\n"), /상속합니다/);
  // ...and the class line stops telling them to enter a price they are not
  // going to enter.
  assert.match(inherited.unknowns.join("\n"), /상속 가격으로 계산/);
  assert.doesNotMatch(inherited.unknowns.join("\n"), /가격을 넣으면/);

  const unpriced = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
  });
  assert.doesNotMatch(unpriced.notes.join("\n"), /단가/);
  assert.match(unpriced.unknowns.join("\n"), /가격을 넣으면/);
});

test("the pair being saved is the one judged servable", () => {
  // The panel already printed the lifecycle and the triage already read
  // "조치 비권장", but neither stopped a save: the row said do not adopt this
  // and the button adopted it anyway. The server is the side that decides.
  const refusal = adoptionPreflightRefusal({
    workItem: { ...adoptable },
    body: { ...adoptBody },
    submittedPairUnservable: true,
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /not servable/);
  // Names the other way out, because on a mixed item there is one.
  assert.match(refusal!.message, /adopt that pair instead/);
});

test("a live pair on an item another provider has switched off is adoptable", () => {
  // A registry row carries one (provider, apiModel) and the runtime sends
  // requests to exactly that pair -- it does not fall through to whichever
  // provider still lists the model. So the question is about the pair, not
  // about the work item, and asking it of the item gets both halves wrong.
  assert.equal(
    adoptionPreflightRefusal({
      workItem: { ...adoptable },
      body: { ...adoptBody },
      submittedPairUnservable: false,
    }),
    null
  );
});

// Prefill from what the provider already sends, 2026-09-13. A staging adoption
// of Claude Fable 5.1 came back with Native PDF, reasoning and the output cap
// all empty although the scan held every one of them.

test("the output ceiling becomes the request cap only when input still fits", () => {
  // Claude Fable 5.1: 128,000 out plus the largest prompt is well inside 1M.
  assert.deepEqual(
    requestOutputCapFromProvider({
      providerMaxOutputTokens: 128_000,
      contextWindowTokens: 1_000_000,
      worstCaseInputTokens: 128_000,
    }),
    { value: 128_000, reason: "fits_with_worst_case_input" }
  );
  // Kimi K3: the ceiling is the whole window. As a request cap it left no room
  // for input and every request was refused -- the incident the guard encodes.
  assert.deepEqual(
    requestOutputCapFromProvider({
      providerMaxOutputTokens: 262_144,
      contextWindowTokens: 262_144,
      worstCaseInputTokens: 128_000,
    }),
    { value: null, reason: "leaves_no_room_for_input" }
  );
});

test("an exact fit is a fit", () => {
  assert.equal(
    requestOutputCapFromProvider({
      providerMaxOutputTokens: 72_000,
      contextWindowTokens: 200_000,
      worstCaseInputTokens: 128_000,
    }).value,
    72_000
  );
});

test("without a ceiling or a window there is nothing to copy", () => {
  assert.equal(
    requestOutputCapFromProvider({
      providerMaxOutputTokens: null,
      contextWindowTokens: 1_000_000,
      worstCaseInputTokens: 128_000,
    }).reason,
    "no_provider_capability"
  );
  assert.equal(
    requestOutputCapFromProvider({
      providerMaxOutputTokens: 64_000,
      contextWindowTokens: null,
      worstCaseInputTokens: 128_000,
    }).reason,
    "no_context_window"
  );
});

test("the guard prices the prompt this deployment actually accepts", () => {
  // A deployment that raised CHAT_USER_MAX_INPUT_TOKENS to 1M has no room left
  // in Fable 5.1's window for 128,000 of output, and the draft must know it.
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    worstCaseInputTokens: 1_000_000,
    observation: { metadata: { contextLength: 1_000_000, outputTokenLimit: 128_000 } },
  });
  assert.equal(draft.fields.maxOutputTokens, null);
  assert.match(draft.unknowns.join("\n"), /입력 자리가 남지 않습니다/);
});

test("a model a profile already covers inherits its cap instead", () => {
  // A null column follows the profile; a copied number would override it for
  // good, even when the profile later changes.
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    hasPricingProfile: true,
    observation: { metadata: { contextLength: 1_000_000, outputTokenLimit: 128_000 } },
  });
  assert.equal(draft.fields.maxOutputTokens, null);
  assert.match(draft.notes.join("\n"), /상한을 상속합니다/);
});

test("a copied cap is said out loud, with the arithmetic that allowed it", () => {
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: { metadata: { contextLength: 1_000_000, outputTokenLimit: 128_000 } },
  });
  assert.equal(draft.fields.maxOutputTokens, 128_000);
  const notes = draft.notes.join("\n");
  assert.match(notes, /128,000을 채웠습니다/);
  assert.match(notes, /1,000,000/);
  // ...and that blank is not an option: without a profile the save needs a cap.
  assert.match(notes, /비우면 저장되지 않습니다/);
});

test("Native PDF follows the provider, and silence is not a no", () => {
  const said = (pdfInput: boolean | null) =>
    buildAdoptionDraft({
      provider: "anthropic",
      apiModel: "claude-fable-5-1",
      observation: { metadata: { pdfInput } },
    });
  assert.equal(said(true).fields.supportsNativePdf, true);
  assert.equal(said(true).sources.supportsNativePdf, "provider_catalogue");
  assert.equal(said(false).fields.supportsNativePdf, false);
  assert.doesNotMatch(said(false).unknowns.join("\n"), /Native PDF/);
  assert.equal(said(null).fields.supportsNativePdf, false);
  assert.match(said(null).unknowns.join("\n"), /Native PDF/);
});

test("reasoning is proposed at the deepest level the provider accepts", () => {
  assert.equal(
    suggestReasoning({ thinking: true, effortLevels: "high,low,medium,xhigh" }).value,
    "high"
  );
  // Anthropic sends this value as `effort`. Proposing a level the model does
  // not list is proposing a request that fails.
  assert.equal(suggestReasoning({ thinking: true, effortLevels: "low,medium" }).value, "medium");
  assert.equal(suggestReasoning({ thinking: true }).value, "high");
  assert.equal(suggestReasoning({ thinking: false, effortLevels: "high" }).value, null);
  assert.equal(suggestReasoning({}).value, null);
});

test("levels the registry cannot hold propose nothing, and say so", () => {
  assert.equal(suggestReasoning({ thinking: true, effortLevels: "xhigh,max" }).value, null);
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: { metadata: { thinking: true, effortLevels: "xhigh,max" } },
  });
  assert.equal(draft.fields.reasoning, "none");
  assert.equal(draft.suggestions.reasoning, null);
  assert.match(draft.unknowns.join("\n"), /겹치지 않아 제안하지 않았습니다/);
});

test("a proposed reasoning value is marked as one the save must confirm", () => {
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: { metadata: { thinking: true, effortLevels: "high,low,medium" } },
  });
  assert.equal(draft.fields.reasoning, "high");
  assert.equal(draft.suggestions.reasoning, "high");
  assert.equal(draft.sources.reasoning, "needs_decision");
  assert.match(draft.unknowns.join("\n"), /확정해야 저장됩니다/);

  const plain = buildAdoptionDraft({ provider: "openai", apiModel: "gpt-6-astra" });
  assert.equal(plain.fields.reasoning, "none");
  assert.equal(plain.suggestions.reasoning, null);
});

test("the reservation is shown as a policy default, never written", () => {
  // A blank reservation already resolves to the profile's or the class's
  // conservative default. Writing that number would leave a fossil that stops
  // following the policy -- the failure this repository has met in exactly
  // these columns.
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: { metadata: { contextLength: 1_000_000, outputTokenLimit: 128_000 } },
  });
  assert.equal(draft.fields.reservationOutputTokens, null);
  assert.equal(draft.sources.reservationOutputTokens, "derived");
  assert.match(draft.notes.join("\n"), /예약 출력 토큰 — 비워 두면/);
});

// Independent review, 2026-09-13, round 1.

test("an input limit used as the window can only make the guard stricter", () => {
  // Anthropic publishes max_input_tokens and no total. The largest accepted
  // input has to fit inside the real window, so the input limit is a lower
  // bound on it: a cap that fits against the bound fits against the window.
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: { metadata: { inputTokenLimit: 1_000_000, outputTokenLimit: 128_000 } },
  });
  assert.equal(draft.fields.maxOutputTokens, 128_000);

  // And the bound still refuses what does not fit under it.
  const tight = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-tight",
    observation: { metadata: { inputTokenLimit: 200_000, outputTokenLimit: 128_000 } },
  });
  assert.equal(tight.fields.maxOutputTokens, null);
});

test("a blank cap without a profile is shown as required, not as a default", () => {
  // The preflight refuses a blank cap when no profile covers the model. A
  // greyed-in class fallback there described a save that cannot happen.
  const blank = blankTokenFieldValues({
    hasPricingProfile: false,
    formMaxOutputTokens: null,
    effective: { maxOutputTokens: 8_192, reservationBeforeCap: 4_096 },
  });
  assert.equal(blank.maxOutputTokens, "required");
  assert.equal(blank.reservationOutputTokens, 4_096);

  const inherited = blankTokenFieldValues({
    hasPricingProfile: true,
    formMaxOutputTokens: null,
    effective: { maxOutputTokens: 128_000, reservationBeforeCap: 8_192 },
  });
  assert.equal(inherited.maxOutputTokens, 128_000);
});

test("while the profile is unknown the cap field makes no claim either way", () => {
  // Round 2: a pending or failed lookup was read as "no profile" and the field
  // said required, although the id might be one a profile covers, where blank
  // is exactly right.
  assert.equal(
    blankTokenFieldValues({
      hasPricingProfile: null,
      formMaxOutputTokens: null,
      effective: null,
    }).maxOutputTokens,
    null
  );
});

test("the reservation hint is clamped to the typed cap, from the unclamped figure", () => {
  // The review's case: a per-model override reserves 8,192 under a default cap
  // of 4,096. Blank, it saves 4,096; with 16,000 typed, it saves 8,192.
  const effective = { maxOutputTokens: 4_096, reservationBeforeCap: 8_192 };
  assert.equal(
    blankTokenFieldValues({ hasPricingProfile: true, formMaxOutputTokens: null, effective })
      .reservationOutputTokens,
    4_096
  );
  assert.equal(
    blankTokenFieldValues({ hasPricingProfile: true, formMaxOutputTokens: 16_000, effective })
      .reservationOutputTokens,
    8_192
  );
  assert.equal(
    blankTokenFieldValues({ hasPricingProfile: true, formMaxOutputTokens: 2_000, effective })
      .reservationOutputTokens,
    2_000
  );
});

test("lifting the cap is how the route reads the reservation before the clamp", () => {
  // The route resolves twice through the live resolver rather than restating
  // its chain; this pins that the second call really returns the unclamped
  // figure, env override included, and that the saved result matches.
  const keys = [
    "CHAT_MODEL_DRAFT_MODEL_MAX_OUTPUT_TOKENS",
    "CHAT_MODEL_DRAFT_MODEL_RESERVATION_OUTPUT_TOKENS",
  ];
  const previous = keys.map((key) => process.env[key]);
  process.env[keys[0]] = "4096";
  process.env[keys[1]] = "8192";
  try {
    const base = {
      id: "draft-model",
      apiModel: "draft-model",
      provider: "openai" as const,
      usageClass: "premium" as const,
    };
    assert.equal(resolveModelPricing(base).reservationOutputTokens, 4_096);
    assert.equal(
      resolveModelPricing({ ...base, maxOutputTokens: Number.MAX_SAFE_INTEGER })
        .reservationOutputTokens,
      8_192
    );
    // What a save with 16,000 typed and the reservation blank resolves to.
    assert.equal(
      resolveModelPricing({ ...base, maxOutputTokens: 16_000 }).reservationOutputTokens,
      8_192
    );
  } finally {
    keys.forEach((key, index) => {
      if (previous[index] === undefined) delete process.env[key];
      else process.env[key] = previous[index];
    });
  }
});

// Documentation evidence, 2026-09-13. The two models the staging adoption was
// tested on, read from the pages their providers served that day.

const docFixture = (name: string) =>
  readFileSync(new URL(`./fixtures/providerModelDocs/${name}`, import.meta.url), "utf8");
const readAt = new Date("2026-09-13T01:00:00Z");
const astraEvidence = {
  parse: parseOpenAiModelPage({
    apiModel: "gpt-6-astra",
    modelPage: docFixture("openai-model-gpt-6-astra-2026-09-13.md"),
    pricingTable: parseOpenAiStandardPricingTable(docFixture("openai-pricing-2026-09-13.md")),
  }),
  sources: [
    { url: "https://developers.openai.com/api/docs/models/gpt-6-astra.md", digest: "b".repeat(64) },
    { url: "https://developers.openai.com/api/docs/pricing.md", digest: "c".repeat(64) },
  ],
  fetchedAt: readAt,
};
const fableEvidence = {
  parse: anthropicModelFromPricing(
    parseAnthropicPricingPage(docFixture("anthropic-pricing-2026-09-13.md")),
    "Claude Fable 5.1"
  ),
  sources: [{ url: "https://platform.claude.com/docs/en/about-claude/pricing.md", digest: "d".repeat(64) }],
  fetchedAt: readAt,
};
const draftNow = new Date("2026-09-13T06:00:00Z");

test("GPT-6 Astra: what OpenAI's models API left empty comes from its model page", () => {
  // OpenAI's /v1/models gives { id, owned_by } and nothing else.
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { displayName: null, metadata: {} },
    docEvidence: astraEvidence,
    now: draftNow,
  });
  assert.equal(draft.fields.contextWindowTokens, 1_050_000);
  assert.equal(draft.sources.contextWindowTokens, "provider_docs");
  assert.equal(draft.fields.supportsImage, true);
  assert.equal(draft.sources.supportsImage, "provider_docs");
  // The documented ceiling runs through the same guard as an API one:
  // 128,000 + 128,000 fits in 1,050,000.
  assert.equal(draft.fields.maxOutputTokens, 128_000);
  assert.equal(draft.sources.maxOutputTokens, "provider_docs");
  assert.match(draft.notes.join("\n"), /developers\.openai\.com.*2026-09-13 조회/);
});

test("GPT-6 Astra: a tiered price is named and proposed as a profile, never prefilled", () => {
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { metadata: {} },
    docEvidence: astraEvidence,
    now: draftNow,
  });
  assert.equal(draft.fields.inputUsdPerMillionTokens, null);
  assert.equal(draft.fields.outputUsdPerMillionTokens, null);
  const unknowns = draft.unknowns.join("\n");
  assert.match(unknowns, /장문 구간 가격이 있어 채우지 않았습니다/);
  assert.match(unknowns, /272,000 입력 토큰 초과 시 입력 2배, 출력 1\.5배/);
  assert.ok(draft.pricingProfileProposal);
  assert.match(draft.pricingProfileProposal, /modelId: "gpt-6-astra"/);
});

test("Claude Fable 5.1: a flat documented price is prefilled with where it came from", () => {
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: {
      displayName: "Claude Fable 5.1",
      metadata: { inputTokenLimit: 1_000_000, outputTokenLimit: 128_000, vision: true, pdfInput: true },
    },
    docEvidence: fableEvidence,
    now: draftNow,
  });
  assert.equal(draft.fields.inputUsdPerMillionTokens, 10);
  assert.equal(draft.fields.outputUsdPerMillionTokens, 50);
  assert.equal(draft.fields.cachedInputPriceMultiplier, 0.025);
  assert.equal(draft.sources.inputUsdPerMillionTokens, "provider_docs");
  assert.match(draft.notes.join("\n"), /US\$10 \/ US\$50, 캐시 입력 배수 0\.025/);
  // Saying out loud that it is an override and still owes a pricing check.
  assert.match(draft.notes.join("\n"), /관리자 override/);
  // The API's own numbers are not replaced by the page.
  assert.equal(draft.sources.contextWindowTokens, "provider_catalogue");
});

test("documentation never prices a model a profile already covers", () => {
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    hasPricingProfile: true,
    observation: { displayName: "Claude Fable 5.1", metadata: { inputTokenLimit: 1_000_000 } },
    docEvidence: fableEvidence,
    now: draftNow,
  });
  assert.equal(draft.fields.inputUsdPerMillionTokens, null);
  assert.equal(draft.pricingProfileProposal, null);
});

test("where the API and the page disagree, the API is kept and the difference named", () => {
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { metadata: { contextLength: 400_000 } },
    docEvidence: astraEvidence,
    now: draftNow,
  });
  assert.equal(draft.fields.contextWindowTokens, 400_000);
  assert.match(draft.unknowns.join("\n"), /API는 400,000, 문서는 1,050,000/);
});

test("no evidence leaves the draft as it was", () => {
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { metadata: {} },
  });
  assert.equal(draft.fields.contextWindowTokens, null);
  assert.equal(draft.fields.inputUsdPerMillionTokens, null);
  assert.equal(draft.pricingProfileProposal, null);
  assert.match(draft.unknowns.join("\n"), /공급자 문서에서 읽은 가격이 없습니다/);
});

// Independent review, 2026-09-13, round 1 (step 2).

test("evidence older than a day and a half fills nothing at all", () => {
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { metadata: {} },
    docEvidence: astraEvidence,
    now: new Date("2026-09-20T00:00:00Z"),
  });
  assert.equal(draft.fields.contextWindowTokens, null);
  assert.equal(draft.fields.maxOutputTokens, null);
  assert.equal(draft.pricingProfileProposal, null);
  assert.match(draft.unknowns.join("\n"), /2026-09-13에 읽은 증거라 어떤 값도 채우지 않았습니다/);
});

test("an API that disagrees with the page on the output ceiling or image input is named", () => {
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { metadata: { outputTokenLimit: 64_000, vision: false } },
    docEvidence: astraEvidence,
    now: draftNow,
  });
  const unknowns = draft.unknowns.join("\n");
  assert.match(unknowns, /최대 출력 상한 — 공급자 API는 64,000, 문서는 128,000/);
  assert.match(unknowns, /이미지 입력 지원 — 공급자 API는 미지원, 문서는 지원/);
  assert.equal(draft.fields.supportsImage, false);
});

test("the profile proposal takes the guarded cap, not the documented ceiling", () => {
  // A context window too small for the documented ceiling plus the largest
  // prompt: the form refuses to copy the cap, and so must the proposal.
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { metadata: { contextLength: 200_000 } },
    docEvidence: astraEvidence,
    now: draftNow,
  });
  assert.equal(draft.fields.maxOutputTokens, null);
  assert.match(draft.pricingProfileProposal ?? "", /maxOutputTokens: MAX_OUTPUT_TOKENS_TO_DECIDE/);
});

test("the profile proposal is keyed on the registry id being saved", () => {
  // Review round 2: correcting the id left the proposal under the suggested
  // one, and committing it would have priced a model nobody saves.
  const draft = buildAdoptionDraft({
    provider: "openai",
    apiModel: "gpt-6-astra",
    observation: { metadata: {} },
    docEvidence: astraEvidence,
    now: draftNow,
    registryModelId: "astra-enterprise",
  });
  assert.match(draft.pricingProfileProposal ?? "", /modelId: "astra-enterprise"/);
});

test("documented prices are marked as needing confirmation", () => {
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: { displayName: "Claude Fable 5.1", metadata: { inputTokenLimit: 1_000_000, outputTokenLimit: 128_000 } },
    docEvidence: fableEvidence,
    now: draftNow,
  });
  assert.equal(draft.suggestions.price, true);
  const plain = buildAdoptionDraft({ provider: "openai", apiModel: "gpt-6-astra", observation: { metadata: {} } });
  assert.equal(plain.suggestions.price, false);
});

test("a profile under this id for a different model is refused, not inherited", () => {
  // Round 4: prices resolve by registry id alone, so a profile for another
  // provider or api model under the same id would bill this model at its price.
  const other = { provider: "openai", apiModelId: "gpt-5.5" };
  const draft = buildAdoptionDraft({
    provider: "anthropic",
    apiModel: "claude-fable-5-1",
    observation: { metadata: {} },
    profileForOtherPair: other,
  });
  assert.match(draft.unknowns.join("\n"), /다른 모델\(openai \/ gpt-5\.5\)의 것입니다/);
  const refusal = adoptionPreflightRefusal({
    workItem: { ...adoptable },
    body: { ...adoptBody },
    profileForOtherPair: other,
  });
  assert.equal(refusal?.status, 409);
  assert.match(refusal!.message, /Save it under a different id/);
});
