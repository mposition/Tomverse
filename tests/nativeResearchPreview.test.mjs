import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { webResearchPreviewRuns } from "../lib/researchPreviewRunClient.ts";

const modelId = "gemini-3-1-pro";
const question = "Compare public product specifications.";
const bridge = { hasSession: async () => ({ signedIn: true }), signOut: async () => {} };
function fixture({ enabled = true, durable = false, unknownCreate = false } = {}) {
  const calls = []; const runs = [];
  const conversation = { id: "research-chat", title: "Research", selectedModels: [modelId], selectionMode: "manual", webSearchMode: "off", messages: [
    { id: "private-message", role: "user", content: "Private history must not reach Research." },
  ] };
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, ...init });
    if (path === "/api/products/mobile/capabilities") return Response.json({ reviewEasy: true, assistants: true, maxModels: 3, plan: "Max", researchPreview: { enabled, pageReading: false, durableRuns: durable } });
    if (path === "/api/chat/research-preview/offer") return Response.json({ offered: true, reason: "ready", estimatedCredits: 24, features: { pageReading: false, durableRuns: durable } });
    if (path === "/api/conversations/research-chat/messages") {
      const message = JSON.parse(init.body).messages[0];
      conversation.messages.push({ id: "saved-question", role: "user", content: message.content });
      return Response.json({ messageMappings: [{ requestId: message.clientRequestId, messageId: "saved-question" }] });
    }
    if (path === "/api/conversations/research-chat") return Response.json(conversation);
    if (path.startsWith("/api/chat/research-preview/runs?")) return Response.json({ runs });
    if (path === "/api/chat/research-preview/runs") {
      const body = JSON.parse(init.body);
      runs.push({ id: "run_1", conversationId: conversation.id, assistantMessageId: body.assistantMessageId, modelId,
        status: "queued", stepCount: 0, searchCount: 0, readCount: 0, canResume: false,
        createdAt: "2026-11-15T00:00:00.000Z", updatedAt: "2026-11-15T00:00:00.000Z" });
      if (unknownCreate) throw new TypeError("Connection lost after create");
      return Response.json({ run: runs[0] }, { status: 201 });
    }
    if (path.startsWith("/api/chat/research-preview/runs/run_1")) {
      if (path.endsWith("/resume")) runs[0] = { ...runs[0], status: "running", canResume: false };
      if (path.endsWith("/cancel")) runs[0] = { ...runs[0], status: "cancelled", canResume: false };
      return Response.json({ run: runs[0] });
    }
    if (path === "/api/chat") {
      const body = JSON.parse(init.body);
      conversation.messages.push({ id: body.assistantMessageId, role: "assistant", content: "Research result", status: "normal", modelId });
      return new Response("Research result", { headers: { "Content-Type": "text/plain" } });
    }
    throw new Error(`Unexpected request: ${path}`);
  }, bridge);
  return { transport, conversation, calls };
}
const send = (f, files = []) => f.transport.sendResearchPreview(f.conversation, question, files, new AbortController().signal, () => {}, { durable: true, locale: "en" });

test("native Research sends only the current saved public question and keeps model/settings unchanged", async () => {
  const f = fixture(); await send(f);
  const chat = f.calls.find(call => call.path === "/api/chat");
  const body = JSON.parse(chat.body);
  assert.equal(body.researchMode, "preview");
  assert.deepEqual(body.messages, [{ id: "saved-question", role: "user", content: question }]);
  for (const key of ["contextBundle", "currentLocation", "mcpConnectionId"]) assert.equal(body[key], undefined);
  assert.equal(f.calls.some(call => call.path.includes("location-intent") || call.path.includes("image-intent")), false);
  assert.equal(f.conversation.webSearchMode, "off"); assert.deepEqual(f.conversation.selectedModels, [modelId]);
});

test("unsupported native capability, Auto and attachments refuse before saving or dispatching", async () => {
  for (const variant of ["disabled", "auto", "attachment"]) {
    const f = fixture({ enabled: variant !== "disabled" });
    if (variant === "auto") f.conversation.selectionMode = "auto";
    await assert.rejects(send(f, variant === "attachment" ? [{ uploadId: "private", name: "private.txt" }] : []));
    assert.equal(f.calls.some(call => call.path.endsWith("/messages") || call.path === "/api/chat" || call.path === "/api/chat/research-preview/runs"), false);
  }
});

test("durable native create never invokes the stream or legacy Perplexity polling", async () => {
  const f = fixture({ durable: true }); await send(f);
  assert.equal(f.calls.filter(call => call.path === "/api/chat/research-preview/runs").length, 1);
  assert.equal(f.calls.some(call => call.path === "/api/chat" || call.path === "/api/chat/deep-research/status"), false);
  const reloaded = await f.transport.load(f.conversation.id);
  assert.equal(reloaded.messages.at(-1).researchRunId, "run_1");
  assert.equal(f.calls.filter(call => call.path === "/api/chat/research-preview/runs").length, 1);
});

test("a create with unknown outcome is discovered through reads without a second paid submit", async () => {
  const f = fixture({ durable: true, unknownCreate: true }); await assert.rejects(send(f));
  const reloaded = await f.transport.load(f.conversation.id);
  assert.equal(reloaded.messages.at(-1).researchRunId, "run_1");
  assert.equal(f.calls.filter(call => call.path === "/api/chat/research-preview/runs").length, 1);
  assert.equal(f.calls.some(call => /\/(resume|cancel)$/.test(call.path)), false);
});

test("native durable reads and explicit controls unwrap the API run envelope", async () => {
  const f = fixture({ durable: true }); await send(f);
  assert.equal((await f.transport.researchRuns.read("run_1")).id, "run_1");
  assert.equal(f.calls.some(call => /\/(resume|cancel)$/.test(call.path)), false);
  assert.equal((await f.transport.researchRuns.resume("run_1")).status, "running");
  assert.equal((await f.transport.researchRuns.cancel("run_1")).status, "cancelled");
  assert.equal(f.calls.filter(call => call.path === "/api/chat/research-preview/runs").length, 1);
});

test("web durable controls unwrap run envelopes and never retry an unsafe resume", async t => {
  const calls = [];
  t.mock.method(globalThis, "fetch", async (path, init) => {
    calls.push({ path, ...init });
    if (path.endsWith("/resume")) return Response.json({ code: "RESEARCH_RUN_CANNOT_RESUME" }, { status: 409 });
    return Response.json({ run: { id: "run_1", status: path.endsWith("/cancel") ? "cancelled" : "checkpointed" } });
  });
  assert.equal((await webResearchPreviewRuns.read("run_1")).status, "checkpointed");
  await assert.rejects(webResearchPreviewRuns.resume("run_1"), /RESEARCH_RUN_UNAVAILABLE/);
  assert.equal(calls.length, 2);
  assert.equal((await webResearchPreviewRuns.cancel("run_1")).status, "cancelled");
  assert.deepEqual(calls.map(call => call.method), ["GET", "POST", "POST"]);
});

test("the Research run card shared with Native imports nothing that needs the Web providers", async () => {
  // Web-only pieces (the LanguageProvider hooks, "save to project") throw
  // outside the Web app. The card takes such an action as a prop instead, so a
  // completed run in Native renders its report.
  const { readFileSync } = await import("node:fs");
  const card = readFileSync("components/chat/ResearchPreviewRunCard.tsx", "utf8");
  for (const forbidden of ["components/projects/", "LanguageProvider", "@/components/"]) {
    assert.equal(card.includes(forbidden), false, forbidden);
  }
});
