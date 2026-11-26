import assert from "node:assert/strict";
import test from "node:test";
import type { ChatConversation } from "../src/chat-contract";
import { desktopChatApi } from "../src/host/chat-api";
import { startImageTurn } from "../src/host/chat-extras";
import { imageTurnFromOffer } from "../src/image-turn-request";
import { chatExtrasInput } from "../src/chat-extras-contract";

const origin = "http://127.0.0.1:44183";
const modelId = "gpt-6-luna";
const current: ChatConversation = {
  id: "auto-chat", title: "Auto", kind: "chat", surface: "chat", productKey: "chat",
  messages: [{ id: "saved-question", role: "user", content: "Draw a lighthouse at dusk.", artifacts: [] }],
  messagePage: { nextCursor: null }, selectionMode: "auto", selectedModels: [modelId],
  autoSelection: { offered: true }, webSearchMode: "off",
};
test("an Auto turn the server judges an image request returns the decision before anything is charged", async (t) => {
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

const turn = {
  action: "imageTurn" as const, conversationId: "auto-chat", sourceUserMessageId: "saved-question", assistantMessageId: "answer-id-0001",
  modelId, imageModelIds: ["gpt-image-2"], preset: "draft" as const,
} satisfies Parameters<typeof startImageTurn>[1];

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

test("the decision becomes the same request body the web sends, edit flag and routing id included", () => {
  const offer = { conversationId: "auto-chat", sourceUserMessageId: "saved-question", assistantMessageId: "answer-id-0001", modelId,
    request: { modelIds: ["gpt-image-2"], preset: null, prompt: "Bluer", edit: true as const, routingDecisionId: "abcdefghij0123456789" } };
  const input = imageTurnFromOffer(offer);
  assert.deepEqual(input, { action: "imageTurn", conversationId: "auto-chat", sourceUserMessageId: "saved-question", assistantMessageId: "answer-id-0001",
    modelId, imageModelIds: ["gpt-image-2"], preset: null, prompt: "Bluer", edit: true, routingDecisionId: "abcdefghij0123456789" });
  assert.equal(chatExtrasInput.safeParse(input).success, true);
  assert.equal(chatExtrasInput.safeParse({ ...input, edit: false }).success, false);
  assert.equal("edit" in imageTurnFromOffer({ ...offer, request: { modelIds: [], preset: "standard" } }), false);
});

test("an edit decision reaches the server as a flag only, and the retry body is identical", async () => {
  const bodies: Record<string, unknown>[] = [];
  const replies = [new Response("", { status: 503 }), Response.json({ imageTurn: { groupId: "group_2", modelIds: [] } }, { status: 202 })];
  const api = { send: async (call: { body?: object }) => { bodies.push(call.body as Record<string, unknown>); return replies[bodies.length - 1]!; } };
  const input = imageTurnFromOffer({ conversationId: "auto-chat", sourceUserMessageId: "saved-question", assistantMessageId: "answer-id-0001", modelId,
    request: { modelIds: ["gpt-image-2"], preset: "standard", edit: true } });
  assert.deepEqual(await startImageTurn(api, input, async () => {}), { ok: true, groupId: "group_2" });
  assert.equal(bodies[0].edit, true);
  assert.deepEqual(bodies[1], bodies[0]);
});
