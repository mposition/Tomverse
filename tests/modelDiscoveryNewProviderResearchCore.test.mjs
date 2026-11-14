import assert from "node:assert/strict";
import test from "node:test";

import {
  NEW_PROVIDER_RESEARCH_SCHEMA,
  NEW_PROVIDER_RESEARCH_SOURCE,
  acceptNewProviderCandidates,
  brisbaneIsoWeek,
  isConnectedProvider,
  newProviderResearchAnalysis,
  newProviderResearchEvidence,
  newProviderResearchPrompt,
  providerSlug,
  publicCitationUrl,
} from "../lib/modelDiscoveryNewProviderResearchCore.ts";

const CONNECTED = ["openai", "anthropic", "google", "xai", "qwen", "zhipu", "moonshot", "together", "fal", "mistral"];

const candidate = (overrides = {}) => ({
  providerName: "Black Forest Labs",
  modelName: "FLUX.3 Pro",
  apiModelId: "flux-3-pro",
  comparableTo: "GPT Image 2",
  benchmarkBasisKo: "Artificial Analysis 이미지 아레나 Elo 1,180으로 GPT Image 2와 비슷",
  apiAvailabilityKo: "REST API, 셀프서브 키 발급",
  pricingKo: "이미지당 약 US$0.05",
  citations: ["https://artificialanalysis.ai/text-to-image/arena"],
  ...overrides,
});

const accept = (candidates, extra = {}) =>
  acceptNewProviderCandidates({
    product: "image",
    answer: { candidates },
    connectedProviders: CONNECTED,
    knownApiModels: ["gpt-image-2", "together/meta-llama-5"],
    ...extra,
  });

test("a cited candidate from an unconnected provider is accepted with a slug provider", () => {
  const { accepted, rejected } = accept([candidate()]);
  assert.deepEqual(rejected, []);
  assert.equal(accepted.length, 1);
  assert.equal(accepted[0].provider, "black-forest-labs");
  assert.equal(accepted[0].product, "image");
  assert.deepEqual(accepted[0].citations, ["https://artificialanalysis.ai/text-to-image/arena"]);
});

test("citations must be public http(s) URLs; a candidate left with none is rejected", () => {
  for (const bad of [
    "ftp://example.com/a",
    "javascript:alert(1)",
    "https://localhost/x",
    "http://127.0.0.1/x",
    "https://user:pw@example.com/",
    "https://[::1]/",
    "https://intranet.internal/x",
    "not a url",
    "https://nodot/",
  ]) {
    assert.equal(publicCitationUrl(bad), null, bad);
  }
  assert.equal(publicCitationUrl("https://example.com/a#frag"), "https://example.com/a");
  const { accepted, rejected } = accept([candidate({ citations: ["https://localhost/x", "javascript:alert(1)"] })]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].reason, "no_public_citation");
});

test("connected providers are never proposed again, by slug or published name", () => {
  for (const name of ["Google DeepMind", "OpenAI", "xAI", "Alibaba Cloud", "Moonshot AI (Kimi)", "Mistral AI", "Z.ai Zhipu", "fal.ai", "Together AI"]) {
    assert.equal(isConnectedProvider(name, CONNECTED), true, name);
  }
  for (const name of ["Black Forest Labs", "Cohere", "Reka AI", "Ideogram"]) {
    assert.equal(isConnectedProvider(name, CONNECTED), false, name);
  }
  const { accepted, rejected } = accept([candidate({ providerName: "Google DeepMind", apiModelId: "imagen-9" })]);
  assert.equal(accepted.length, 0);
  assert.equal(rejected[0].reason, "connected_provider");
});

test("a model id the catalogue or queue already knows is rejected, vendor prefix ignored", () => {
  const { accepted, rejected } = accept([
    candidate({ providerName: "Meta", apiModelId: "meta-llama-5" }),
    candidate({ apiModelId: "flux-3-pro" }),
    candidate({ modelName: "FLUX.3 Pro again", apiModelId: "bfl/FLUX-3-PRO" }),
  ]);
  assert.deepEqual(
    rejected.map((item) => item.reason),
    ["known_model", "duplicate"]
  );
  assert.equal(accepted.length, 1);
});

test("malformed answers are rejected, not thrown", () => {
  assert.deepEqual(accept(null).accepted, []);
  assert.deepEqual(acceptNewProviderCandidates({ product: "chat", answer: "nope", connectedProviders: CONNECTED, knownApiModels: [] }).accepted, []);
  const { rejected } = accept([candidate({ apiModelId: "bad id with spaces" }), candidate({ providerName: "" })]);
  assert.deepEqual(rejected.map((item) => item.reason), ["invalid_shape", "invalid_shape"]);
});

test("the stored evidence round-trips into a stable queue analysis", () => {
  const [accepted] = accept([candidate()]).accepted;
  const evidence = newProviderResearchEvidence(accepted, "perplexity-sonar-pro");
  assert.equal(evidence.discoveredBy, NEW_PROVIDER_RESEARCH_SOURCE);
  const analysis = newProviderResearchAnalysis(JSON.parse(JSON.stringify(evidence)));
  assert.ok(analysis);
  assert.equal(analysis.product, "image");
  assert.match(analysis.verdictKo, /Black Forest Labs/);
  assert.match(analysis.verdictKo, /GPT Image 2/);
  assert.ok(analysis.pointsKo.some((point) => point.includes("이미지당 약 US$0.05")));
  assert.ok(analysis.pointsKo.some((point) => point.includes("artificialanalysis.ai")));
  assert.equal(analysis.analysisKo, newProviderResearchAnalysis(evidence).analysisKo);
  // Other queue rows keep their own analysis.
  assert.equal(newProviderResearchAnalysis({ discoveredBy: "provider_model_catalog_monitor" }), null);
  assert.equal(newProviderResearchAnalysis(null), null);
});

test("the prompt names the product's current models and the excluded providers", () => {
  const prompt = newProviderResearchPrompt({
    product: "code",
    currentModels: ["Claude Opus 5.5", "GPT 6 Codex"],
    connectedProviders: CONNECTED,
    today: "2026-11-11",
  });
  assert.match(prompt, /Tomverse Code/);
  assert.match(prompt, /Claude Opus 5\.5, GPT 6 Codex/);
  assert.match(prompt, /anthropic, google/);
  assert.equal(NEW_PROVIDER_RESEARCH_SCHEMA.properties.candidates.maxItems, 5);
});

test("the weekly claim key follows the Brisbane ISO week", () => {
  // Sunday 2026-11-15 13:59 UTC is Sunday 23:59 in Brisbane: still week 46.
  assert.equal(brisbaneIsoWeek(new Date("2026-11-15T13:59:00Z")), "2026-W46");
  // Sunday 14:00 UTC is Monday 00:00 in Brisbane: week 47.
  assert.equal(brisbaneIsoWeek(new Date("2026-11-15T14:00:00Z")), "2026-W47");
  assert.equal(brisbaneIsoWeek(new Date("2026-12-31T20:00:00Z")), "2026-W53");
  assert.equal(brisbaneIsoWeek(new Date("2027-01-04T00:00:00Z")), "2027-W01");
});

test("provider slugs fit the work item provider column", () => {
  assert.equal(providerSlug("Black Forest Labs"), "black-forest-labs");
  assert.equal(providerSlug("  Reka.AI  "), "reka-ai");
  assert.ok(providerSlug("x".repeat(200)).length <= 60);
});

test("the research is off unless the switch names a model, and spends nothing then", async () => {
  const { runNewProviderModelResearch, MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ENV } = await import(
    "../lib/modelDiscoveryNewProviderResearch.ts"
  );
  assert.equal(MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ENV, "MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ID");
  assert.deepEqual(await runNewProviderModelResearch(new Date(), {}), { status: "off" });
  assert.deepEqual(
    await runNewProviderModelResearch(new Date(), { MODEL_DISCOVERY_RESEARCH_LLM_MODEL_ID: "   " }),
    { status: "off" }
  );
});

// 2026-11-14: MiniMax-H3-Image and Z.ai glm-image serve on image endpoints no
// model-list API returns, so the catalogue scan never saw them.
test("connected-provider image models are accepted only from a connected provider, cited on its official docs", async () => {
  const {
    acceptConnectedImageCandidates,
    connectedProviderId,
    connectedImageResearchPrompt,
    CONNECTED_IMAGE_RESEARCH_SCOPE,
  } = await import("../lib/modelDiscoveryNewProviderResearchCore.ts");
  const { isOfficialSourceUrl } = await import("../lib/modelCatalogCore.ts");
  const providers = ["minimax", "zhipu", "qwen", "openai"];
  const image = (overrides = {}) => ({
    providerName: "minimax",
    modelName: "MiniMax-H3-Image",
    apiModelId: "MiniMax-H3-Image",
    comparableTo: "GPT Image 2",
    benchmarkBasisKo: "공식 문서의 텍스트-이미지 생성 모델",
    apiAvailabilityKo: "POST /v1/images/generations",
    pricingKo: "문서에 가격 없음",
    citations: ["https://platform.minimax.io/docs/api-reference/image-generation-h3-generations"],
    ...overrides,
  });
  const { accepted, rejected } = acceptConnectedImageCandidates({
    answer: {
      candidates: [
        image(),
        image({
          providerName: "Z.ai",
          modelName: "GLM-Image",
          apiModelId: "glm-image",
          citations: ["https://docs.z.ai/guides/image/glm-image.md", "https://example.com/blog"],
        }),
        // Cited only on a third-party page: not official.
        image({ apiModelId: "image-01", citations: ["https://fal.ai/models/minimax/image-01"] }),
        // Not a connected provider.
        image({ providerName: "Black Forest Labs", apiModelId: "flux-3-pro", citations: ["https://bfl.ai/docs"] }),
        // Already known.
        image({ apiModelId: "gpt-image-2", providerName: "openai", citations: ["https://platform.openai.com/docs/models/gpt-image-2"] }),
      ],
    },
    connectedProviders: providers,
    knownApiModels: ["gpt-image-2"],
    isOfficial: isOfficialSourceUrl,
  });
  assert.deepEqual(
    accepted.map((item) => [item.provider, item.apiModelId, item.scope, item.product]),
    [
      ["minimax", "MiniMax-H3-Image", CONNECTED_IMAGE_RESEARCH_SCOPE, "image"],
      ["zhipu", "glm-image", CONNECTED_IMAGE_RESEARCH_SCOPE, "image"],
    ]
  );
  // Only the official citation is kept.
  assert.deepEqual(accepted[1].citations, ["https://docs.z.ai/guides/image/glm-image.md"]);
  assert.deepEqual(
    rejected.map((item) => item.reason),
    ["no_official_citation", "not_connected_provider", "known_model"]
  );
  assert.equal(connectedProviderId("Zhipu AI", providers), "zhipu");
  assert.equal(connectedProviderId("Hailuo (MiniMax)", providers), "minimax");
  assert.equal(connectedProviderId("Cohere", providers), null);
  const prompt = connectedImageResearchPrompt({
    providers,
    currentImageModels: ["GPT Image 2"],
    knownApiModels: ["openai/gpt-image-2"],
    today: "2026-11-14",
  });
  assert.match(prompt, /minimax, zhipu, qwen, openai/);
  assert.match(prompt, /gpt-image-2/);
});

test("a connected-image proposal reads as a connected provider's model in the queue", async () => {
  const { acceptConnectedImageCandidates, newProviderResearchEvidence, newProviderResearchAnalysis } =
    await import("../lib/modelDiscoveryNewProviderResearchCore.ts");
  const { accepted } = acceptConnectedImageCandidates({
    answer: {
      candidates: [
        {
          providerName: "zhipu",
          modelName: "GLM-Image",
          apiModelId: "glm-image",
          comparableTo: "GPT Image 2",
          benchmarkBasisKo: "공식 이미지 생성 모델",
          apiAvailabilityKo: "POST /api/paas/v4/images/generations",
          pricingKo: "이미지당 US$0.015",
          citations: ["https://docs.z.ai/guides/overview/pricing.md"],
        },
      ],
    },
    connectedProviders: ["zhipu"],
    knownApiModels: [],
    isOfficial: (provider, url) => provider === "zhipu" && url.startsWith("https://docs.z.ai/"),
  });
  const analysis = newProviderResearchAnalysis(JSON.parse(JSON.stringify(newProviderResearchEvidence(accepted[0], "sonar-pro"))));
  assert.equal(analysis.connected, true);
  assert.match(analysis.verdictKo, /연결된 공급자 zhipu의 이미지 모델 GLM-Image/);
  assert.match(analysis.nextStepKo, /이미지 어댑터/);
});

// Review r-20261114-092556-5da66a.
test("the connected-image call has its own default-off switch", async () => {
  const { readFileSync } = await import("node:fs");
  const runner = readFileSync("lib/modelDiscoveryNewProviderResearch.ts", "utf8");
  const { MODEL_DISCOVERY_CONNECTED_IMAGE_RESEARCH_ENV } = await import("../lib/modelDiscoveryNewProviderResearch.ts");
  assert.equal(MODEL_DISCOVERY_CONNECTED_IMAGE_RESEARCH_ENV, "MODEL_DISCOVERY_CONNECTED_IMAGE_RESEARCH_ENABLED");
  // Only the literal "true" turns it on; without it no fourth call is made.
  assert.ok(runner.includes('env[MODEL_DISCOVERY_CONNECTED_IMAGE_RESEARCH_ENV]?.trim() === "true"'));
  assert.match(runner, /if \(!connectedImageEnabled\) \{\s*return \{ ok: true, proposed: 0/);
});

test("research rows are never judged by the catalogue scan, so the vanished-ID exclusion cannot close them", async () => {
  const { readFileSync } = await import("node:fs");
  const queue = readFileSync("lib/modelLifecycleWorkItems.ts", "utf8");
  assert.match(
    queue,
    /const availability: ModelAvailability =\s*newProviderResearchAnalysis\(row\.evidence\) !== null\s*\? "unknown"/
  );
  const { vanishedDiscoveryChanges } = await import("../lib/modelLifecycleWorkItemCore.ts");
  const { exclude } = vanishedDiscoveryChanges({
    undecided: [{ id: "r1", action: "add", familyKey: "minimax-h3-image", availability: "unknown" }],
    excluded: [],
  });
  assert.deepEqual(exclude, []);
});
