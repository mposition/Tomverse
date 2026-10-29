import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";

const bridge = { hasSession: async () => ({ signedIn: true }), signOut: async () => {} };
const photo = { uploadId: "upload-1", name: "garden.jpg", mediaType: "image/jpeg", size: 2048 };
const pdf = { uploadId: "upload-2", name: "notes.pdf", mediaType: "application/pdf", size: 2048 };

function fixture({ selectionMode = "manual", edits = true, intent = { image: true, modelId: "gpt-image-2", preset: "standard", prompt: null, edit: true }, autoTurn } = {}) {
  const calls = [];
  const conversation = { id: "photo-chat", title: "Garden", selectedModels: ["chat-model"], selectionMode, messages: [] };
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, ...init });
    if (path === "/api/products/mobile/capabilities") {
      return Response.json({ reviewEasy: true, assistants: true, maxModels: 3, plan: "Max", chatImageTurns: true, ...(edits ? { chatImageEdits: true } : {}) });
    }
    if (path === "/api/conversations/photo-chat/messages") {
      const message = JSON.parse(init.body).messages[0];
      conversation.messages.push({ id: "saved-question", role: "user", content: message.content });
      return Response.json({ messageMappings: [{ requestId: message.clientRequestId, messageId: "saved-question" }] });
    }
    if (path === "/api/conversations/photo-chat") return Response.json(conversation);
    if (path === "/api/chat/image-intent") return Response.json(intent);
    if (path === "/api/chat") {
      if (autoTurn) return Response.json({ imageTurn: autoTurn }, { headers: { "X-Chat-Response-Mode": "image-turn" } });
      return Response.json({ code: "SYNTHETIC_TEXT_ANSWER" }, { status: 500 });
    }
    if (path === "/api/conversations/photo-chat/image-turn") {
      const imageTurn = { groupId: "edit-group", modelIds: ["gpt-image-2"] };
      return Response.json({ content: "[Image generated] x", imageTurn }, { status: 202 });
    }
    throw new Error(`Unexpected request ${path}`);
  }, bridge);
  return { transport, conversation, calls };
}

const send = (f, text, files) => f.transport.send(f.conversation, text, files, new AbortController().signal, () => {});
const body = (f, suffix) => JSON.parse(f.calls.find(call => call.path.endsWith(suffix)).body);

test("a manual send with a photo asks whether to edit it and answers with an edit", async () => {
  const f = fixture();
  await send(f, "뒤의 소나무를 30% 줄여줘", [photo]);
  assert.deepEqual(body(f, "/api/chat/image-intent"), { text: "뒤의 소나무를 30% 줄여줘", conversationId: "photo-chat", attachedPhoto: true });
  const turn = body(f, "/image-turn");
  assert.equal(turn.sourceUserMessageId, "saved-question");
  assert.equal(turn.edit, true);
  assert.deepEqual(turn.imageModelIds, ["gpt-image-2"]);
  // The photo is never named: the server reads it from the saved question.
  assert.equal(JSON.stringify(turn).includes("upload-1"), false);
  assert.equal(f.calls.some(call => call.path === "/api/chat"), false);
});

test("a photo the call does not want edited goes to chat as before", async () => {
  const f = fixture({ intent: { image: false } });
  await assert.rejects(send(f, "이 사진에 뭐가 있어?", [photo]), error => error.code === "SYNTHETIC_TEXT_ANSWER");
  assert.equal(f.calls.some(call => call.path.endsWith("/image-turn")), false);
});

test("without the server's edit capability, or without a photo, nothing is asked", async () => {
  for (const [options, files] of [[{ edits: false }, [photo]], [{}, [pdf]], [{}, []]]) {
    const f = fixture(options);
    await assert.rejects(send(f, "줄여줘", files));
    assert.equal(f.calls.some(call => call.path === "/api/chat/image-intent"), false);
    assert.equal(f.calls.some(call => call.path === "/api/chat"), true);
  }
});

test("an Auto turn the server decided is an edit passes the flag to the image turn", async () => {
  const f = fixture({ selectionMode: "auto", autoTurn: { modelIds: ["gpt-image-2"], preset: "standard", edit: true } });
  await send(f, "뒤의 소나무를 30% 줄여줘", [photo]);
  // Auto is asked on the server beside its router call, not by the app.
  assert.equal(f.calls.some(call => call.path === "/api/chat/image-intent"), false);
  assert.equal(body(f, "/image-turn").edit, true);
});
