import assert from "node:assert/strict";
import test from "node:test";
import type { ChatConversation, } from "../src/chat-contract";
import { desktopChatApi } from "../src/host/chat-api";
import { startImageTurn } from "../src/host/chat-extras";
import { imageOfferQuote } from "../src/image-offer";
import type { ImageCapability } from "../src/images-contract";
import { desktopImageOfferCopy } from "../../../locales/desktopImageOffer";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";

const origin = "http://127.0.0.1:44183";
const modelId = "gpt-6-luna";
const current: ChatConversation = {
  id: "auto-chat", title: "Auto", kind: "chat", surface: "chat", productKey: "chat",
  messages: [{ id: "saved-question", role: "user", content: "Draw a lighthouse at dusk.", artifacts: [] }],
  messagePage: { nextCursor: null }, selectionMode: "auto", selectedModels: [modelId],
  autoSelection: { offered: true }, webSearchMode: "off",
};
const capability: ImageCapability = {
  maxModels: 3,
  models: [
    { id: "gpt-image-2", name: "GPT Image 2", provider: "openai", pricingVersion: "v1", prices: [
      { size: "1024x1024", quality: "low", credits: 6 }, { size: "1024x1024", quality: "medium", credits: 20 },
      { size: "1024x1024", quality: "high", credits: 80 }, { size: "1024x1536", quality: "medium", credits: 30 }] },
    { id: "other", name: "Other", provider: "fal", pricingVersion: "v2", prices: [{ size: "1024x1024", quality: "medium", credits: 12 }] },
  ],
};

test("an Auto turn the server judges an image request returns the decision and charges nothing", async (t) => {
  const paths: string[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    paths.push(url.pathname);
    if (url.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: null });
    return new Response(JSON.stringify({ imageTurn: { modelIds: ["gpt-image-2"], preset: "draft", prompt: " Dusk, lighthouse ", routingDecisionId: "abcdefghij0123456789" } }),
      { headers: { "Content-Type": "application/json", "X-Chat-Response-Mode": "image-turn" } });
  });
  const signal = new AbortController().signal;
  const api = desktopChatApi("fixture-bearer", signal, origin);
  const result = await api.stream(current, { modelId, selectionMode: "auto", effort: "default" }, "saved-question", "answer-id-0001", signal, () => {});
  assert.deepEqual(result && "imageTurn" in result ? result.imageTurn : null,
    { modelIds: ["gpt-image-2"], preset: "draft", prompt: "Dusk, lighthouse", routingDecisionId: "abcdefghij0123456789" });
  assert.deepEqual(paths, ["/api/chat/context", "/api/chat"]);
});

test("the offer is priced from the catalogue at the preset quality, or not at all", () => {
  assert.deepEqual(imageOfferQuote(capability, { modelIds: ["gpt-image-2"], preset: "draft" }),
    { quality: "low", models: [{ id: "gpt-image-2", name: "GPT Image 2", credits: 6 }], credits: 6 });
  assert.equal(imageOfferQuote(capability, { modelIds: ["gpt-image-2"], preset: null })?.credits, 20);
  assert.equal(imageOfferQuote(capability, { modelIds: [], preset: "final" })?.credits, 80);
  assert.equal(imageOfferQuote(capability, { modelIds: ["gpt-image-2", "other"], preset: "standard" })?.credits, 32);
  assert.equal(imageOfferQuote(capability, { modelIds: ["other"], preset: "final" }), null);
  assert.equal(imageOfferQuote(capability, { modelIds: ["missing"], preset: "standard" }), null);
  assert.equal(imageOfferQuote(capability, { modelIds: ["gpt-image-2"], preset: "standard", edit: true }), null);
  assert.equal(imageOfferQuote(null, { modelIds: [], preset: "standard" }), null);
});

const turn = {
  action: "imageTurn", conversationId: "auto-chat", sourceUserMessageId: "saved-question", assistantMessageId: "answer-id-0001",
  modelId, imageModelIds: ["gpt-image-2"], preset: "draft" as const,
} as const;

test("an unreadable image outcome is asked again under the same answer id, and a readable refusal is final", async () => {
  const calls: { path: string; body?: Record<string, unknown> }[] = [];
  const replies = [new Response("", { status: 502 }), Response.json({ imageTurn: { groupId: "group_1", modelIds: ["gpt-image-2"] }, content: "[Image generated] x" }, { status: 202 })];
  const api = { send: async (call: { path: string; body?: object }) => { calls.push({ path: call.path, body: call.body as Record<string, unknown> }); return replies[calls.length - 1]!; } };
  assert.deepEqual(await startImageTurn(api, turn, async () => {}), { ok: true, groupId: "group_1" });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].path, "/api/conversations/auto-chat/image-turn");
  assert.deepEqual(calls[1].body, calls[0].body);
  assert.equal(calls[0].body?.assistantMessageId, "answer-id-0001");
  assert.equal("edit" in (calls[0].body ?? {}), false);

  let attempts = 0;
  const refused = { send: async () => { attempts += 1; return Response.json({ error: "no", code: "CHAT_IMAGE_TURN_DISABLED" }, { status: 403 }); } };
  assert.deepEqual(await startImageTurn(refused, turn, async () => {}), { ok: false, code: "CHAT_IMAGE_TURN_DISABLED" });
  assert.equal(attempts, 1);

  let tries = 0;
  const unreachable = { send: async () => { tries += 1; throw new Error("offline"); } };
  assert.deepEqual(await startImageTurn(unreachable, turn, async () => {}), { ok: false, code: null });
  assert.equal(tries, 3);
});

test("every language words the price, the confirmation and the refusals", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = desktopImageOfferCopy[language];
    assert.ok(copy.create.includes("{credits}") && copy.price.includes("{credits}"), language);
    for (const value of Object.values(copy)) assert.ok(value.length > 0);
  }
});
