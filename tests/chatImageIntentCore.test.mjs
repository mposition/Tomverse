import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS,
  CHAT_IMAGE_INTENT_MAX_REWRITE_CHARS,
  CHAT_IMAGE_INTENT_SYSTEM,
  chatImageIntentOutputSchema,
  chatImageIntentPrompt,
  chatImageIntentUserMessage,
  chatImageModelCandidates,
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
    latencyClass: "fast",
    disabledReason: null,
    prices: [price("medium", "1024x1024", 30)],
  },
  {
    id: "held",
    name: "Held Image",
    latencyClass: "fast",
    disabledReason: "worst_case_cost_unbounded",
    prices: [price("medium", "1024x1024", 10)],
  },
  {
    id: "landscape-only",
    name: "Landscape Only",
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
      latency: "slow",
      credits: { draft: 15, standard: 70, final: 250 },
    },
    { id: "quick", name: "Quick Image", latency: "fast", credits: { standard: 30 } },
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
      prompt: { type: "string" },
    },
    required: ["image", "modelId", "preset", "prompt"],
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
    { image: true, modelId: "strong", preset: "final", prompt: null }
  );
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "quick", preset: "standard" }, candidates),
    { image: true, modelId: "quick", preset: "standard", prompt: null }
  );
});

test("an unlisted model or an unoffered preset is dropped, not trusted", () => {
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "held", preset: "standard" }, candidates),
    { image: true, modelId: null, preset: null, prompt: null }
  );
  assert.deepEqual(
    parseChatImageIntentOutput({ image: true, modelId: "quick", preset: "final" }, candidates),
    { image: true, modelId: "quick", preset: null, prompt: null }
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
    return jsonResponse({ image: true, modelId: "quick", preset: "draft" });
  });
  assert.deepEqual(decision, { image: true, modelId: "quick", preset: "draft", prompt: null });
  assert.equal(seen.url, "/api/chat/image-intent");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), { text: "draw a cat" });
  assert.ok(seen.init.signal instanceof AbortSignal);
  assert.deepEqual(
    await askChatImageIntent("x", {}, async () => jsonResponse({ image: true, preset: "huge" })),
    { image: true, modelId: null, preset: null, prompt: null }
  );
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

test("a follow-up's rewritten prompt is kept only when a previous image was shown", () => {
  const output = { image: true, modelId: "strong", preset: "standard", prompt: "  a blue cat icon  " };
  assert.deepEqual(parseChatImageIntentOutput(output, candidates, true), {
    image: true,
    modelId: "strong",
    preset: "standard",
    prompt: "a blue cat icon",
  });
  assert.equal(parseChatImageIntentOutput(output, candidates).prompt, null);
  assert.equal(
    parseChatImageIntentOutput({ ...output, prompt: "   " }, candidates, true).prompt,
    null
  );
  // At the limit it is kept whole; over it, refused rather than cut -- the
  // change is usually at the end, and a cut prompt would be charged for the
  // wrong picture.
  const atLimit = "x".repeat(CHAT_IMAGE_INTENT_MAX_REWRITE_CHARS);
  assert.equal(
    parseChatImageIntentOutput({ ...output, prompt: atLimit }, candidates, true).prompt,
    atLimit
  );
  assert.deepEqual(
    parseChatImageIntentOutput({ ...output, prompt: `${atLimit}, now in blue` }, candidates, true),
    { image: false }
  );
  assert.deepEqual(
    readChatImageDecision({ image: true, modelId: "strong", preset: "draft", prompt: `${atLimit}!` }),
    { image: false }
  );
});

test("the previous image is shown to the call before the message", () => {
  const message = chatImageIntentUserMessage("더 파랗게 해줘", candidates, "a simple cat icon");
  assert.match(message, /Previous image:\na simple cat icon\n\nMessage:\n더 파랗게 해줘$/);
  assert.doesNotMatch(chatImageIntentUserMessage("cat", candidates), /Previous image/);
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /make it bluer/);
});

test("the client sends the conversation so a follow-up can find its image", async () => {
  let body;
  await askChatImageIntent("더 파랗게", { conversationId: "conv-1" }, async (_url, init) => {
    body = JSON.parse(init.body);
    return jsonResponse({ image: true, modelId: "quick", preset: "standard", prompt: "a blue cat" });
  });
  assert.deepEqual(body, { text: "더 파랗게", conversationId: "conv-1" });
});
