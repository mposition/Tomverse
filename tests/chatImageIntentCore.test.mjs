import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS,
  CHAT_IMAGE_INTENT_SYSTEM,
  chatImageIntentOutputSchema,
  chatImageIntentPrompt,
  chatImageIntentUserMessage,
  chatImageModelCandidates,
  imageCandidatesForChatModels,
  parseChatImageIntentOutput,
  readChatImageDecision,
} from "../lib/chatImageIntentCore.ts";
import { askChatImageIntent } from "../lib/chatImageIntentClient.ts";
import { IMAGE_MODEL_REGISTRY } from "../lib/imageModelRegistry.ts";

const price = (quality, size, credits) => ({
  quality,
  size,
  credits,
  outputCostMicroUsd: credits * 100,
});

const models = [
  {
    id: "strong",
    name: "Strong Image",
    provider: "openai",
    latencyClass: "slow",
    disabledReason: null,
    prices: [
      price("low", "1024x1024", 15),
      price("medium", "1024x1024", 70),
      price("high", "1024x1024", 250),
      price("high", "1536x1024", 200),
    ],
  },
  {
    id: "quick",
    name: "Quick Image",
    provider: "fal",
    modelOwner: "google",
    latencyClass: "fast",
    disabledReason: null,
    prices: [price("medium", "1024x1024", 30)],
  },
  {
    id: "held",
    name: "Held Image",
    provider: "xai",
    latencyClass: "fast",
    disabledReason: "worst_case_cost_unbounded",
    prices: [price("medium", "1024x1024", 10)],
  },
  {
    id: "landscape-only",
    name: "Landscape Only",
    provider: "xai",
    latencyClass: "balanced",
    disabledReason: null,
    prices: [price("medium", "1536x1024", 40)],
  },
];

const candidates = chatImageModelCandidates(models);

test("candidates are enabled models with square prices, by preset", () => {
  assert.deepEqual(candidates, [
    {
      id: "strong",
      name: "Strong Image",
      owner: "openai",
      latency: "slow",
      credits: { draft: 15, standard: 70, final: 250 },
    },
    {
      id: "quick",
      name: "Quick Image",
      owner: "google",
      latency: "fast",
      credits: { standard: 30 },
    },
  ]);
});

test("the registry seed yields at least one candidate", () => {
  assert.ok(chatImageModelCandidates(IMAGE_MODEL_REGISTRY).length >= 1);
});

test("the model sees the price list, then the capped message", () => {
  const message = chatImageIntentUserMessage(
    `  ${"a".repeat(CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS + 50)}  `,
    candidates
  );
  assert.match(message, /- strong \(Strong Image; slow\): draft 15, standard 70, final 250/);
  assert.match(message, /- quick \(Quick Image; fast\): standard 30/);
  assert.ok(message.endsWith(`Message:\n${"a".repeat(CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS)}`));
  assert.equal(chatImageIntentPrompt("   "), "");
});

test("the schema requires the decision, a listed model and a preset", () => {
  assert.deepEqual(chatImageIntentOutputSchema(candidates), {
    type: "object",
    properties: {
      image: { type: "boolean" },
      modelId: { type: "string", enum: ["strong", "quick"] },
      preset: { type: "string", enum: ["draft", "standard", "final"] },
    },
    required: ["image", "modelId", "preset"],
    additionalProperties: false,
  });
});

test("the instructions triage by complexity and keep code graphics in chat", () => {
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /SVG/);
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /When unsure, answer image=false/);
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /cheaper or faster model/);
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /stronger, pricier model/);
});

test("a valid image answer keeps the triaged model and preset", () => {
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "strong", preset: "final" }, candidates),
    { image: true, modelIds: ["strong"], preset: "final" }
  );
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "quick", preset: "standard" }, candidates),
    { image: true, modelIds: ["quick"], preset: "standard" }
  );
});

test("an unlisted model or an unoffered preset is dropped, not trusted", () => {
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "held", preset: "standard" }, candidates),
    { image: true, modelIds: [], preset: null }
  );
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "quick", preset: "final" }, candidates),
    { image: true, modelIds: ["quick"], preset: null }
  );
});

test("only an explicit image: true routes", () => {
  for (const output of [
    { image: false, modelId: "strong", preset: "final" },
    { image: "true", modelId: "strong", preset: "final" },
    {},
    null,
    undefined,
    "image",
    true,
  ]) {
    assert.deepEqual(parseChatImageIntentOutput(output, candidates), { image: false });
    assert.deepEqual(readChatImageDecision(output), { image: false });
  }
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("the client posts the text and reads the decision", async () => {
  let seen;
  const decision = await askChatImageIntent("draw a cat", {}, async (url, init) => {
    seen = { url, init };
    return jsonResponse({ image: true, modelIds: ["quick"], preset: "draft" });
  });
  assert.deepEqual(decision, { image: true, modelIds: ["quick"], preset: "draft" });
  assert.equal(seen.url, "/api/chat/image-intent");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), { text: "draw a cat" });
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.deepEqual(
    await askChatImageIntent("x", {}, async () => jsonResponse({ image: true, preset: "huge" })),
    { image: true, modelIds: [], preset: null }
  );
  let reviewBody;
  await askChatImageIntent("x", { chatModelIds: ["gpt-6-luna", "grok-5"] }, async (_url, init) => {
    reviewBody = JSON.parse(init.body);
    return jsonResponse({ image: false });
  });
  assert.deepEqual(reviewBody, { text: "x", chatModelIds: ["gpt-6-luna", "grok-5"] });
});

test("the client falls back to chat on no, refusal, malformed body or failure", async () => {
  const chat = { image: false };
  assert.deepEqual(await askChatImageIntent("x", {}, async () => jsonResponse(chat)), chat);
  assert.deepEqual(
    await askChatImageIntent("x", {}, async () => jsonResponse({ error: "nope" }, 429)),
    chat
  );
  assert.deepEqual(
    await askChatImageIntent("x", {}, async () => new Response("not json", { status: 200 })),
    chat
  );
  assert.deepEqual(
    await askChatImageIntent("x", {}, async () => {
      throw new TypeError("network");
    }),
    chat
  );
});

test("Review maps chat models to their makers' image models, in order, capped", () => {
  const all = chatImageModelCandidates([
    ...models,
    {
      id: "grok-img",
      name: "Grok Img",
      provider: "xai",
      latencyClass: "balanced",
      disabledReason: null,
      prices: [price("medium", "1024x1024", 50)],
    },
  ]);
  const chat = [
    { provider: "anthropic" },
    { provider: "xai" },
    { provider: "openai" },
    { provider: "openai" },
    { provider: "google" },
  ];
  assert.deepEqual(
    imageCandidatesForChatModels(chat, all, 4).map((entry) => entry.id),
    ["grok-img", "strong", "quick"]
  );
  assert.deepEqual(
    imageCandidatesForChatModels(chat, all, 2).map((entry) => entry.id),
    ["grok-img", "strong"]
  );
  assert.deepEqual(imageCandidatesForChatModels([{ provider: "anthropic" }], all, 3), []);
});

test("Review keeps its models and a preset only when every model offers it", () => {
  const fixed = candidates; // strong (draft/standard/final) + quick (standard only)
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "strong", preset: "final" }, fixed, fixed),
    { image: true, modelIds: ["strong", "quick"], preset: null }
  );
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "quick", preset: "standard" }, fixed, fixed),
    { image: true, modelIds: ["strong", "quick"], preset: "standard" }
  );
  assert.deepEqual(
    parseChatImageIntentOutput({ image: false, modelId: "quick", preset: "standard" }, fixed, fixed),
    { image: false }
  );
});

test("the Review message tells the model only the preset is its choice", () => {
  assert.match(
    chatImageIntentUserMessage("cat", candidates, { fixed: true }),
    /already chose these image models/
  );
  assert.doesNotMatch(chatImageIntentUserMessage("cat", candidates), /already chose/);
});
