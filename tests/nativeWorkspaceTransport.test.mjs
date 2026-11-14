import { test } from "node:test";
import assert from "node:assert/strict";
import { createWorkspaceTransport } from "../apps/mobile/src/workspaceTransport.ts";
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";

const enabled = { assistantEditing: true, assistantKnowledge: true, externalImport: true };
const profile = { id: "profile-1", name: "Guide", currentVersion: { revision: 3 }, knowledgeFiles: [] };
const input = { name: "Renamed", instructions: "Use my files", modelIds: [], toolPolicy: { webSearch: false, deepResearch: false }, memoryPolicy: { useAccountMemory: false }, starters: [], knowledgeFileIds: ["file-1"] };

test("unadvertised native writes fail closed before requesting their endpoints", async () => {
  const calls = [];
  const client = createWorkspaceTransport(async (...args) => { calls.push(args); }, async () => ({}), async () => {});
  assert.deepEqual(await client.features(), { assistantEditing: false, assistantKnowledge: false, externalImport: false });
  await assert.rejects(client.createAssistant({ name: "Guide", instructions: "Help", modelIds: [] }), /NATIVE_WORKSPACE_UNAVAILABLE/);
  await assert.rejects(client.continue("source", "key"), /NATIVE_WORKSPACE_UNAVAILABLE/);
  assert.equal(calls.length, 0);
});

test("stale revision never renames or retries an assistant", async () => {
  const calls = [];
  const client = createWorkspaceTransport(async (path, init) => { calls.push({ path, init }); throw Error("ASSISTANT_PROFILE_VERSION_STALE"); }, async () => ({ workspace: enabled }), async () => {});
  await assert.rejects(client.saveAssistant(profile, input), /STALE/);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].path, "/api/assistant-profiles/profile-1/versions");
  assert.equal(JSON.parse(calls[0].init.body).expectedRevision, 3);
  assert.deepEqual(JSON.parse(calls[0].init.body).knowledgeFileIds, ["file-1"]);
});

test("creation reads the published profile because the create receipt carries identity only", async () => {
  const calls = [];
  const client = createWorkspaceTransport(async (path, init) => {
    calls.push({ path, method: init?.method ?? "GET" });
    return init?.method === "POST" ? { profile: { id: "profile-1", name: "Guide" } } : { profile };
  }, async () => ({ workspace: enabled }), async () => {});
  assert.equal((await client.createAssistant({ name: "Guide", instructions: "Help", modelIds: [] })).currentVersion.revision, 3);
  assert.deepEqual(calls, [{ path: "/api/assistant-profiles", method: "POST" }, { path: "/api/assistant-profiles/profile-1", method: "GET" }]);
});

test("knowledge transfer uses the supplied byte uploader without a bearer or cookie field", async () => {
  const calls = [], uploads = [];
  const client = createWorkspaceTransport(async (path, init) => { calls.push({ path, body: JSON.parse(init.body) }); return { uploadKey: "key", uploadUrl: "signed-object-url", uploadHeaders: { "content-type": "text/plain" } }; }, async () => ({ workspace: enabled }), async (...args) => uploads.push(args));
  const file = new File(["my document"], "notes.txt", { type: "text/plain" });
  await client.uploadKnowledge("profile-1", file);
  assert.deepEqual(calls.map(row => row.body.action), ["prepare", "finalize"]);
  assert.deepEqual(uploads[0], ["signed-object-url", { "content-type": "text/plain" }, file]);
});

test("an unknown continuation outcome is not automatically retried", async () => {
  let attempts = 0;
  const client = createWorkspaceTransport(async (_path, init) => { attempts++; assert.equal(JSON.parse(init.body).idempotencyKey, "same-key"); throw Error("Network lost"); }, async () => ({ workspace: enabled }), async () => {});
  await assert.rejects(client.continue("source-1", "same-key"));
  assert.equal(attempts, 1);
});

test("a workspace captured before sign-out cannot make a request with a later session", async () => {
  const calls = [];
  const transport = createApiTransport(async path => { calls.push(path); throw Error("Unexpected request"); }, { signOut: async () => {} });
  const captured = transport.workspace;
  await transport.signOut();
  await assert.rejects(captured.createAssistant({ name: "Old owner", instructions: "Help", modelIds: [] }), /SIGN_IN_REQUIRED/);
  assert.equal(calls.length, 0);
});

test("starting an assistant binds during creation and preserves its explicit model", async () => {
  const writes = [];
  const transport = createApiTransport(async (path, init) => {
    if (init?.method === "POST") { writes.push({ path, body: JSON.parse(init.body) }); return Response.json({ id: "chat-1" }); }
    if (init?.method === "PATCH") throw Error("The saved assistant model must not be overridden by Auto");
    return Response.json({ id: "chat-1", title: "Guide", selectedModels: ["assistant-model"], messages: [], selectionMode: "manual", autoSelection: { offered: true }, assistantProfile: { profileId: "profile-1" } });
  });
  const item = await transport.create(undefined, "profile-1");
  assert.equal(item.assistantProfileId, "profile-1");
  assert.deepEqual(item.selectedModels, ["assistant-model"]);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].path, "/api/products/chat/conversations");
  assert.equal(writes[0].body.assistantProfileId, "profile-1");
});
