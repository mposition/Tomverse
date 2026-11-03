import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";

const bridge = { hasSession: async () => ({ signedIn: true }), signOut: async () => {} };
const decision = { modelIds: ["image-model"], preset: "standard", prompt: "A synthetic event flyer" };

function fixture({ supported = true, handoff = decision, startFailure, invalidReceipt = false } = {}) {
  const calls = [];
  const conversation = { id: "image-chat", title: "Flyer", selectedModels: ["chat-model"], selectionMode: "auto", messages: [] };
  let answerId;
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, ...init });
    if (path === "/api/products/mobile/capabilities") return Response.json({ reviewEasy: true, assistants: true, maxModels: 3, plan: "Max", ...(supported ? { chatImageTurns: true } : {}) });
    if (path === "/api/conversations/image-chat/messages") {
      const message = JSON.parse(init.body).messages[0];
      conversation.messages.push({ id: "saved-question", role: "user", content: message.content });
      return Response.json({ messageMappings: [{ requestId: message.clientRequestId, messageId: "saved-question" }] });
    }
    if (path === "/api/conversations/image-chat") return Response.json(conversation);
    if (path === "/api/chat") {
      const body = JSON.parse(init.body);
      answerId = body.assistantMessageId;
      assert.equal(body.sourceUserMessageId, "saved-question");
      return Response.json({ imageTurn: handoff }, { headers: { "X-Chat-Response-Mode": "image-turn" } });
    }
    if (path === "/api/conversations/image-chat/image-turn") {
      assert.equal(init.method, "POST");
      assert.deepEqual(JSON.parse(init.body), {
        sourceUserMessageId: "saved-question", assistantMessageId: answerId, modelId: "chat-model",
        imageModelIds: decision.modelIds, preset: decision.preset, prompt: decision.prompt,
      });
      assert.equal(init.signal.aborted, false);
      const imageTurn = { groupId: "saved-image-group", modelIds: decision.modelIds };
      conversation.messages.push({ id: answerId, role: "assistant", status: "normal", content: "[Image generated] Make an event flyer", imageTurn });
      if (startFailure) throw startFailure;
      return Response.json(invalidReceipt ? {} : { content: conversation.messages.at(-1).content, imageTurn }, { status: 202 });
    }
    throw new Error(`Unexpected request ${path}`);
  }, bridge);
  return { transport, conversation, calls };
}

test("Smart Adaptive image handoff starts one image answer in the original conversation", async () => {
  const f = fixture();
  await f.transport.send(f.conversation, "Make an event flyer", [], new AbortController().signal, () => {});
  const restored = await f.transport.load(f.conversation.id);
  assert.equal(restored.activeAttempt, false);
  assert.equal(restored.messages.filter(message => message.role === "user").length, 1);
  assert.deepEqual(restored.messages.at(-1).imageTurn, { groupId: "saved-image-group", modelIds: decision.modelIds });
  assert.equal(f.calls.filter(call => call.path === "/api/chat").length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith("/image-turn")).length, 1);
  assert.equal(f.calls.some(call => call.path.includes("deep-research")), false);
});

test("an older server never receives the cookie-only image endpoint or invalidates the native session", async () => {
  const f = fixture({ supported: false });
  let lost = 0; f.transport.onSessionLost(() => lost++);
  await assert.rejects(f.transport.send(f.conversation, "Make an event flyer", [], new AbortController().signal, () => {}), error => error.code === "NATIVE_IMAGE_TURNS_UNAVAILABLE");
  assert.equal(f.calls.some(call => call.path.endsWith("/image-turn")), false);
  assert.equal(lost, 0);
  assert.equal(f.conversation.messages.length, 1);
});

test("a malformed image handoff cannot submit paid image work", async () => {
  const f = fixture({ handoff: { preset: "standard" } });
  await assert.rejects(f.transport.send(f.conversation, "Make an event flyer", [], new AbortController().signal, () => {}), /CHAT_IMAGE_TURN_INVALID/);
  assert.equal(f.calls.some(call => call.path.endsWith("/image-turn")), false);
});

test("a lost image receipt is read back without resubmitting or duplicating the question", async () => {
  const f = fixture({ startFailure: new TypeError("Synthetic connection loss after acceptance") });
  await assert.rejects(f.transport.send(f.conversation, "Make an event flyer", [], new AbortController().signal, () => {}));
  const restored = await f.transport.load(f.conversation.id);
  assert.equal(restored.messages.at(-1).imageTurn.groupId, "saved-image-group");
  assert.equal(restored.messages.filter(message => message.role === "user").length, 1);
  assert.equal(f.calls.filter(call => call.path.endsWith("/image-turn")).length, 1);
});

test("an invalid image receipt fails closed and never submits a replacement image", async () => {
  const f = fixture({ invalidReceipt: true });
  await assert.rejects(f.transport.send(f.conversation, "Make an event flyer", [], new AbortController().signal, () => {}), /CHAT_IMAGE_RECEIPT_INVALID/);
  assert.equal(f.calls.filter(call => call.path.endsWith("/image-turn")).length, 1);
});
