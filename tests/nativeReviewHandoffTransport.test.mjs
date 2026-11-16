import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { nativeParityBearerRoute } from "../lib/nativeBearerGate.ts";

const bridge = { hasSession: async () => ({ signedIn: true }), signIn: async () => {}, signOut: async () => {} };
const handoffKey = ["14ec0419", "cec3", "45e4", "af2c", "96f99845ea69"].join("-");
const summary = { sourceMode: "recorded", sourceTurnCount: 3, nativeTurnCount: 2, nativeOmittedCount: 0, sourceOmittedCount: 0, attachmentsSupported: false };

test("native answer preparation sends only the anchor and its key, never executes or overwrites review:new", async () => {
  const calls = [];
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, init });
    return Response.json({ conversationId: "target", route: "/continuations/target", idempotentReplay: false, reviewHandoff: summary });
  }, bridge);
  const input = { assistantMessageId: "answer-a", idempotencyKey: handoffKey };
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
  const pending = transport.prepareReviewHandoff("parent", { assistantMessageId: "answer-a", idempotencyKey: handoffKey });
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
  const calls = [];
  const grant = `${Math.floor(Date.now() / 1000) + 60}.synthetic.signature`;
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push(path);
    if (path === "/api/products/mobile/capabilities") return Response.json({ reviewEasy: true, assistants: true, maxModels: 3, plan: "Max", historyActions: true });
    if (path === "/api/conversations/parent/verify") return Response.json({ unlockToken: grant });
    if (path === "/api/conversations/target/continuation?limit=1&offset=end") {
      assert.equal(new Headers(init.headers).get("X-Tomverse-Conversation-Unlocks"), `parent=${grant}`);
      return Response.json({ reviewHandoff: { status: "available" } });
    }
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
  await transport.history.unlock("parent", "synthetic password");
  await transport.sendReview(conversation, question, [], new AbortController().signal, () => {}, { revision: 7 });
  assert.equal(providerCalls, 1);
  assert.ok(calls.indexOf("/api/conversations/target/continuation?limit=1&offset=end") < calls.indexOf("/api/conversations/target/messages"));
  assert.equal(calls.includes("/api/chat/preflight"), false);
  assert.equal(savedBody.messages[0].content, question);
  assert.deepEqual(savedBody.draftConsume, { scopeKey: "target", expectedRevision: 7, requestId: savedBody.messages[0].clientRequestId });
});

for (const refusal of [
  { code: "CONVERSATION_LOCKED", status: 423 },
  { code: "REVIEW_HANDOFF_SOURCE_UNAVAILABLE", status: 409 },
  { code: "REVIEW_HANDOFF_PARENT_NOT_FOUND", status: 404 },
  { code: "REVIEW_HANDOFF_SOURCE_UNAVAILABLE", status: 503 },
]) test(`single-model handoff keeps its draft when source validation refuses ${refusal.status} ${refusal.code}`, async () => {
  const conversation = { id: "target", title: "Review", productKey: "review", reviewHandoff: true, selectedModels: ["fixture-model"], messages: [] };
  const draft = { revision: 7, text: "Follow the second option." };
  const calls = [];
  let draftConsumed = false;
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push(path);
    if (path === "/api/conversations/target/continuation?limit=1&offset=end") return Response.json({ code: refusal.code }, { status: refusal.status });
    if (path === "/api/conversations/target/messages") draftConsumed = true;
    throw Error(`Unexpected ${path}`);
  }, bridge);
  await assert.rejects(transport.sendReview(conversation, draft.text, [], new AbortController().signal, () => {}, { revision: draft.revision }), error => error.code === refusal.code && error.questionPersisted === false);
  assert.equal(draftConsumed, false);
  assert.equal(conversation.messages.length, 0);
  assert.equal(calls.includes("/api/chat"), false);
  assert.deepEqual(calls, ["/api/conversations/target/continuation?limit=1&offset=end"]);
});

for (const response of [{}, { reviewHandoff: { status: "unavailable" } }]) test(`single-model handoff requires explicit available context: ${JSON.stringify(response)}`, async () => {
  const conversation = { id: "target", title: "Review", productKey: "review", reviewHandoff: true, selectedModels: ["fixture-model"], messages: [] };
  const calls = [];
  const transport = createApiTransport(async path => {
    calls.push(path);
    return Response.json(response);
  }, bridge);
  await assert.rejects(transport.sendReview(conversation, "Question", [], new AbortController().signal, () => {}, { revision: 7 }), error => error.code === "REVIEW_HANDOFF_UNAVAILABLE" && error.questionPersisted === false);
  assert.deepEqual(calls, ["/api/conversations/target/continuation?limit=1&offset=end"]);
});

test("ordinary single-model Review still uses its existing direct send path", async () => {
  const conversation = { id: "ordinary", title: "Review", productKey: "review", selectedModels: ["fixture-model"], messages: [] };
  const calls = [];
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push(path);
    if (path === "/api/conversations/ordinary/messages") {
      const input = JSON.parse(init.body).messages[0];
      conversation.messages.push({ id: "question", role: "user", content: input.content });
      return Response.json({ messageMappings: [{ requestId: input.clientRequestId, messageId: "question" }] });
    }
    if (path === "/api/conversations/ordinary") return Response.json(conversation);
    if (path === "/api/chat") {
      const input = JSON.parse(init.body);
      conversation.messages.push({ id: input.assistantMessageId, role: "assistant", content: "Done", modelId: "fixture-model", status: "normal" });
      return new Response("Done\u0000TOMVERSE_SEARCH_METADATA" + JSON.stringify({ completion: { status: "normal" } }));
    }
    throw Error(`Unexpected ${path}`);
  }, bridge);
  await transport.sendReview(conversation, "Ordinary question", [], new AbortController().signal, () => {});
  assert.equal(calls.includes("/api/chat/preflight"), false);
  assert.equal(calls.some(path => path.includes("/continuation")), false);
});

test("late handoff source validation cannot persist after an A-to-B-to-A session transition", async () => {
  const conversation = { id: "target", title: "Review", productKey: "review", reviewHandoff: true, selectedModels: ["fixture-model"], messages: [] };
  const calls = [];
  let accountId = "account-a";
  let finishValidation;
  const transport = createApiTransport(async path => {
    calls.push(path);
    if (path === "/api/user/account") return Response.json({ id: accountId, actionsEnabled: false });
    if (path === "/api/conversations/target/continuation?limit=1&offset=end") return new Promise(resolve => { finishValidation = resolve; });
    throw Error(`Unexpected ${path}`);
  }, bridge);
  await transport.account();
  const pending = transport.sendReview(conversation, "Keep my draft", [], new AbortController().signal, () => {}, { revision: 7 });
  await transport.signOut();
  accountId = "account-b";
  await transport.signIn();
  await transport.account();
  await transport.signOut();
  accountId = "account-a";
  await transport.signIn();
  await transport.account();
  finishValidation(Response.json({ reviewHandoff: { status: "available" } }));
  await assert.rejects(pending, error => error.name === "AbortError" && error.questionPersisted === false);
  assert.equal(calls.some(path => path.endsWith("/messages")), false);
  assert.equal(calls.includes("/api/chat"), false);
  assert.equal(conversation.messages.length, 0);
});
