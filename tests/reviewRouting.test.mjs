import assert from "node:assert/strict";
import test from "node:test";
import { parseReviewRoute, reviewRoutingCandidates } from "../lib/reviewRoutingCore.ts";
import { askReviewRoute } from "../lib/reviewRoutingClient.ts";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import { IMAGE_MODEL_REGISTRY } from "../lib/imageModelRegistry.ts";
import { reviewProviderPanels, reviewProviderTranscript } from "../lib/reviewProviderTranscript.ts";

const providers = ["openai", "anthropic", "google"];
const textModels = providers.map((provider, index) => ({ ...AVAILABLE_MODELS[0], id: `text-${index}`, provider, enabled: true, publiclyListed: true, catalogDeleted: false, requiredTier: "Free" }));
const imageModels = [
  { ...IMAGE_MODEL_REGISTRY[0], id: "openai-image", provider: "openai", modelOwner: "openai", disabledReason: null, prices: [{ size: "1024x1024", quality: "medium", credits: 10 }] },
  { ...IMAGE_MODEL_REGISTRY[0], id: "google-image", provider: "fal", modelOwner: "google", disabledReason: null, prices: [{ size: "1024x1024", quality: "medium", credits: 8 }] },
];
const candidates = reviewRoutingCandidates({ providers, models: textModels, imageModels, plan: "Max", hasImages: false });
const imageDecision = { kind: "image", preset: "standard", choices: [
  { provider: "openai", modelId: "openai-image" }, { provider: "anthropic", modelId: null }, { provider: "google", modelId: "google-image" },
] };

test("Easy preserves provider order and represents only the unsupported provider as null", () => {
  assert.deepEqual(parseReviewRoute(imageDecision, providers, candidates), imageDecision);
  assert.equal(candidates.images.find(model => model.id === "google-image").provider, "google");
});
test("an image request with no supported providers remains an image request without substitution", () => {
  const decision = parseReviewRoute({ kind: "image", preset: "standard", choices: [{ provider: "anthropic", modelId: "openai-image" }] }, ["anthropic"], candidates);
  assert.deepEqual(decision.choices, [{ provider: "anthropic", modelId: null }]);
});
test("a route cannot cross providers, duplicate providers or invent a model or preset", () => {
  for (const choices of [
    [{ provider: "openai", modelId: "google-image" }, ...imageDecision.choices.slice(1)],
    [{ provider: "openai", modelId: "invented" }, ...imageDecision.choices.slice(1)],
    [imageDecision.choices[0], imageDecision.choices[0], imageDecision.choices[2]],
  ]) assert.equal(parseReviewRoute({ ...imageDecision, choices }, providers, candidates), null);
  for (const preset of ["__proto__", "constructor", "final"]) assert.equal(parseReviewRoute({ ...imageDecision, preset }, providers, candidates), null);
});
test("text routing chooses only eligible text models in each provider", () => {
  const decision = { kind: "text", preset: "standard", choices: providers.map((provider, index) => ({ provider, modelId: `text-${index}` })) };
  assert.deepEqual(parseReviewRoute(decision, providers, candidates), decision);
  assert.equal(parseReviewRoute({ ...decision, choices: imageDecision.choices }, providers, candidates), null);
});
test("disabled and hidden text or image models never reach the routing prompt", () => {
  const result = reviewRoutingCandidates({ providers, plan: "Max", hasImages: false,
    models: [ { ...textModels[0], enabled: false }, { ...textModels[1], publiclyListed: false }, { ...textModels[2], catalogDeleted: true } ],
    imageModels: imageModels.map(model => ({ ...model, disabledReason: "held" })),
  });
  assert.equal(result.text.length, 0); assert.equal(result.images.length, 0);
});
test("the client sends providers and attachments capability and refuses malformed or failed routing", async () => {
  const input = { text: "Create a poster", providers, hasImages: false };
  assert.deepEqual(await askReviewRoute(input, async (url, init) => {
    assert.equal(url, "/api/review/route"); assert.deepEqual(JSON.parse(init.body), input);
    return Response.json(imageDecision);
  }), imageDecision);
  for (const output of [ {}, { ...imageDecision, choices: [] }, { ...imageDecision, kind: "video" }, { ...imageDecision, preset: "unknown" } ]) {
    assert.equal(await askReviewRoute(input, async () => Response.json(output)), null);
  }
  assert.equal(await askReviewRoute(input, async () => new Response(null, { status: 503 })), null);
  assert.equal(await askReviewRoute(input, async () => { throw new Error("offline"); }), null);
});

test("Easy retains a provider's earlier model answers without mixing another provider's replies", () => {
  const messages = [ { role: "user", content: "first" }, { role: "assistant", modelId: "old-openai" },
    { role: "assistant", modelId: "anthropic" }, { role: "user", content: "next" },
    { role: "assistant", modelId: "new-openai" }, { role: "assistant", modelId: "unknown" } ];
  assert.deepEqual(reviewProviderTranscript(messages, "openai", id => id.endsWith("openai") ? "openai" : id === "anthropic" ? "anthropic" : undefined),
    [messages[0], messages[1], messages[3], messages[4]]);
});

test("Easy projects one panel per provider without changing a Professional model selection", () => {
  const selected = ["openai-old", "openai-new", "anthropic"];
  const provider = id => id.startsWith("openai") ? "openai" : "anthropic";
  assert.deepEqual(reviewProviderPanels(selected, [], provider), ["openai-old", "anthropic"]);
  assert.deepEqual(reviewProviderPanels(selected, ["openai-old"], provider), ["openai-new", "anthropic"]);
  assert.deepEqual(selected, ["openai-old", "openai-new", "anthropic"]);
});
