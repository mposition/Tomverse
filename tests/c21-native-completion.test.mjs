import assert from "node:assert/strict";
import test from "node:test";
import { readDeviceDraft, writeDeviceDraft, clearDeviceDrafts, deviceDraftKey } from "../packages/chat-core/src/deviceDraft.ts";
import { createApiClient, ApiClientError } from "../packages/api-client/src/index.ts";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { nativeChatBearerRoute } from "../lib/nativeBearerGate.ts";

const storage = () => {
  const values = new Map();
  return { getItem: (key) => values.get(key) ?? null, setItem: (key, value) => values.set(key, value), removeItem: (key) => values.delete(key), key: (index) => [...values.keys()][index] ?? null, get length() { return values.size; } };
};
test("device drafts survive restart within the same owner and conversation only", () => {
  const store = storage(); writeDeviceDraft(store, "owner-a", "chat-a", "Unsent text");
  assert.equal(readDeviceDraft(store, "owner-a", "chat-a"), "Unsent text");
  assert.equal(readDeviceDraft(store, "owner-b", "chat-a"), "");
  assert.equal(readDeviceDraft(store, "owner-a", "chat-b"), "");
  assert.equal(readDeviceDraft(store, "owner-a", "chat-a", Date.now() + 86400001), "");
});
test("sign-out clears native drafts without touching preferences or credentials", () => {
  const store = storage(); writeDeviceDraft(store, "a", null, "A"); writeDeviceDraft(store, "b", null, "B"); store.setItem("tomverse-theme", "dark");
  clearDeviceDrafts(store); assert.equal(store.length, 1); assert.equal(store.getItem("tomverse-theme"), "dark");
});
test("malformed, future-dated and oversized draft values are refused", () => {
  const store = storage(); const key = deviceDraftKey("a", null);
  for (const value of ["invalid", JSON.stringify({ text: "future", savedAt: Date.now() + 100000 }), JSON.stringify({ text: "x".repeat(40001), savedAt: Date.now() })]) {
    store.setItem(key, value); assert.equal(readDeviceDraft(store, "a", null), "");
  }
});
test("injected API transport preserves status and refuses non-JSON success", async () => {
  let init;
  const client = createApiClient(async (_path, input) => { init = input; return new Response("unavailable", { status: 503 }); });
  await assert.rejects(client.json("/api/test"), (error) => error instanceof ApiClientError && error.status === 503);
  assert.equal(init.cache, "no-store"); assert.equal(init.redirect, "error");
  await assert.rejects(createApiClient(async () => new Response("not JSON")).json("/api/test"), /MOBILE_RESPONSE_INVALID/);
});
const artifact = { id: "file-a", ordinal: 0, format: "txt", filename: "answer.txt", mediaType: "text/plain", byteSize: 5, status: "ready", modelId: "selected-model" };
test("native artifact downloads use only the canonical route and save exact server bytes", async () => {
  const requests = []; const files = [];
  const api = createApiTransport(async (path, init) => { requests.push([path, init]); return new Response("hello", { headers: { "Content-Type": "text/plain" } }); }, {}, async (response, filename) => files.push([await response.text(), filename]));
  await api.downloadArtifact(artifact);
  assert.equal(requests[0][0], "/api/artifacts/file-a"); assert.equal(requests[0][1].redirect, "error"); assert.deepEqual(files, [["hello", "answer.txt"]]);
});
test("failed, locked, foreign and truncated files never reach the native save dialog", async () => {
  let saves = 0;
  for (const status of [401, 404, 423, 500]) {
    const api = createApiTransport(async () => new Response(null, { status }), {}, async () => saves++);
    await assert.rejects(api.downloadArtifact(artifact));
  }
  const api = createApiTransport(async () => new Response("half"), {}, async () => saves++);
  await assert.rejects(api.downloadArtifact(artifact), /SIZE_MISMATCH/);
  await assert.rejects(api.downloadArtifact({ ...artifact, status: "failed" })); assert.equal(saves, 0);
});
test("account export redeems one scoped ticket once without retrying an unknown response", async () => {
  const calls = []; let saves = 0; const path = "/api/user/account/export/" + "t".repeat(43);
  const api = createApiTransport(async (url) => { calls.push(url); return url === "/api/user/account/export" ? Response.json({ downloadPath: path }) : new Response("{}"); }, {}, async () => saves++);
  await api.exportAccount(); assert.deepEqual(calls, ["/api/user/account/export", path]); assert.equal(saves, 1);
  const refused = createApiTransport(async () => Response.json({ downloadPath: "https://foreign.invalid/export" }), {}, async () => saves++);
  await assert.rejects(refused.exportAccount(), /EXPORT_PATH_INVALID/); assert.equal(saves, 1);
});
test("account deletion requires exact explicit confirmation and never resubmits an unknown write", async () => {
  let requests = 0;
  const api = createApiTransport(async (path, init) => { requests++; assert.equal(path, "/api/user/account"); assert.equal(init.method, "DELETE"); assert.deepEqual(JSON.parse(init.body), { confirm: true, confirmationText: "DELETE MY ACCOUNT" }); throw Error("Connection lost"); }, {});
  await assert.rejects(api.deleteAccount("delete")); assert.equal(requests, 0);
  await assert.rejects(api.deleteAccount("DELETE MY ACCOUNT")); assert.equal(requests, 1);
});
test("new native routes keep exact method and path enrollment", () => {
  for (const [path, method] of [["/api/artifacts/file-a", "GET"], ["/api/user/account", "DELETE"], ["/api/user/account/export", "POST"]]) {
    assert.equal(nativeChatBearerRoute(path, method), false); assert.equal(nativeChatBearerRoute(path, method, true), true);
  }
  for (const [path, method] of [["/api/artifacts/file-a", "DELETE"], ["/api/user/account", "PATCH"], ["/api/user/account/export/../other", "GET"]]) assert.equal(nativeChatBearerRoute(path, method, true), false);
});
