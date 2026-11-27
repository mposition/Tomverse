import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { chatConversation, chatTurnInput, type ChatConversation } from "../src/chat-contract";
import { desktopChatApi } from "../src/host/chat-api";
import { readDesktopCapabilities } from "../src/host/desktop-capabilities";
import type { AccountSettingsApi } from "../src/host/account-settings-api";
import { prepareRefinedTurn, refinerEligible } from "../src/host/prompt-refiner";

type Call = { path: string; method?: string; body?: Record<string, unknown>; accept?: string; timeout?: number };
const conversationId = "chat_owned_1";
const scopeId = randomUUID();
const suggestionId = randomUUID();
const clientRequestId = randomUUID();

/** A stand-in for the account settings session: it answers what each Refiner route would, and keeps what it was asked. */
function server(answers: {
  put?: () => Response; scope?: () => Response; prepare?: () => Response; remove?: () => Response;
} = {}) {
  const calls: Call[] = [];
  const send = async (request: { path: string; method?: string; body?: object }, accept?: string, timeout?: number) => {
    calls.push({ path: request.path, method: request.method, body: request.body as Record<string, unknown> | undefined, accept, timeout });
    if (request.method === "PUT") return answers.put?.() ?? Response.json({ draft: { revision: 1, text: "x" } });
    if (request.method === "DELETE") return answers.remove?.() ?? new Response(null, { status: 204 });
    if (request.path.endsWith("/scope")) return answers.scope?.() ?? Response.json({ scopeId, epoch: 3 });
    return answers.prepare?.() ?? Response.json({ outcome: "auto_held", clientRequestId,
      decision: { suggestionId, scopeId, epoch: 3, decision: "accepted" } });
  };
  return { calls, send: send as unknown as AccountSettingsApi["send"] };
}
const signal = () => new AbortController().signal;

test("an Auto turn writes its draft, takes a scope, prepares, and hands back the decision and the request id the server minted", async () => {
  const fake = server();
  const attempt = await prepareRefinedTurn(fake, { conversationId, prompt: "fix my typos pls" }, signal());
  assert.deepEqual(attempt.refined, { decision: { suggestionId, scopeId, epoch: 3, decision: "accepted" }, clientRequestId });
  assert.deepEqual(fake.calls.map(({ method, path }) => `${method} ${path}`), [
    `PUT /api/products/chat/drafts/${conversationId}`, "POST /api/chat/prompt-refiner/scope", "POST /api/chat/prompt-refiner/prepare",
  ]);
  // A draft is only ever created: a revision-0 write cannot overwrite one the web already holds.
  assert.deepEqual(fake.calls[0].body, { expectedRevision: 0, text: "fix my typos pls", attachmentReferences: [] });
  assert.deepEqual(fake.calls[1].body?.surface, "chat");
  // The mount id is the app run's own: a second turn takes the same scope row and moves its epoch.
  const second = server();
  await prepareRefinedTurn(second, { conversationId, prompt: "again" }, signal());
  assert.equal(second.calls[1].body?.mountId, fake.calls[1].body?.mountId);
  assert.match(String(fake.calls[1].body?.mountId), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.deepEqual(fake.calls[2].body, { conversationId, scopeId, epoch: 3, draftRevision: 1 });
  // Nothing in what Desktop sends after the draft carries the typed text, and the rewrite never comes back to it.
  assert.equal(JSON.stringify(fake.calls.slice(1)).includes("typos"), false);
  assert.ok((fake.calls[2].timeout ?? 0) >= 13_000, "the budgeted Refiner call gets the server's own deadline");
  await attempt.finish();
  assert.deepEqual(fake.calls.at(-1), { path: `/api/products/chat/drafts/${conversationId}`, method: "DELETE", body: { expectedRevision: 1 },
    accept: "application/json", timeout: 8_000 });
  await attempt.finish();
  assert.equal(fake.calls.filter(({ method }) => method === "DELETE").length, 1, "the draft is removed once");
});

test("a draft the web already holds, or a refused scope, sends the turn as typed with no Refiner call", async () => {
  const conflict = server({ put: () => Response.json({ code: "CHAT_DRAFT_REVISION_CONFLICT" }, { status: 409 }) });
  const first = await prepareRefinedTurn(conflict, { conversationId, prompt: "hello" }, signal());
  assert.equal(first.refined, null);
  assert.deepEqual(conflict.calls.map(({ path }) => path), [`/api/products/chat/drafts/${conversationId}`]);
  await first.finish();
  assert.equal(conflict.calls.length, 1, "a draft this attempt did not write is never removed");

  const refused = server({ scope: () => Response.json({ code: "PROMPT_REFINER_STALE" }, { status: 409 }) });
  const second = await prepareRefinedTurn(refused, { conversationId, prompt: "hello" }, signal());
  assert.equal(second.refined, null);
  assert.deepEqual(refused.calls.map(({ method }) => method), ["PUT", "POST"]);
  await second.finish();
  assert.equal(refused.calls.at(-1)?.method, "DELETE", "the draft this attempt wrote is removed");
});

test("every way the server declines is the typed original, once, and the draft is still cleaned up", async () => {
  const reasons: Array<[string, () => Response]> = [
    ["fallback", () => Response.json({ outcome: "original_fallback", reason: "budget_exhausted" })],
    ["error", () => Response.json({ code: "PROMPT_REFINER_UNAVAILABLE" }, { status: 503 })],
    ["malformed", () => Response.json({ outcome: "auto_held", decision: { suggestionId: "nope" } })],
    ["another scope", () => Response.json({ outcome: "auto_held", clientRequestId,
      decision: { suggestionId, scopeId: randomUUID(), epoch: 3, decision: "accepted" } })],
    ["another epoch", () => Response.json({ outcome: "auto_held", clientRequestId,
      decision: { suggestionId, scopeId, epoch: 4, decision: "accepted" } })],
    ["kept original", () => Response.json({ outcome: "auto_held", clientRequestId,
      decision: { suggestionId, scopeId, epoch: 3, decision: "kept_original" } })],
  ];
  for (const [name, prepare] of reasons) {
    const fake = server({ prepare });
    const attempt = await prepareRefinedTurn(fake, { conversationId, prompt: "hello" }, signal());
    assert.equal(attempt.refined, null, name);
    assert.equal(fake.calls.filter(({ path }) => path.endsWith("/prepare")).length, 1, `${name}: one attempt, no retry`);
    await attempt.finish();
    assert.equal(fake.calls.at(-1)?.method, "DELETE", name);
  }
});

test("a transport failure is the typed original, and a stop ends the turn after removing the draft", async () => {
  const failing = server();
  const broken = { ...failing, send: (async (request: { path: string; method?: string }) => {
    if (request.path.endsWith("/prepare")) throw new TypeError("network down");
    return failing.send(request as never);
  }) as unknown as AccountSettingsApi["send"] };
  const attempt = await prepareRefinedTurn(broken, { conversationId, prompt: "hello" }, signal());
  assert.equal(attempt.refined, null);
  await attempt.finish();
  assert.equal(failing.calls.at(-1)?.method, "DELETE");

  const stop = new AbortController();
  const stopping = server({ scope: () => { stop.abort(); return Response.json({ scopeId, epoch: 3 }); } });
  await assert.rejects(prepareRefinedTurn(stopping, { conversationId, prompt: "hello" }, stop.signal));
  assert.equal(stopping.calls.some(({ path }) => path.endsWith("/prepare")), false, "no paid call after the stop");
  assert.equal(stopping.calls.at(-1)?.method, "DELETE");
});

test("a failing cleanup never fails the turn", async () => {
  const fake = server({ remove: () => { throw new Error("offline"); } });
  const attempt = await prepareRefinedTurn(fake, { conversationId, prompt: "hello" }, signal());
  await assert.doesNotReject(attempt.finish());
});

test("only an Auto, plain-text turn in a saved conversation is prepared, and only where the server offers it", () => {
  const turn = { enabled: true, conversationId, prompt: "hello", selectionMode: "auto" as const, attachmentCount: 0,
    deepResearch: false, plugin: false, handoff: false };
  assert.equal(refinerEligible(turn), true);
  for (const change of [{ enabled: false }, { conversationId: undefined }, { prompt: "" }, { selectionMode: "manual" as const },
    { attachmentCount: 1 }, { deepResearch: true }, { plugin: true }, { handoff: true }]) {
    assert.equal(refinerEligible({ ...turn, ...change }), false, JSON.stringify(change));
  }
});

const origin = "http://127.0.0.1:44183";
const modelId = "gpt-6-luna";
function saved(): ChatConversation {
  return chatConversation.parse({ id: conversationId, title: "t", kind: "chat", surface: "chat", productKey: "chat", selectionMode: "auto",
    selectedModels: [modelId], autoSelection: { offered: true }, messagePage: { nextCursor: null }, webSearchMode: "off",
    messages: [{ id: "question-1", role: "user", content: "hello", status: "normal" }] });
}
const decision = { suggestionId, scopeId, epoch: 3, decision: "accepted" } as const;

test("the held decision rides on the stream request, and a turn that carries it is never replayed", async (t) => {
  const requests: Array<{ path: string; body?: Record<string, unknown> }> = [];
  let chatCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL, init: RequestInit) => {
    requests.push({ path: url.pathname, body: typeof init.body === "string" ? JSON.parse(init.body) : undefined });
    if (url.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: "bundle" });
    chatCalls += 1;
    return Response.json({ code: "CHAT_CONTEXT_BUNDLE_STALE", details: { requiresPreflight: true } }, { status: 409 });
  });
  const api = desktopChatApi("fixture", new AbortController().signal, origin);
  const run = () => api.stream(saved(), { modelId, selectionMode: "auto", effort: "default", promptRefinerDecision: decision },
    "question-1", "answer-1", new AbortController().signal, () => {});
  await assert.rejects(run());
  assert.equal(chatCalls, 1, "a single-use decision is not sent a second time");
  const turn = requests.find(({ path }) => path === "/api/chat");
  assert.deepEqual(turn?.body?.promptRefinerDecision, decision);
  // Only identifiers: no prompt text of any kind rides beside the decision.
  assert.equal("refinedPrompt" in (turn?.body ?? {}), false);
  assert.equal("promptRefinerPrompt" in (turn?.body ?? {}), false);
});

test("a turn without a decision keeps its replay after a stale signed context", async (t) => {
  let chatCalls = 0;
  t.mock.method(globalThis, "fetch", async (url: URL) => {
    if (url.pathname === "/api/chat/context") return Response.json({ ok: true, contextBundle: "bundle" });
    chatCalls += 1;
    return chatCalls === 1
      ? Response.json({ code: "CHAT_CONTEXT_BUNDLE_STALE", details: { requiresPreflight: true } }, { status: 409 })
      : new Response("answer", { headers: { "content-type": "text/plain" } });
  });
  const api = desktopChatApi("fixture", new AbortController().signal, origin);
  await api.stream(saved(), { modelId, selectionMode: "auto", effort: "default" }, "question-1", "answer-1", new AbortController().signal, () => {});
  assert.equal(chatCalls, 2);
});

test("the Prompt Refiner capability needs the server to name it and Chat writes to be on", async (t) => {
  let body: Record<string, unknown> = { autoSelection: { offered: true }, desktopWrite: true };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const load = () => readDesktopCapabilities("fixture-access", new AbortController().signal, "http://127.0.0.1");
  assert.deepEqual([(await load())?.promptRefiner, (await load())?.reasoningSteps], [false, false]);
  body = { ...body, desktopPromptRefiner: true, desktopReasoningSteps: true };
  assert.deepEqual([(await load())?.promptRefiner, (await load())?.reasoningSteps], [true, true]);
  body = { ...body, desktopWrite: false };
  assert.equal((await load())?.promptRefiner, false, "no Chat writes, no Refiner");
});

test("a Chat turn names the middle step, and the picker's catalogue lists it only where the server offers steps", async (t) => {
  const turn = { requestId: randomUUID(), prompt: "hello", modelId, selectionMode: "manual" as const };
  for (const effort of ["low", "medium", "default", "high"]) assert.equal(chatTurnInput.safeParse({ ...turn, effort }).success, true, effort);
  for (const effort of ["max", "xhigh", "minimal", ""]) assert.equal(chatTurnInput.safeParse({ ...turn, effort }).success, false, effort);

  const entry = (extra: object) => ({ id: modelId, name: "GPT-6 Luna", provider: "openai", minimumPlan: "Free", enabled: true, status: "enabled",
    publiclyListed: true, reasoningEfforts: ["low", "high"], ...extra });
  let models: unknown[] = [entry({ reasoningEffortSteps: ["low", "medium", "high"] }), entry({ id: "other", reasoningEffortSteps: ["bogus"] })];
  t.mock.method(globalThis, "fetch", async () => Response.json({ models }));
  const api = desktopChatApi("fixture", new AbortController().signal, origin);
  assert.deepEqual((await api.models()).map((model) => model.reasoningEfforts), [["low", "high"], ["low", "high"]]);
  const stepped = await api.models({ reasoningSteps: true });
  assert.deepEqual(stepped[0].reasoningEfforts, ["low", "medium", "high"]);
  // A step list this build cannot read costs the steps, not the model.
  assert.deepEqual(stepped[1].reasoningEfforts, ["low", "high"]);
  // A server that names no steps reads exactly as before, whatever the capability.
  models = [entry({})];
  assert.deepEqual((await api.models({ reasoningSteps: true }))[0].reasoningEfforts, ["low", "high"]);
});
