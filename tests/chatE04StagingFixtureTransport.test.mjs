import assert from "node:assert/strict";
import test from "node:test";
import { CHAT_E04_CONVERSATION, installChatE04FixtureTransport } from "../lib/chatE04StagingFixtureTransport.ts";
import { parseChatMessageSaveResponse, parsePublicChatDraft } from "../components/chat/chatDurableRecoveryClient.ts";

test("page-local QA transport blocks unknown requests, external URLs and late callbacks", async () => {
  const values = new Map(); let forwarded = 0; const forwardedRequests = [];
  globalThis.window = { location: { origin: "https://staging.example.invalid" },
    fetch: async (request) => { forwarded++; forwardedRequests.push({ method: request.method,
      marker: request.headers.get("x-e04-marker"), body: await request.text() }); return Response.json({ synthetic: true }); } };
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { sendBeacon: () => true } });
  globalThis.XMLHttpRequest = class { send() {} };
  globalThis.sessionStorage = { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key) };
  const seen = []; const fixture = installChatE04FixtureTransport((evidence) => seen.push(evidence));
  assert.equal((await window.fetch("/api/chat", { method: "POST", body: JSON.stringify({ contextBundle: "e04-synthetic-context" }) })).status, 200);
  const chatRequest = new Request("https://staging.example.invalid/api/chat", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contextBundle: "e04-synthetic-context" }) });
  assert.equal((await window.fetch(chatRequest, { cache: "no-store" })).status, 200);
  assert.equal(seen.at(-1).contextBundleReused, true);
  assert.equal(seen.at(-1).chatRequests, 2);
  assert.equal((await window.fetch("/api/products/chat/conversations")).status, 200);
  assert.equal((await window.fetch("/api/admin/app-settings", { method: "PUT", body: "{}" })).status, 503);
  assert.equal((await window.fetch("https://provider.example.invalid/messages", { method: "POST", body: "{}" })).status, 503);
  assert.equal(navigator.sendBeacon("https://provider.example.invalid", "body"), false);
  assert.throws(() => new XMLHttpRequest().send(), /CHAT_E04_QA_REQUEST_BLOCKED/);
  assert.equal(forwarded, 0);
  const autoPath = "/api/admin/chat-e2e-fixture";
  for (const query of ["", "?action=other", "?action=accepted&action=accepted", "?action=accepted&prompt=arbitrary", "?action=accepted&", `?action=${"%61".repeat(171)}`]) {
    assert.equal((await window.fetch(autoPath + query)).status, 503);
  }
  assert.equal((await window.fetch(autoPath + "?action=accepted", { method: "POST", body: "{}" })).status, 503);
  assert.equal(forwarded, 0);
  assert.equal((await window.fetch(autoPath + "?action=accepted")).status, 200);
  assert.equal(forwarded, 1);
  const autoRequest = new Request("https://staging.example.invalid/api/admin/chat-e2e-fixture?action=kept_original", {
    method: "GET", headers: { "x-e04-marker": "preserved" },
  });
  assert.equal((await window.fetch(autoRequest, { cache: "no-store" })).status, 200);
  assert.deepEqual(forwardedRequests.at(-1), { method: "GET", marker: "preserved", body: "" });
  assert.equal(forwarded, 2);
  const post = async (path, body, method = "POST") => window.fetch(path, { method, body: JSON.stringify(body) });
  const draftPath = "/api/products/chat/drafts/e04-unit-scope";
  const text = "E04 exact synthetic authored bytes. ";
  const draft = await (await post(draftPath, { text, expectedRevision: 0, attachmentReferences: [] }, "PUT")).json();
  assert.equal(parsePublicChatDraft(draft.draft, "e04-unit-scope")?.text, text);
  const saved = await (await post(`/api/conversations/${CHAT_E04_CONVERSATION}/messages`, {
    messages: [{ role: "user", content: text, clientRequestId: "e04-unit-request" }],
    draftConsume: { scopeKey: "e04-unit-scope", expectedRevision: 1, requestId: "e04-unit-request" },
  })).json();
  assert.ok(parseChatMessageSaveResponse(saved, { requestId: "e04-unit-request", expectedAttachmentCount: 0 }));
  assert.equal((await (await window.fetch(draftPath)).json()).draft, null);
  const lateFetch = window.fetch;
  fixture.retire();
  assert.equal((await lateFetch("/api/chat", { method: "POST", body: "{}" })).status, 503);
  assert.equal((await window.fetch(autoPath + "?action=accepted")).status, 503);
  assert.equal(forwarded, 2);
  for (const key of ["providerCalls", "costMicroUsd", "productDatabaseWrites", "auditWrites"]) assert.equal(seen.at(-1)[key], 0);
});
