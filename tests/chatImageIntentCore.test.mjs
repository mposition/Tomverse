import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS,
  CHAT_IMAGE_INTENT_SYSTEM,
  chatImageIntentModelId,
  chatImageIntentOutputSchema,
  chatImageIntentPrompt,
  parseChatImageIntentOutput,
} from "../lib/chatImageIntentCore.ts";
import { askChatImageIntent } from "../lib/chatImageIntentClient.ts";

test("the feature is off unless the env names a model", () => {
  assert.equal(chatImageIntentModelId({}), null);
  assert.equal(chatImageIntentModelId({ CHAT_IMAGE_INTENT_MODEL_ID: "  " }), null);
  assert.equal(
    chatImageIntentModelId({ CHAT_IMAGE_INTENT_MODEL_ID: " gpt-6-luna " }),
    "gpt-6-luna"
  );
});

test("only an explicit image: true routes to the image workspace", () => {
  assert.equal(parseChatImageIntentOutput({ image: true }), true);
  for (const output of [
    { image: false },
    { image: "true" },
    { image: 1 },
    {},
    null,
    undefined,
    "image",
    true,
  ]) {
    assert.equal(parseChatImageIntentOutput(output), false, JSON.stringify(output));
  }
});

test("the schema asks for one required boolean and nothing else", () => {
  assert.deepEqual(chatImageIntentOutputSchema(), {
    type: "object",
    properties: { image: { type: "boolean" } },
    required: ["image"],
    additionalProperties: false,
  });
});

test("the prompt is trimmed and capped; blank means no call", () => {
  assert.equal(chatImageIntentPrompt("   "), "");
  assert.equal(chatImageIntentPrompt("  고양이 그려줘 "), "고양이 그려줘");
  assert.equal(
    chatImageIntentPrompt("a".repeat(CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS + 50)).length,
    CHAT_IMAGE_INTENT_MAX_PROMPT_CHARS
  );
});

test("the instructions keep code-drawn graphics and image questions in chat", () => {
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /SVG/);
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /questions about images/);
  assert.match(CHAT_IMAGE_INTENT_SYSTEM, /When unsure, answer image=false/);
});

const jsonResponse = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

test("the client posts the text and reads image: true", async () => {
  let seen;
  const image = await askChatImageIntent("draw a cat", async (url, init) => {
    seen = { url, init };
    return jsonResponse({ image: true });
  });
  assert.equal(image, true);
  assert.equal(seen.url, "/api/chat/image-intent");
  assert.equal(seen.init.method, "POST");
  assert.deepEqual(JSON.parse(seen.init.body), { text: "draw a cat" });
  assert.ok(seen.init.signal instanceof AbortSignal);
});

test("the client falls back to chat on no, refusal, malformed body or failure", async () => {
  assert.equal(await askChatImageIntent("x", async () => jsonResponse({ image: false })), false);
  assert.equal(
    await askChatImageIntent("x", async () => jsonResponse({ error: "nope" }, 429)),
    false
  );
  assert.equal(
    await askChatImageIntent("x", async () => new Response("not json", { status: 200 })),
    false
  );
  assert.equal(
    await askChatImageIntent("x", async () => {
      throw new TypeError("network");
    }),
    false
  );
});
