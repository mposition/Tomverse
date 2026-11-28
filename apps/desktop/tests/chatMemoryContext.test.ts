import assert from "node:assert/strict";
import test from "node:test";
import type { ChatConversation } from "../src/chat-contract";
import { DesktopChatContextChanged, desktopChatApi } from "../src/host/chat-api";

const origin = "http://127.0.0.1:44183";
const modelId = "gpt-6-luna";
const current: ChatConversation = {
  id: "owned-chat", title: "Desktop fixture", kind: "chat", surface: "chat", productKey: "chat",
  messages: [
    { id: "earlier", role: "user", content: "An earlier prompt.", artifacts: [] },
    { id: "saved-question", role: "user", content: "Use my saved preferences.", artifacts: [] },
  ],
  messagePage: { nextCursor: null }, selectionMode: "manual", selectedModels: [modelId],
  autoSelection: { offered: false }, webSearchMode: "off",
};
const input = { modelId, selectionMode: "manual", effort: "default" } as const;
const stale = () => Response.json({ code: "CHAT_CONTEXT_BUNDLE_STALE", details: { requiresPreflight: true } }, { status: 409 });
const answer = () => new Response("A test answer", { headers: { "Content-Type": "text/plain" } });

test("Desktop saves the visible replacement for a retired manual model", async (t) => {
  const updates: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, request: RequestInit) => {
    assert.equal(url.pathname, "/api/conversations/owned-chat");
    assert.equal(request.method, "PATCH");
    updates.push(JSON.parse(String(request.body)));
    return Response.json({ id: current.id });
  });
  const signal = new AbortController().signal;
  const api = desktopChatApi("fixture-bearer", signal, origin);
  const turn = { ...input, requestId: "00000000-0000-4000-8000-000000000001", prompt: "Use my saved preferences." };
  const legacy = { ...current, storedSelectedModels: ["retired-model"] };
  await api.configure(legacy, turn, signal);
  await api.configure({ ...legacy, selectionMode: "auto" }, { ...turn, selectionMode: "auto" }, signal);
  await api.configure(current, turn, signal);
  assert.deepEqual(updates, [{ selectionMode: "manual", selectedModels: [modelId] }]);
});

test("a Review saves the \"+\" menu's choices with its models, and alone when the models did not change", async (t) => {
  const updates: unknown[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, request: RequestInit) => {
    assert.equal(url.pathname, "/api/conversations/owned-chat");
    assert.equal(request.method, "PATCH");
    updates.push(JSON.parse(String(request.body)));
    return Response.json({ id: current.id });
  });
  const signal = new AbortController().signal;
  const api = desktopChatApi("fixture-bearer", signal, origin);
  await api.configureReview(current, [modelId], signal);
  await api.configureReview(current, [modelId], signal, {});
  await api.configureReview(current, [modelId], signal, { webSearchMode: "always" });
  await api.configureReview(current, [modelId, "gemini-4-argon"], signal, { memoryMode: "off", assistantProfileId: null });
  await api.configureReview(current, ["gemini-4-argon"], signal);
  assert.deepEqual(updates, [{ webSearchMode: "always" },
    { selectedModels: [modelId, "gemini-4-argon"], selectionMode: "manual", memoryMode: "off", assistantProfileId: null },
    { selectedModels: ["gemini-4-argon"], selectionMode: "manual" }]);
});

test("Desktop prepares the saved Chat context and retries one stale refusal without changing turn identity", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const responses = [Response.json({ ok: true, contextBundle: "first-bundle" }), stale(),
    Response.json({ ok: true, contextBundle: "refreshed-bundle" }), answer()];
  t.mock.method(globalThis, "fetch", async (url: URL, request: RequestInit) => {
    assert.equal(url.origin, origin);
    assert.equal(request.credentials, "omit");
    assert.equal(new Headers(request.headers).get("origin"), "tomverse://desktop");
    calls.push({ path: url.pathname, body: JSON.parse(String(request.body)) });
    return responses[calls.length - 1]!;
  });
  const signal = new AbortController().signal;
  const api = desktopChatApi("fixture-bearer", signal, origin);
  const progress: string[] = [];
  await api.stream(current, input, "saved-question", "same-answer", signal, (text) => progress.push(text));
  assert.deepEqual(calls.map(({ path }) => path), ["/api/chat/context", "/api/chat", "/api/chat/context", "/api/chat"]);
  const preparation = { conversationId: current.id, modelId, sourceUserMessageId: "saved-question" };
  assert.deepEqual(calls[0]?.body, preparation);
  assert.deepEqual(calls[2]?.body, { ...preparation, previousContextBundle: "first-bundle" });
  assert.equal(calls[1]?.body.contextBundle, "first-bundle");
  assert.equal(calls[3]?.body.assistantMessageId, "same-answer");
  assert.deepEqual(calls[3]?.body, { ...calls[1]?.body, contextBundle: "refreshed-bundle" });
  assert.equal(progress.at(-1), "A test answer");
});

test("Desktop shares only a fresh coarse location, with the selected Chat stream and with each model of a Review", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, request: RequestInit) => {
    calls.push({ path: url.pathname, body: JSON.parse(String(request.body)) });
    return url.pathname === "/api/chat/context" ? Response.json({ ok: true, contextBundle: "fixture-bundle" }) : answer();
  });
  const signal = new AbortController().signal;
  const now = Date.now();
  const location = { latitude: -27.46551, longitude: 153.025879, accuracy: 23, timestamp: now };
  const api = desktopChatApi("fixture-bearer", signal, origin);
  await api.stream(current, { ...input, currentLocation: location }, "saved-question", "location-answer", signal, () => {});
  await api.stream(current, { ...input, currentLocation: { ...location, timestamp: now - 600_000 } },
    "saved-question", "stale-location-answer", signal, () => {});
  await api.stream(current, { ...input, review: true, currentLocation: location },
    "saved-question", "review-answer", signal, () => {});
  assert.deepEqual(calls.map(({ path }) => path), ["/api/chat/context", "/api/chat", "/api/chat/context", "/api/chat", "/api/chat"]);
  const coarse = { latitude: -27.466, longitude: 153.026, accuracy: 150, timestamp: now };
  assert.deepEqual(calls[1]?.body.currentLocation, coarse);
  assert.deepEqual(calls[4]?.body.currentLocation, coarse);
  assert.deepEqual([0, 2, 3].map((index) => calls[index]?.body.currentLocation), [undefined, undefined, undefined]);
});

test("Desktop leaves a second stale refusal unresolved and keeps Review on its shared admission", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  t.mock.method(globalThis, "fetch", async (url: URL, request: RequestInit) => {
    const body = JSON.parse(String(request.body));
    calls.push({ path: url.pathname, body });
    if (url.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: "fixture-bundle" });
    return body.admissionToken ? answer() : stale();
  });
  const signal = new AbortController().signal;
  const api = desktopChatApi("fixture-bearer", signal, origin);
  await assert.rejects(api.stream(current, input, "saved-question", "same-answer", signal, () => assert.fail("No stream has started")),
    DesktopChatContextChanged);
  assert.deepEqual(calls.map(({ path }) => path), ["/api/chat/context", "/api/chat", "/api/chat/context", "/api/chat"]);
  await api.stream(current, { ...input, review: true, admission: { admissionToken: "review-admission", contextBundle: "review-bundle" } },
    "saved-question", "review-answer", signal, () => undefined);
  assert.equal(calls.length, 5);
  assert.equal(calls[4]?.body.admissionToken, "review-admission");
  assert.equal(calls[4]?.body.contextBundle, "review-bundle");
});

test("a Review turn that one model answers alone prepares its own context where the server offers it, and retries one stale refusal", async (t) => {
  const calls: { path: string; body: Record<string, unknown> }[] = [];
  const responses = [answer(), Response.json({ ok: true, contextBundle: "review-first" }), stale(),
    Response.json({ ok: true, contextBundle: "review-refreshed" }), answer(), answer()];
  t.mock.method(globalThis, "fetch", async (url: URL, request: RequestInit) => {
    calls.push({ path: url.pathname, body: JSON.parse(String(request.body)) });
    return responses[calls.length - 1]!;
  });
  const signal = new AbortController().signal;
  const api = desktopChatApi("fixture-bearer", signal, origin);
  // A server that does not offer it: the turn is sent as before, without a context.
  await api.stream(current, { ...input, review: true }, "saved-question", "plain-answer", signal, () => {});
  assert.deepEqual(calls.map(({ path }) => path), ["/api/chat"]);
  assert.equal("contextBundle" in calls[0]!.body, false);
  await api.stream(current, { ...input, review: true, reviewContext: true }, "saved-question", "own-answer", signal, () => {});
  assert.deepEqual(calls.slice(1).map(({ path }) => path), ["/api/chat/context", "/api/chat", "/api/chat/context", "/api/chat"]);
  assert.deepEqual(calls[1]?.body, { conversationId: current.id, modelId, sourceUserMessageId: "saved-question" });
  assert.equal(calls[2]?.body.contextBundle, "review-first");
  assert.equal(calls[3]?.body.previousContextBundle, "review-first");
  assert.equal(calls[4]?.body.contextBundle, "review-refreshed");
  // Several models share the admission's context and prepare none of their own.
  await api.stream(current, { ...input, review: true, reviewContext: true, admission: { admissionToken: "shared", contextBundle: "shared-bundle" } },
    "saved-question", "shared-answer", signal, () => {});
  assert.deepEqual(calls.slice(5).map(({ path }) => path), ["/api/chat"]);
  assert.equal(calls[5]?.body.contextBundle, "shared-bundle");
});
