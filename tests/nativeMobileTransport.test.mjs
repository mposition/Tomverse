import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { chatStreamDisplayText } from "../packages/chat-core/src/streamText.ts";
import { nativeChatBearerRoute } from "../lib/nativeChatRoutes.ts";
import { mobileErrorText } from "../locales/mobileErrors.ts";

const bridge = { hasSession: async () => ({ signedIn: true }), signIn: async () => {}, signOut: async () => {} };
function fixture({ unknown = false } = {}) {
  const calls = []; let turns = 0;
  const conversation = { id: "conversation-a", title: "Test", selectedModels: ["fixture-model"], messages: [], responseAttempts: [] };
  const run = async (path, init = {}) => {
    calls.push({ path, ...init });
    if (path === "/api/products/chat/conversations") return Response.json({ id: conversation.id });
    if (path === "/api/conversations/conversation-a/messages") {
      const input = JSON.parse(init.body).messages[0];
      conversation.messages.push({ id: "saved-source", role: "user", content: input.content });
      return Response.json({ messageMappings: [{ requestId: input.clientRequestId, messageId: "saved-source" }] });
    }
    if (path === "/api/conversations/conversation-a") return Response.json(conversation);
    if (path.startsWith("/api/products/chat/attempts/")) return Response.json({ attempt: conversation.responseAttempts[0] });
    if (path === "/api/chat") {
      turns++; const input = JSON.parse(init.body);
      assert.equal(input.sourceUserMessageId, "saved-source");
      assert.equal(input.messages.at(-1).id, "saved-source");
      assert.equal(input.modelId, "fixture-model");
      if (unknown) {
        conversation.responseAttempts = [{ assistantMessageId: input.assistantMessageId, requestedModelId: "fixture-model", status: "streaming", partialContent: "Saved partial" }];
        throw Error("Connection lost after dispatch");
      }
      conversation.messages.push({ id: input.assistantMessageId, role: "assistant", content: "안녕하세요!", status: "normal" });
      const bytes = new TextEncoder().encode('안녕하세요!\u0000TOMVERSE_SEARCH_METADATA{"completion":{"status":"normal"}}');
      return new Response(new ReadableStream({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } }));
    }
    throw Error(`Unexpected request ${path}`);
  };
  return { transport: createApiTransport(run, bridge), conversation, calls, turns: () => turns };
}

test("native enrollment is default-off, exact-path and method limited", () => {
  assert.equal(nativeChatBearerRoute("/api/chat", "POST", false), false);
  assert.equal(nativeChatBearerRoute("/api/chat", "POST", true), true);
  assert.equal(nativeChatBearerRoute("/api/chat", "DELETE", true), false);
  assert.equal(nativeChatBearerRoute("/api/chat/other", "POST", true), false);
  assert.equal(nativeChatBearerRoute("/api/conversations/c1/messages", "POST", true), true);
  assert.equal(nativeChatBearerRoute("/api/conversations/c1/messages", "DELETE", true), false);
  assert.equal(nativeChatBearerRoute("/api/conversations/c1/share", "POST", true), false);
  assert.equal(nativeChatBearerRoute("/api/admin/users", "GET", true), false);
  assert.equal(nativeChatBearerRoute("/api/conversations/%2Fadmin", "PATCH", true), false);
});

test("shared stream display holds every partial control and respects quoted braces", () => {
  const marker = '\u0000TOMVERSE_ROUTING_RETRY{"modelId":"a}\\\"b","nested":{"x":1}}';
  for (let i = 1; i < marker.length; i++) assert.equal(chatStreamDisplayText(`Hello${marker.slice(0, i)}`), "Hello");
  assert.equal(chatStreamDisplayText(`Hello${marker} world`), "Hello world");
  assert.equal(chatStreamDisplayText('Hello\u0000TOMVERSE_SEARCH_METADATA{}'), "Hello");
});

test("native send saves once, adopts the server message identity and streams split UTF-8", async () => {
  const f = fixture(); const progress = [];
  await f.transport.send(f.conversation, "A question", [], new AbortController().signal, (value) => progress.push(value));
  assert.equal(progress.at(-1), "안녕하세요!");
  assert.ok(progress.every((value) => !value.includes("TOMVERSE") && !value.includes("�")));
  assert.equal(f.turns(), 1);
  assert.equal(f.calls.filter((call) => call.path.endsWith("/messages")).length, 1);
  const restored = await f.transport.load("conversation-a");
  assert.equal(restored.messages.at(-1).content, "안녕하세요!");
});

test("unknown chat execution is never resubmitted; restoration reads its durable checkpoint", async () => {
  const f = fixture({ unknown: true });
  await assert.rejects(f.transport.send(f.conversation, "A question", [], new AbortController().signal, () => {}));
  const restored = await f.transport.load("conversation-a");
  assert.equal(restored.activeAttempt, true);
  assert.equal(restored.messages.at(-1).content, "Saved partial");
  assert.equal(f.turns(), 1);
});

test("a final 401 invalidates the UI session and never turns into a guest request", async () => {
  const calls = []; const transport = createApiTransport(async (path) => { calls.push(path); return Response.json({ code: "MOBILE_REFRESH_REJECTED" }, { status: 401 }); }, bridge);
  let invalidated = 0; transport.onSessionLost(() => invalidated++);
  await assert.rejects(transport.list());
  assert.equal(invalidated, 1); assert.deepEqual(calls, ["/api/conversations"]);
});

test("restoration reconciles expired execution before enabling another send", async () => {
  const calls = []; let expired = false;
  const attempt = { assistantMessageId: "attempt-a", requestedModelId: "fixture-model", partialContent: "Saved partial" };
  const transport = createApiTransport(async (path) => {
    calls.push(path);
    if (path === "/api/products/chat/attempts/attempt-a") { expired = true; return Response.json({ attempt: { ...attempt, status: "failed" } }); }
    return Response.json({ id: "conversation-a", messages: [], selectedModels: ["fixture-model"], responseAttempts: [{ ...attempt, status: expired ? "failed" : "streaming" }] });
  }, bridge);
  const restored = await transport.load("conversation-a");
  assert.equal(restored.activeAttempt, false);
  assert.equal(restored.messages.at(-1).status, "failed");
  assert.equal(restored.messages.at(-1).content, "Saved partial");
  assert.deepEqual(calls, ["/api/conversations/conversation-a", "/api/products/chat/attempts/attempt-a", "/api/conversations/conversation-a"]);
});

test("voice transcription returns editable text and makes no chat execution", async () => {
  const calls = []; const transport = createApiTransport(async (path, init) => { calls.push({ path, init }); return Response.json({ transcript: "Hello 안녕하세요" }); }, bridge);
  const signal = new AbortController().signal;
  assert.equal(await transport.transcribe(new Blob(["synthetic"], { type: "audio/webm" }), signal), "Hello 안녕하세요");
  assert.equal(calls[0].path, "/api/chat/voice-transcription"); assert.equal(calls[0].init.signal, signal); assert.equal(calls.length, 1);
});

test("unsupported attachments stop before preparation or external upload", async () => {
  const transport = createApiTransport(async () => { throw Error("must not call"); }, bridge);
  await assert.rejects(transport.upload(new File(["no"], "file.exe", { type: "application/octet-stream" })), /ATTACHMENT_UNSUPPORTED_FORMAT/);
});

test("browser cancellation codes preserve the recovery message", () => {
  assert.equal(mobileErrorText(new DOMException("Aborted", "AbortError"), "ko", "Read saved answer"), "Read saved answer");
  assert.equal(mobileErrorText({ code: null }, "en", "Fallback"), "Fallback");
  assert.match(mobileErrorText({ code: "ATTACHMENT_UNSUPPORTED_FORMAT" }, "en", "Fallback"), /not supported/);
});
