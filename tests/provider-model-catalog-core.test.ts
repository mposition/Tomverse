import assert from "node:assert/strict";
import test from "node:test";
import {
  AUTO_DISABLE_REASON,
  catalogNextCursor,
  foreignProductSurfaceId,
  isLikelyChatModelId,
  isReviewableProviderModelId,
  missingConfirmationRuns,
  parseProviderCatalogResponse,
  providerReportedUnservable,
  planCatalogReconciliation,
  providerCatalogHttpFailure,
  providerCatalogUrl,
  PROVIDER_CATALOG_KEY_REJECTED,
  shouldQueueProviderCatalogObservation,
} from "../lib/providerModelCatalogCore.ts";
import {
  AI_PROVIDERS,
  PROVIDER_API_CONFIGURATION,
  PROVIDER_API_KEY_ENV_NAMES,
} from "../lib/modelRegistryShared.ts";

test("parses chat and image generation models but excludes unsupported products", () => {
  assert.deepEqual(
    parseProviderCatalogResponse("openai", {
      data: [
        { id: "gpt-5.5", owned_by: "openai" },
        { id: "gpt-image-2", owned_by: "openai" },
        { id: "dall-e-3", owned_by: "openai" },
        { id: "text-embedding-4-large", owned_by: "openai" },
        { id: "whisper-2", owned_by: "openai" },
      ],
    }).map((model) => model.id),
    ["gpt-5.5", "gpt-image-2", "dall-e-3"]
  );
});

test("classifies image generation separately from chat eligibility", () => {
  assert.equal(isLikelyChatModelId("openai", "gpt-image-2"), false);
  assert.equal(isReviewableProviderModelId("openai", "gpt-image-2"), true);
  assert.equal(isReviewableProviderModelId("openai", "text-embedding-4-large"), false);
});

test("treats provider aliases as available model IDs", () => {
  const models = parseProviderCatalogResponse("xai", {
    models: [{ id: "grok-4.5-20260701", aliases: ["grok-4.5"] }],
  });
  assert.deepEqual(
    models.map((model) => model.id),
    ["grok-4.5-20260701", "grok-4.5"]
  );
  assert.equal(models[1].metadata.aliasOf, "grok-4.5-20260701");
});

test("uses Gemini base model IDs and only keeps generateContent models", () => {
  const models = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-3.5-flash-001",
        baseModelId: "gemini-3.5-flash",
        displayName: "Gemini 3.5 Flash",
        supportedGenerationMethods: ["generateContent"],
        stage: "STABLE",
      },
      {
        name: "models/gemini-embedding-002",
        supportedGenerationMethods: ["embedContent"],
      },
    ],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "gemini-3.5-flash");
  assert.equal(models[0].displayName, "Gemini 3.5 Flash");
});

test("keeps Google image models whose endpoint method is not generateContent", () => {
  const models = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/imagen-5.0-generate-001",
        baseModelId: "imagen-5.0-generate-001",
        supportedGenerationMethods: ["predict"],
      },
    ],
  });
  assert.equal(models.length, 1);
  assert.equal(models[0].id, "imagen-5.0-generate-001");
  assert.equal(models[0].metadata.product, "image_generation");
});

test("keeps prerelease observations as evidence but excludes them from review", () => {
  const models = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-4-pro",
        baseModelId: "gemini-4-pro",
        supportedGenerationMethods: ["generateContent"],
        stage: "PUBLIC_PREVIEW",
      },
      {
        name: "models/gemini-4-flash",
        baseModelId: "gemini-4-flash",
        supportedGenerationMethods: ["generateContent"],
        stage: "STABLE",
      },
      {
        name: "models/imagen-6-beta",
        baseModelId: "imagen-6-beta",
        supportedGenerationMethods: ["predict"],
      },
    ],
  });

  assert.deepEqual(
    models.map((model) => ({
      id: model.id,
      prerelease: model.prerelease,
      queued: shouldQueueProviderCatalogObservation(model),
    })),
    [
      { id: "gemini-4-pro", prerelease: true, queued: false },
      { id: "gemini-4-flash", prerelease: false, queued: true },
      { id: "imagen-6-beta", prerelease: true, queued: false },
    ]
  );
  assert.equal(models[0].metadata.releaseStage, "PUBLIC_PREVIEW");
});

test("preserves the exact 2026-08-01 provider API model strings", () => {
  const openaiCompatible = [
    ["openai", "gpt-5.6-sol"],
    ["xai", "grok-4.3"],
    ["deepseek", "deepseek-v4-flash"],
    ["mistral", "mistral-medium-3-5"],
  ] as const;

  for (const [provider, apiModel] of openaiCompatible) {
    const response =
      provider === "mistral"
        ? [{ id: apiModel, capabilities: { completion_chat: true } }]
        : { data: [{ id: apiModel }] };
    const parsed = parseProviderCatalogResponse(provider, response);
    assert.equal(parsed.some((entry) => entry.id === apiModel), true, provider);
  }

  const google = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-3.6-flash",
        baseModelId: "gemini-3.6-flash",
        supportedGenerationMethods: ["generateContent"],
      },
      {
        name: "models/gemini-3.5-flash-lite",
        baseModelId: "gemini-3.5-flash-lite",
        supportedGenerationMethods: ["generateContent"],
      },
    ],
  });
  assert.deepEqual(
    google.map((entry) => entry.id),
    ["gemini-3.6-flash", "gemini-3.5-flash-lite"]
  );
});

test("marks explicit legacy and archived lifecycle states unavailable", () => {
  const google = parseProviderCatalogResponse("google", {
    models: [
      {
        name: "models/gemini-old",
        supportedGenerationMethods: ["generateContent"],
        stage: "LEGACY",
      },
    ],
  });
  const mistral = parseProviderCatalogResponse("mistral", [
    {
      id: "mistral-old",
      archived: true,
      capabilities: { completion_chat: true },
    },
  ]);
  assert.deepEqual(
    [google[0].lifecycle, google[0].available, mistral[0].lifecycle],
    ["legacy", false, "archived"]
  );
});

test("treats an OpenAI shutdown date as lifecycle evidence", () => {
  const [model] = parseProviderCatalogResponse("openai", {
    data: [
      {
        id: "gpt-4-historical",
        shutdown_date: 1_788_134_400,
      },
    ],
  });
  assert.equal(model.lifecycle, "shutdown_scheduled");
  assert.equal(model.available, false);
  assert.equal(model.metadata.shutdownDate, 1_788_134_400);
});

test("supports provider pagination cursors without accepting arbitrary values", () => {
  assert.equal(catalogNextCursor("google", { nextPageToken: "page-2" }), "page-2");
  assert.equal(
    catalogNextCursor("anthropic", { has_more: true, last_id: "claude-last" }),
    "claude-last"
  );
  assert.equal(
    catalogNextCursor("anthropic", { has_more: false, last_id: "ignored" }),
    null
  );
});

test("requires at least two successful missing scans before likely deprecation", () => {
  assert.equal(missingConfirmationRuns(undefined), 2);
  assert.equal(missingConfirmationRuns("1"), 2);
  assert.equal(missingConfirmationRuns("4"), 4);
  assert.equal(missingConfirmationRuns("99"), 2);
  assert.equal(isLikelyChatModelId("groq", "whisper-large-v3"), false);
  assert.equal(isLikelyChatModelId("groq", "llama-4-scout"), true);
});

// Reconciliation planning. The scenario these are written against is the real
// one: groq's llama-4-scout went missing from successful catalog scans on
// 2026-07-21, reached seven consecutive misses, and stayed enabled and
// user-selectable for six days because nothing consumed that signal.

const groqRegistry = [
  { id: "llama-3-1", apiModel: "llama-3.1-8b-instant", enabled: true, operationalReason: null },
  { id: "llama-3-3", apiModel: "llama-3.3-70b-versatile", enabled: true, operationalReason: null },
  { id: "llama-4-scout", apiModel: "meta-llama/llama-4-scout-17b-16e-instruct", enabled: true, operationalReason: null },
];

const groqCheck = (overrides = {}) => ({
  provider: "groq" as const,
  status: "checked" as const,
  missing: [],
  mapped: [],
  ...overrides,
});

test("plans a disable once a model clears the confirmation threshold", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: [
        {
          modelId: "llama-4-scout",
          apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
          consecutiveMissing: 7,
        },
      ],
      mapped: ["llama-3-1", "llama-3-3"],
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(
    plan.disable.map((item) => item.modelId),
    ["llama-4-scout"]
  );
  assert.deepEqual(plan.hold, []);
  assert.deepEqual(plan.restore, []);
});

test("leaves a model alone until the confirmation threshold is reached", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: [
        {
          modelId: "llama-4-scout",
          apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
          consecutiveMissing: 2,
        },
      ],
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(plan.disable, []);
});

test("acts on nothing when the provider check did not complete", () => {
  for (const status of ["failed", "skipped"] as const) {
    const plan = planCatalogReconciliation({
      check: groqCheck({
        status,
        missing: [
          {
            modelId: "llama-4-scout",
            apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
            consecutiveMissing: 99,
          },
        ],
      }),
      registry: groqRegistry,
      confirmationRuns: 3,
    });
    assert.deepEqual(plan.disable, [], `${status} must not disable anything`);
  }
});

test("refuses to disable a provider's entire enabled lineup in one run", () => {
  // Indistinguishable from a truncated catalog response, and only one of the
  // two readings should take a whole provider offline.
  const plan = planCatalogReconciliation({
    check: groqCheck({
      missing: groqRegistry.map((row) => ({
        modelId: row.id,
        apiModel: row.apiModel,
        consecutiveMissing: 9,
      })),
    }),
    registry: groqRegistry,
    confirmationRuns: 3,
  });
  assert.deepEqual(plan.disable, []);
  assert.equal(plan.hold.length, 1);
  assert.equal(plan.hold[0].reason, "would_disable_every_enabled_model");
  assert.deepEqual(plan.hold[0].modelIds.sort(), ["llama-3-1", "llama-3-3", "llama-4-scout"]);
});

test("restores only what this automation disabled", () => {
  const plan = planCatalogReconciliation({
    check: groqCheck({ mapped: ["llama-3-1", "llama-4-scout"] }),
    registry: [
      {
        id: "llama-3-1",
        apiModel: "llama-3.1-8b-instant",
        enabled: false,
        operationalReason: "Disabled by an operator pending a billing review.",
      },
      {
        id: "llama-4-scout",
        apiModel: "meta-llama/llama-4-scout-17b-16e-instruct",
        enabled: false,
        operationalReason: `${AUTO_DISABLE_REASON} Missing from 7 consecutive scans.`,
      },
    ],
    confirmationRuns: 3,
  });
  assert.deepEqual(
    plan.restore.map((item) => item.modelId),
    ["llama-4-scout"]
  );
});

/**
 * The regression these guard: the catalogue path used to be derived with a
 * two-provider special case and `models` for everyone else, which is only
 * correct when the base URL already ends in the version segment. Anthropic's
 * does not, so the monitor asked `https://api.anthropic.com/models` and got a
 * 404 every scan for a month. A 404 reads as "the provider dropped this
 * endpoint" rather than "we built the wrong URL", so nothing looked wrong.
 *
 * Every provider is pinned, not just Anthropic: the next base URL added with
 * no version segment has to fail here rather than in production.
 */
test("each provider's catalogue URL is the one that provider actually serves", () => {
  assert.deepEqual(
    Object.fromEntries(
      AI_PROVIDERS.map((provider) => [
        provider,
        providerCatalogUrl(provider, null).toString(),
      ])
    ),
    {
      openai: "https://api.openai.com/v1/models",
      anthropic: "https://api.anthropic.com/v1/models?limit=1000",
      google:
        "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000",
      groq: "https://api.groq.com/openai/v1/models",
      xai: "https://api.x.ai/v1/language-models",
      deepseek: "https://api.deepseek.com/models",
      mistral: "https://api.mistral.ai/v1/models",
      moonshot: "https://api.moonshot.ai/v1/models",
      minimax: "https://api.minimax.io/anthropic/v1/models?limit=1000",
      qwen: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1/models",
      zhipu: "https://api.z.ai/api/paas/v4/models",
      perplexity: "https://api.perplexity.ai/v1/models",
    }
  );
});

test("a catalogue URL never leaves its provider's configured base URL", () => {
  for (const provider of AI_PROVIDERS) {
    const base = new URL(PROVIDER_API_CONFIGURATION[provider].baseUrl);
    const url = providerCatalogUrl(provider, "cursor-value");
    assert.equal(url.origin, base.origin, provider);
    assert.ok(url.pathname.startsWith(base.pathname.replace(/\/$/, "")), provider);
  }
});

test("only the paginating providers carry a cursor, each in its own parameter", () => {
  assert.equal(
    providerCatalogUrl("anthropic", "model_123").searchParams.get("after_id"),
    "model_123"
  );
  assert.equal(
    providerCatalogUrl("minimax", "model_123").searchParams.get("after_id"),
    "model_123"
  );
  assert.equal(
    providerCatalogUrl("google", "page_2").searchParams.get("pageToken"),
    "page_2"
  );
  // An OpenAI-compatible list is a single response; a cursor would be a
  // parameter the provider ignores at best.
  assert.equal(
    providerCatalogUrl("openai", "page_2").search,
    ""
  );
});

// A refused credential is not a catalogue failure. Perplexity's model cycle
// reported `failed (PROVIDER_MODEL_CATALOG_HTTP_401)` while every Sonar chat
// turn was failing on the same key, and the status code said none of that.

test("a rejected credential is classified apart from every other HTTP failure", () => {
  for (const status of [401, 403]) {
    const failure = providerCatalogHttpFailure("perplexity", status);
    assert.equal(failure.code, PROVIDER_CATALOG_KEY_REJECTED);
    // The status is kept in the detail: an operator checking the claim needs
    // to know which of the two it was.
    assert.match(failure.detail, new RegExp(`HTTP ${status}`));
  }
});

test("every other failing status keeps the status in its code", () => {
  // 404 in particular has to stay distinguishable: it is the shape a dropped
  // endpoint takes, and a month of them is what put `v1/models` in
  // CATALOG_PATHS.
  for (const status of [404, 429, 500, 503]) {
    assert.equal(
      providerCatalogHttpFailure("anthropic", status).code,
      `PROVIDER_MODEL_CATALOG_HTTP_${status}`
    );
  }
});

test("a rejected credential names every accepted spelling of its key", () => {
  // Same reason PROVIDER_MODEL_CATALOG_KEY_MISSING does it: an operator sent
  // to the canonical variable rotates one the deployment is not reading.
  for (const provider of AI_PROVIDERS) {
    const detail = providerCatalogHttpFailure(provider, 401).detail;
    for (const name of PROVIDER_API_KEY_ENV_NAMES[provider]) {
      assert.ok(detail.includes(name), `${provider}: ${name} is not named`);
    }
  }
});

test("a rejected credential says the provider's chat traffic is failing too", () => {
  // The whole point of the separate code. A row that only reports a failed
  // scan reads as a reporting problem, and the outage stays invisible.
  assert.match(
    providerCatalogHttpFailure("perplexity", 401).detail,
    /chat requests to this provider send the same key/i
  );
});

// Field coverage. Every payload below is the shape the provider's own
// documentation publishes; the assertions are about fields the parser used to
// drop on the floor, which reached the operator as blank columns on the
// adoption draft.

test("reads Groq's context window, completion cap and active flag", () => {
  const [model] = parseProviderCatalogResponse("groq", {
    data: [
      {
        id: "llama-4.2-70b",
        object: "model",
        created: 1770000000,
        owned_by: "Meta",
        active: true,
        context_window: 131072,
        max_completion_tokens: 32768,
      },
    ],
  });
  assert.equal(model.metadata.contextLength, 131072);
  assert.equal(model.metadata.outputTokenLimit, 32768);
  assert.equal(model.metadata.active, true);
});

test("an inactive Groq model is not offered for review", () => {
  const [model] = parseProviderCatalogResponse("groq", {
    data: [{ id: "llama-4.2-70b", active: false, context_window: 131072 }],
  });
  assert.equal(model.metadata.active, false);
  assert.equal(shouldQueueProviderCatalogObservation(model), false);
});

test("a provider that never mentions active is still queued", () => {
  // `null` has to keep meaning "not stated". Reading the absence of the field
  // as `false` would empty the queue for all eleven other providers.
  const [model] = parseProviderCatalogResponse("openai", {
    data: [{ id: "gpt-6-astra", owned_by: "openai" }],
  });
  assert.equal(model.metadata.active, null);
  assert.equal(shouldQueueProviderCatalogObservation(model), true);
});

test("reads xAI modalities, long-context threshold and its quoted prices", () => {
  const [model] = parseProviderCatalogResponse("xai", {
    models: [
      {
        id: "grok-4.5",
        input_modalities: ["text", "image"],
        output_modalities: ["text"],
        prompt_text_token_price: 30000,
        completion_text_token_price: 150000,
        cached_prompt_text_token_price: 3000,
        long_context_threshold: 131072,
      },
    ],
  });
  assert.equal(model.metadata.inputModalities, "image,text");
  assert.equal(model.metadata.outputModalities, "text");
  // An image input modality is the capability the registry calls supportsImage.
  assert.equal(model.metadata.vision, true);
  assert.equal(model.metadata.longContextThreshold, 131072);
  // Stored in the provider's own unit, under a name that says so. Converting
  // here would make a catalogue read look like a verified price, and
  // docs/policy/credit-and-cost-limits.md says where prices may come from.
  assert.equal(model.metadata.observedPromptPriceCentsPer100MTokens, 30000);
  assert.equal(model.metadata.observedCompletionPriceCentsPer100MTokens, 150000);
  assert.equal(model.metadata.observedCachedPromptPriceCentsPer100MTokens, 3000);
});

test("reads Moonshot's flat capability flags", () => {
  const [model] = parseProviderCatalogResponse("moonshot", {
    data: [
      {
        id: "kimi-k3",
        context_length: 262144,
        supports_image_in: true,
        supports_video_in: false,
        supports_reasoning: true,
      },
    ],
  });
  assert.equal(model.metadata.contextLength, 262144);
  assert.equal(model.metadata.vision, true);
  assert.equal(model.metadata.videoInput, false);
  assert.equal(model.metadata.thinking, true);
});

test("reads Anthropic's nested capability objects", () => {
  const [model] = parseProviderCatalogResponse("anthropic", {
    data: [
      {
        id: "claude-fable-5-1",
        type: "model",
        display_name: "Claude Fable 5.1",
        created_at: "2026-02-04T00:00:00Z",
        max_input_tokens: 1000000,
        max_tokens: 128000,
        capabilities: {
          image_input: { supported: true },
          pdf_input: { supported: true },
          structured_outputs: { supported: true },
          thinking: { supported: true, types: { adaptive: { supported: true } } },
          effort: {
            supported: true,
            low: { supported: true },
            medium: { supported: true },
            high: { supported: true },
            xhigh: { supported: true },
            max: { supported: false },
          },
        },
      },
    ],
  });
  assert.equal(model.displayName, "Claude Fable 5.1");
  assert.equal(model.metadata.inputTokenLimit, 1000000);
  assert.equal(model.metadata.outputTokenLimit, 128000);
  assert.equal(model.metadata.vision, true);
  assert.equal(model.metadata.thinking, true);
  assert.equal(model.metadata.pdfInput, true);
  assert.equal(model.metadata.structuredOutputs, true);
  // `supported` is the parent's own flag, not a level; `max` said false.
  assert.equal(model.metadata.effortLevels, "high,low,medium,xhigh");
});

test("Perplexity's Agent API listing does not file other vendors' models", () => {
  // https://docs.perplexity.ai/api-reference/models-get returns the models
  // Perplexity resells through POST /v1/agent. Tomverse's Perplexity client
  // calls Chat Completions with Sonar. Adopting a row out of this list gave a
  // registry entry pointing at Perplexity carrying Anthropic's identifier.
  assert.deepEqual(
    parseProviderCatalogResponse("perplexity", {
      object: "list",
      data: [
        { id: "anthropic/claude-opus-4-8", owned_by: "anthropic" },
        { id: "openai/gpt-5.6-sol", owned_by: "openai" },
        { id: "google/gemini-3.5-flash", owned_by: "google" },
        { id: "xai/grok-4.5", owned_by: "xai" },
        { id: "perplexity/glm-5.2", owned_by: "perplexity" },
        { id: "perplexity/kimi-k2.7-code", owned_by: "perplexity" },
        { id: "perplexity/sonar", owned_by: "perplexity" },
      ],
    }).map((model) => model.id),
    ["perplexity/sonar"]
  );
});

test("a new Sonar model is still discovered, prefixed or not", () => {
  assert.deepEqual(
    parseProviderCatalogResponse("perplexity", {
      data: [
        { id: "perplexity/sonar-pro", owned_by: "perplexity" },
        { id: "sonar-reasoning-pro", owned_by: "perplexity" },
        { id: "sonar", owned_by: "perplexity" },
      ],
    }).map((model) => model.id),
    ["perplexity/sonar-pro", "sonar-reasoning-pro", "sonar"]
  );
});

test("the product-surface rule is Perplexity's alone", () => {
  // Every other provider lists its own models on the endpoint its chat client
  // calls, and a rule that leaked would empty their queues.
  for (const provider of AI_PROVIDERS) {
    if (provider === "perplexity") continue;
    assert.equal(
      foreignProductSurfaceId(provider, "anthropic/claude-opus-4-8"),
      false,
      provider
    );
  }
});

test("an inactive Groq model is unavailable, not merely unqueued", () => {
  // The review's P1. Blocking the candidate array alone left a *registered*
  // model Groq had switched off reading as available and current, with no
  // warning anywhere. `lifecycle` is the one channel the scan status, the
  // daily report and the queue's availability column all read.
  const [model] = parseProviderCatalogResponse("groq", {
    data: [{ id: "llama-4.2-70b", active: false, context_window: 131072 }],
  });
  assert.equal(model.lifecycle, "inactive");
  assert.equal(model.available, false);
  assert.equal(model.metadata.active, false);
  assert.equal(shouldQueueProviderCatalogObservation(model), false);
});

test("an active Groq model is untouched by that rule", () => {
  const [model] = parseProviderCatalogResponse("groq", {
    data: [{ id: "llama-4.2-70b", active: true, context_window: 131072 }],
  });
  assert.equal(model.lifecycle, null);
  assert.equal(model.available, true);
  assert.equal(shouldQueueProviderCatalogObservation(model), true);
});

test("`active` is read for Groq alone", () => {
  // Groq is the provider that documents this field. Another provider using
  // the same word for something else would have real models dropped from
  // discovery -- the failure `openai_prefix_heuristic` exists to make visible.
  // An id each provider's own admission rules accept, so the assertion is
  // about the flag and not about a name one of them was going to drop anyway.
  const admittedId: Partial<Record<string, string>> = {
    openai: "gpt-6-astra",
    perplexity: "sonar-pro",
  };
  for (const provider of AI_PROVIDERS) {
    if (provider === "groq" || provider === "google") continue;
    const id = admittedId[provider] || "test-chat-1";
    const [model] = parseProviderCatalogResponse(provider, { data: [{ id, active: false }] });
    assert.ok(model, provider + ": " + id + " was not admitted");
    assert.equal(model.lifecycle, null, provider);
    assert.equal(model.metadata.active, null, provider);
    assert.equal(shouldQueueProviderCatalogObservation(model), true, provider);
  }
});

test("an empty modality list is read as silence, not as a denial", () => {
  // Both readings are available and only one can be wrong in a direction that
  // costs something: `supportsImage: false` would reach the adoption draft as
  // a capability the provider had denied.
  const [model] = parseProviderCatalogResponse("xai", {
    models: [{ id: "grok-4.5", input_modalities: [] }],
  });
  assert.equal(model.metadata.inputModalities, null);
  assert.equal(model.metadata.vision, null);
});

test("terminal lifecycles block auto-restore, announced endings do not", () => {
  // `mapped` is what reconciliation restores from: a model this automation
  // disabled for being absent is switched back on the day it reappears.
  //
  // The split is the whole point. `deprecated`, `legacy` and a scheduled
  // shutdown are notices about a future -- the model answers today, and
  // refusing to restore those leaves a working model off after a transient
  // catalogue gap, which is the damage restore exists to undo. `inactive`,
  // `archived`, `retired` and `sunset` are statements about now.
  const observed = (item: Record<string, unknown>) =>
    parseProviderCatalogResponse("groq", { data: [{ id: "llama-4.2-70b", ...item }] })[0];

  for (const dead of [
    { active: false },
    { archived: true },
    { stage: "retired" },
    { stage: "sunset" },
  ]) {
    assert.equal(providerReportedUnservable(observed(dead)), true, JSON.stringify(dead));
  }
  for (const alive of [
    { deprecated: true },
    { stage: "legacy" },
    { shutdown_date: "2027-01-01" },
  ]) {
    const model = observed(alive);
    assert.equal(providerReportedUnservable(model), false, JSON.stringify(alive));
    // Still a lifecycle: the operator is told, the model is not restored-blocked.
    assert.ok(model.lifecycle, JSON.stringify(alive));
  }
});

test("a model with no lifecycle at all is servable", () => {
  const [model] = parseProviderCatalogResponse("groq", {
    data: [{ id: "llama-4.2-70b", active: true }],
  });
  assert.equal(model.lifecycle, null);
  assert.equal(providerReportedUnservable(model), false);
});
