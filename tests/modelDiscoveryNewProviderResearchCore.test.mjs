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
