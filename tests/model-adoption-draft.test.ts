import assert from "node:assert/strict";
import test from "node:test";
import {
  ADOPTION_PENDING_VALIDATIONS,
  adoptionPreflightRefusal,
  buildAdoptionDraft,
  isCreditFloor,
  registryIdFromApiModel,
  remainingValidations,
  suggestCreditFloor,
  WORST_CASE_INPUT_TOKENS,
} from "../lib/modelAdoptionDraft.ts";
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
  // The output ceiling is a capability, and is reported rather than written.
  assert.equal(draft.fields.maxOutputTokens, null);
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
  for (const owed of ["단가", "등급", "최소 플랜", "예약 출력", "추론 강도"]) {
    assert.match(unknowns, new RegExp(owed), `${owed} must be named`);
  }
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

test("the provider's output ceiling is reported, never copied into the request cap", () => {
  // Kimi K3: the ceiling is the whole context window, and using it as every
  // request's output cap left no room for input at all.
  const draft = buildAdoptionDraft({
    provider: "moonshot",
    apiModel: "kimi-k4",
    observation: { metadata: { outputTokenLimit: 524_288 } },
  });
  assert.equal(draft.fields.maxOutputTokens, null);
  assert.equal(draft.observedCapabilities.providerMaxOutputTokens, 524_288);
  assert.match(draft.unknowns.join("\n"), /524,288/);
  assert.match(draft.unknowns.join("\n"), /별개 결정/);
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
