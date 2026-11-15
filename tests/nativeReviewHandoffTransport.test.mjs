import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { nativeParityBearerRoute } from "../lib/nativeBearerGate.ts";

const bridge = { hasSession: async () => ({ signedIn: true }), signIn: async () => {}, signOut: async () => {} };
const summary = { sourceMode: "recorded", sourceTurnCount: 3, nativeTurnCount: 2, nativeOmittedCount: 0, sourceOmittedCount: 0, attachmentsSupported: false };

test("native answer preparation sends only the anchor and its key, never executes or overwrites review:new", async () => {
  const calls = [];
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, init });
    return Response.json({ conversationId: "target", route: "/continuations/target", idempotentReplay: false, reviewHandoff: summary });
  }, bridge);
  const input = { assistantMessageId: "answer-a", idempotencyKey: "14ec0419-cec3-45e4-af2c-96f99845ea69" };
  const result = await transport.prepareReviewHandoff("parent", input);
  assert.equal(result.conversationId, "target");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/conversations/parent/continuation/review-handoff");
  assert.deepEqual(JSON.parse(calls[0].init.body), input);
});

test("native handoff enrollment is exact-path, method-limited and default-off", () => {
  const path = "/api/conversations/parent/continuation/review-handoff";
  assert.equal(nativeParityBearerRoute(path, "POST"), false);
  assert.equal(nativeParityBearerRoute(path, "POST", true), true);
  assert.equal(nativeParityBearerRoute(path, "PUT", true), false);
  for (const method of ["GET", "PUT", "DELETE"]) assert.equal(nativeParityBearerRoute(`${path}/draft`, method, true), true);
  assert.equal(nativeParityBearerRoute(`${path}/draft`, "POST", true), false);
  assert.equal(nativeParityBearerRoute(`${path}/draft/other`, "GET", true), false);
});

test("native late preparation cannot cross a signed-out session", async () => {
  let finish;
  const transport = createApiTransport(() => new Promise(resolve => { finish = resolve; }), bridge);
  const pending = transport.prepareReviewHandoff("parent", { assistantMessageId: "answer-a", idempotencyKey: "14ec0419-cec3-45e4-af2c-96f99845ea69" });
  await transport.signOut();
  finish(Response.json({ conversationId: "target", route: "/continuations/target", reviewHandoff: summary }));
  await assert.rejects(pending, { name: "AbortError" });
});

test("native Review uses the narrow durable draft API with its expected revision", async () => {
  const calls = [];
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, init });
    return Response.json({ scopeKey: "target", draft: null });
  }, bridge);
  await transport.reviewHandoffDraft.get("target");
  await transport.reviewHandoffDraft.put("target", { text: "Edited question", attachmentReferences: [], expectedRevision: 2 });
  await transport.reviewHandoffDraft.remove("target", 3);
  assert.ok(calls.every(call => call.path === "/api/conversations/target/continuation/review-handoff/draft"));
  assert.deepEqual(calls.map(call => call.init.method ?? "GET"), ["GET", "PUT", "DELETE"]);
  assert.deepEqual(JSON.parse(calls[1].init.body), { text: "Edited question", attachmentReferences: [], expectedRevision: 2 });
});

test("native bootstrap preserves the handoff marker when its source cannot be loaded", async () => {
  const transport = createApiTransport(async path => {
    if (path === "/api/conversations/target") return Response.json({ id: "target", surface: "continuation", productKey: "review", reviewHandoff: true, messages: [], selectedModels: [] });
    return Response.json({ code: "REVIEW_HANDOFF_UNAVAILABLE" }, { status: 409 });
  }, bridge);
  const result = await transport.load("target");
  assert.equal(result.reviewHandoff, true);
  assert.equal(result.imported, undefined);
});

test("native Review preserves exact long draft text and consumes its revision with the user Message", async () => {
  const question = `  ${"Follow the second option. ".repeat(70)}  `;
  const conversation = { id: "target", title: "Review", productKey: "review", reviewHandoff: true, selectedModels: ["fixture-model"], messages: [] };
  let savedBody;
  let providerCalls = 0;
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    if (path === "/api/conversations/target/messages") {
      savedBody = JSON.parse(init.body);
      conversation.messages.push({ id: "question", role: "user", content: savedBody.messages[0].content });
      return Response.json({ messageMappings: [{ requestId: savedBody.messages[0].clientRequestId, messageId: "question" }], draftConsumed: true });
    }
    if (path === "/api/conversations/target") return Response.json(conversation);
    if (path === "/api/chat") {
      providerCalls++;
      const input = JSON.parse(init.body);
      conversation.messages.push({ id: input.assistantMessageId, role: "assistant", content: "Done", modelId: "fixture-model", status: "normal" });
      return new Response("Done\u0000TOMVERSE_SEARCH_METADATA" + JSON.stringify({ completion: { status: "normal" } }));
    }
    throw Error(`Unexpected ${path}`);
  }, bridge);
  await transport.sendReview(conversation, question, [], new AbortController().signal, () => {}, { revision: 7 });
  assert.equal(providerCalls, 1);
  assert.equal(savedBody.messages[0].content, question);
  assert.deepEqual(savedBody.draftConsume, { scopeKey: "target", expectedRevision: 7, requestId: savedBody.messages[0].clientRequestId });
});
