import assert from "node:assert/strict";
import test from "node:test";
import { clearDeviceDrafts, writeDeviceDraft } from "../packages/chat-core/src/deviceDraft.ts";
import { appendNativeRevisionDraft, readNativeDraftFiles, writeNativeDraftFiles, readNativeRevisionDraft, writeNativeRevisionDraft } from "../apps/mobile/src/nativeRevisionDraft.ts";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";

const file = (name, uploadId = "opaque-upload") => ({ uploadId, name, mediaType: "text/plain", size: 12 });
const storage = () => {
  const data = new Map();
  return { get length() { return data.size; }, key: index => [...data.keys()][index] ?? null,
    getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};
test("native revision prepends one visible request to the latest draft without replacing another attachment", () => {
  const original = { text: "Typed while preparing", files: [file("notes.txt", "notes")] };
  const result = appendNativeRevisionDraft(original, file("source.txt"), "Create a revised file.");
  assert.equal(result.conflict, null);
  assert.equal(result.draft.text, "Create a revised file.\n\nTyped while preparing");
  assert.deepEqual(result.draft.files.map(value => value.uploadId), ["notes", "opaque-upload"]);
  assert.equal(original.text, "Typed while preparing");
  assert.deepEqual(appendNativeRevisionDraft(result.draft, file("source.txt"), "Duplicate"), { draft: result.draft, conflict: null });
});
test("native count, normalized same-name and text limits preserve the exact original draft", () => {
  for (const [draft, reason] of [
    [{ text: "Keep", files: Array.from({ length: 5 }, (_, index) => file(`${index}.txt`, `upload-${index}`)) }, "count"],
    [{ text: "Keep", files: [file("SOURCE.TXT", "other-input")] }, "name"],
    [{ text: "x".repeat(40000), files: [] }, "text"],
  ]) {
    const result = appendNativeRevisionDraft(draft, file("source.txt"), "Create file");
    assert.equal(result.conflict, reason); assert.equal(result.draft, draft);
  }
});
test("device revision drafts restore opaque metadata in the original owner/conversation and obey existing clear and TTL", () => {
  const store = storage();
  const draft = { text: "Visible request", files: [file("source.txt")] };
  writeNativeRevisionDraft(store, "owner-a", "chat-a", draft);
  writeDeviceDraft(store, "owner-b", "chat-a", "Other person");
  assert.deepEqual(readNativeRevisionDraft(store, "owner-a", "chat-a"), draft);
  assert.deepEqual(readNativeRevisionDraft(store, "owner-b", "chat-a"), { text: "Other person", files: [] });
  assert.deepEqual(readNativeRevisionDraft(store, "owner-a", "chat-b"), { text: "", files: [] });
  assert.deepEqual(readNativeDraftFiles(store, "owner-a", "chat-a", Date.now() + 86400001), []);
  clearDeviceDrafts(store); assert.equal(store.length, 0);
});
test("stored native attachment metadata has no storage key, bytes, URL or source identity", () => {
  const store = storage();
  writeNativeDraftFiles(store, "owner", "chat", [{ ...file("source.txt"), objectKey: "private/key", data: "secret bytes", sourceArtifactId: "source-row", url: "https://storage.invalid" }]);
  const serialized = store.getItem(store.key(0));
  for (const secret of ["private/key", "secret bytes", "source-row", "storage.invalid"]) assert.ok(!serialized.includes(secret));
  assert.deepEqual(readNativeDraftFiles(store, "owner", "chat"), [file("source.txt")]);
});

const bridge = { hasSession: async () => ({ signedIn: true }), signIn: async () => {}, signOut: async () => {} };
const capability = (enabled = true) => ({ reviewEasy: true, assistants: true, maxModels: 3, plan: "Max", historyActions: true, generatedFileRevisions: enabled });
test("native preparation uses exact IDs and the same operation without any Send or raw storage response", async () => {
  const calls = [];
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, init });
    if (path === "/api/products/mobile/capabilities") return Response.json(capability());
    assert.equal(path, "/api/chat"); assert.equal(init.method, "PUT");
    return Response.json({ ...file("report.xlsx"), revisionMode: "workbook", objectKey: "secret/key", canonicalSpec: { sensitive: true } });
  }, bridge);
  const input = { artifactId: "older-exact-artifact", conversationId: "current-chat", operationId: "same-operation" };
  assert.deepEqual(await transport.prepareArtifactRevision(input), { ...file("report.xlsx"), revisionMode: "workbook" });
  assert.deepEqual(JSON.parse(calls[1].init.body), { action: "generated-artifact-copy", ...input });
  assert.deepEqual(await transport.prepareArtifactRevision(input), { ...file("report.xlsx"), revisionMode: "workbook" });
  assert.equal(calls.filter(value => value.init.method === "POST").length, 0);
});
test("an older or disabled native capability never calls preparation or cleanup", async () => {
  for (const enabled of [false, undefined]) {
    let requests = 0;
    const transport = createApiTransport(async path => { requests++; assert.equal(path, "/api/products/mobile/capabilities"); return Response.json({ ...capability(), generatedFileRevisions: enabled }); }, bridge);
    await assert.rejects(transport.prepareArtifactRevision({ artifactId: "a", conversationId: "c", operationId: "operation" }), error => error.code === "GENERATED_ARTIFACT_REVISION_DISABLED");
    await transport.discardAttachment("opaque-input"); assert.equal(requests, 1);
  }
});
test("native revision reads and cleanup carry current unlock grants only to the authenticated application", async () => {
  const calls = [];
  const unlockToken = `${Math.floor(Date.now() / 1000) + 600}.fixture.signature`;
  const transport = createApiTransport(async (path, init = {}) => {
    if (typeof init === "function") init = init();
    calls.push({ path, init });
    if (path === "/api/products/mobile/capabilities") return Response.json(capability());
    if (path === "/api/conversations/chat-a/verify") return Response.json({ unlockToken });
    if (path.startsWith("/api/artifacts/source/versions")) return Response.json({ artifacts: [{ id: "source", ordinal: 0, format: "txt", filename: "source.txt", mediaType: "text/plain", byteSize: 12, status: "ready", lineageId: "source", parentArtifactId: null, createdAt: "2026-11-15T00:00:00Z", objectKey: "secret/key" }], nextCursor: null });
    if (init.method === "PUT") return Response.json(file("source.txt"));
    if (init.method === "DELETE") return new Response(null, { status: 204 });
    throw Error(`Unexpected ${path}`);
  }, bridge);
  await transport.history.unlock("chat-a", "password");
  await transport.prepareArtifactRevision({ artifactId: "source", conversationId: "chat-a", operationId: "operation" });
  const page = await transport.artifactVersions("source");
  assert.equal(page.artifacts[0].objectKey, undefined);
  await transport.discardAttachment("opaque-upload");
  for (const request of calls.filter(value => value.path === "/api/chat" || value.path.includes("/versions"))) {
    assert.equal(new Headers(request.init.headers).get("X-Tomverse-Conversation-Unlocks"), `chat-a=${unlockToken}`);
  }
});
test("a late preparation response after sign-out is rejected and cannot become another account's input", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const transport = createApiTransport(async path => path === "/api/products/mobile/capabilities" ? Response.json(capability()) : pending, bridge);
  const preparation = transport.prepareArtifactRevision({ artifactId: "a", conversationId: "c", operationId: "operation" });
  await new Promise(resolve => setTimeout(resolve, 0));
  await transport.signOut(); release(Response.json(file("source.txt")));
  await assert.rejects(preparation, { name: "AbortError" });
});
test("an old account's delayed capability cannot dispatch preparation or repopulate the new session cache", async () => {
  let release;
  let capabilityReads = 0, puts = 0;
  const delayed = new Promise(resolve => { release = resolve; });
  const transport = createApiTransport(async (path, init) => {
    if (path === "/api/products/mobile/capabilities") return ++capabilityReads === 1 ? delayed : Response.json(capability(false));
    if (init.method === "PUT") puts++;
    return Response.json(file("source.txt"));
  }, bridge);
  const pending = transport.prepareArtifactRevision({ artifactId: "a", conversationId: "c", operationId: "operation" });
  await transport.signOut(); release(Response.json(capability()));
  await assert.rejects(pending, { name: "AbortError" });
  await assert.rejects(transport.prepareArtifactRevision({ artifactId: "b", conversationId: "d", operationId: "operation-next" }), error => error.code === "GENERATED_ARTIFACT_REVISION_DISABLED");
  assert.equal(puts, 0); assert.equal(capabilityReads, 2);
});
