import test from "node:test";
import assert from "node:assert/strict";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { createAccountDataApi } from "../src/host/account-data-api";
import { desktopAccountSettingsInput, type AccountSettingsResult, type DesktopAccountSettingsInput } from "../src/account-settings-contract";

const origin = "https://tomverse.example";

// One fake transport that records the request an action produces and answers with `reply`.
function settingsWith(reply: (url: URL, init?: RequestInit) => Response) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: "a.b.c.d.e", expiresAt: Date.now() + 300_000 });
    calls.push({ path: url.pathname + url.search, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return reply(url, init);
  };
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", new AbortController().signal, transport);
  return { settings, calls };
}

test("memory actions map to the memory routes and validate what comes back", async () => {
  const { settings, calls } = settingsWith((url) => {
    if (url.pathname === "/api/memories/extraction-runs") return Response.json({ runs: [
      { id: "run_1", status: "running", extractionModelId: "m", promptVersion: "p", chunkTotal: 4, chunkCompleted: 1,
        createdAt: "2026-11-25T00:00:00.000Z", completedAt: null },
    ], activeRunId: "run_1" });
    if (url.pathname.endsWith("/scope")) return Response.json({ moved: true, projectId: "proj_1" });
    if (url.pathname.endsWith("/cancel")) return Response.json({ status: "cancelled" });
    return Response.json({ outcome: "deleted" });
  });
  assert.deepEqual(await settings({ action: "deleteMemory", id: "mem_1" }), { outcome: "deleted" });
  assert.deepEqual(await settings({ action: "moveMemoryScope", id: "mem_1", expectedRevision: 3, projectId: "proj_1" }), { moved: true, projectId: "proj_1" });
  assert.equal(((await settings({ action: "extractionRuns" })) as AccountSettingsResult<"extractionRuns">).activeRunId, "run_1");
  await settings({ action: "cancelExtraction", id: "run_1" });
  assert.deepEqual(calls, [
    { path: "/api/memories/mem_1", method: "DELETE", body: undefined },
    { path: "/api/memories/mem_1/scope", method: "POST", body: { expectedRevision: 3, targetProjectId: "proj_1" } },
    { path: "/api/memories/extraction-runs", method: "GET", body: undefined },
    { path: "/api/memories/extraction-runs/run_1/cancel", method: "POST", body: undefined },
  ]);
  const personal = desktopAccountSettingsInput.parse({ action: "moveMemoryScope", id: "mem_1", expectedRevision: 1, projectId: null });
  assert.equal(personal.action === "moveMemoryScope" && personal.projectId, null);
  assert.equal(desktopAccountSettingsInput.safeParse({ action: "moveMemoryScope", id: "mem_1", expectedRevision: 0, projectId: null }).success, false);
  assert.equal(desktopAccountSettingsInput.safeParse({ action: "deleteMemory", id: "../x" }).success, false);
});

test("a memory detail from an older server without revision or scope still parses", async () => {
  const base = { id: "mem_1", kind: "preference", statement: "Likes tea", status: "active", pinned: false, expiresAt: null,
    sensitivity: "standard", evidence: [] };
  const { settings } = settingsWith(() => Response.json({ memory: base, conflicts: [] }));
  const old = (await settings({ action: "memoryDetail", id: "mem_1" })) as AccountSettingsResult<"memoryDetail">;
  assert.equal(old.memory.revision, undefined);
  const { settings: current } = settingsWith(() => Response.json({ memory: { ...base, revision: 2, projectId: "proj_1" }, conflicts: [] }));
  const detail = (await current({ action: "memoryDetail", id: "mem_1" })) as AccountSettingsResult<"memoryDetail">;
  assert.equal(detail.memory.revision, 2);
  assert.equal(detail.memory.projectId, "proj_1");
});

test("memory export is saved only when the stream is complete, and delete-all sends the phrase", async () => {
  let body = JSON.stringify({ format: "tomverse.memory-export.v1", generatedAt: "now", items: [{ id: "a" }, { id: "b" }], itemCount: 2 });
  const calls: string[] = [];
  const { settings } = settingsWith((url, init) => {
    calls.push((init?.method ?? "GET") + " " + url.pathname + (init?.body ? " " + init.body : ""));
    return url.pathname === "/api/memories/export" ? new Response(body, { headers: { "content-type": "application/json; charset=utf-8" } })
      : Response.json({ outcome: "deleted", count: 2 });
  });
  const saved: string[] = [];
  const api = createAccountDataApi({ settings, save: async (file) => { saved.push(Buffer.from(await file.load()).toString("utf8")); return true; },
    afterAccountDeleted: async () => {}, language: () => "en" });
  assert.deepEqual(await api.handle({ action: "saveMemories" }), { status: "saved" });
  assert.equal(saved.length, 1);
  body = body.replace('"itemCount":2', '"itemCount":3');
  assert.deepEqual(await api.handle({ action: "saveMemories" }), { status: "failed" });
  body = '{"format":"x","items":[{"id":"a"';
  assert.deepEqual(await api.handle({ action: "saveMemories" }), { status: "failed" });
  assert.equal(saved.length, 1);
  assert.deepEqual(await api.handle({ action: "deleteAllMemories", confirmation: "DELETE ALL MEMORIES" }), { status: "deleted" });
  assert.equal(calls.at(-1), 'POST /api/memories/delete-all {"confirm":true,"confirmationText":"DELETE ALL MEMORIES"}');
  const input: DesktopAccountSettingsInput = { action: "extractionRuns" };
  assert.equal(desktopAccountSettingsInput.safeParse(input).success, true);
});

test("assistant knowledge and deletion actions map to the profile routes", async () => {
  const { settings, calls } = settingsWith((url) => url.pathname.endsWith("/knowledge") ? Response.json({
    files: [{ id: "file_1", name: "notes.md", bytes: 1200, processingStatus: "ready", mime: "text/markdown", createdAt: "x" }],
    capacity: { limits: { maxFileBytes: 33554432, maxFilesPerProfile: 20 }, remaining: { files: 19 } },
  }) : Response.json({ ok: true }));
  const listed = (await settings({ action: "knowledge", id: "prof_1" })) as AccountSettingsResult<"knowledge">;
  assert.equal(listed.files[0].name, "notes.md");
  await settings({ action: "deleteKnowledgeFile", id: "prof_1", fileId: "file_1" });
  await settings({ action: "deleteAssistant", id: "prof_1" });
  assert.deepEqual(calls.map(call => call.method + " " + call.path), [
    "GET /api/assistant-profiles/prof_1/knowledge",
    "DELETE /api/assistant-profiles/prof_1/knowledge/file_1",
    "DELETE /api/assistant-profiles/prof_1",
  ]);
  assert.equal(desktopAccountSettingsInput.safeParse({ action: "deleteKnowledgeFile", id: "prof_1", fileId: "../x" }).success, false);
});

const storageUrl = "https://acct.r2.cloudflarestorage.com/assistant-knowledge/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";

function assistantApi(options: { prepared?: object; pick?: { name: string; bytes: Uint8Array } | null; put?: Response; refuse?: { path: string; code: string } }) {
  const calls: string[] = [];
  const puts: { url: string; headers: HeadersInit | undefined; length: number }[] = [];
  const { settings } = settingsWith((url, init) => {
    calls.push((init?.method ?? "GET") + " " + url.pathname + (init?.body ? " " + JSON.parse(String(init.body)).action : ""));
    if (options.refuse && url.pathname === options.refuse.path) return Response.json({ code: options.refuse.code }, { status: 413 });
    if (url.pathname.endsWith("/export")) return new Response(Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]), { headers: { "content-type": "application/zip" } });
    if (init?.body && JSON.parse(String(init.body)).action === "prepare") return Response.json(options.prepared ?? { uploadKey: "k1", uploadUrl: storageUrl, uploadHeaders: { "Content-Type": "text/markdown" } });
    return Response.json({ file: { id: "file_9" } }, { status: 201 });
  });
  const transport: typeof fetch = async (input, init) => {
    puts.push({ url: String(input), headers: init?.headers, length: (init?.body as Uint8Array).byteLength });
    return options.put ?? new Response(null, { status: 200 });
  };
  const saved: Buffer[] = [];
  const api = createAccountDataApi({ settings, origin, transport, language: () => "en", afterAccountDeleted: async () => {},
    save: async (file) => { saved.push(Buffer.from(await file.load())); return true; },
    pickFile: async () => options.pick === undefined ? { name: "notes.md", bytes: new TextEncoder().encode("# Notes") } : options.pick });
  return { api, calls, puts, saved };
}

test("a knowledge file uploads to Tomverse storage and is then registered", async () => {
  const { api, calls, puts } = assistantApi({});
  assert.deepEqual(await api.handle({ action: "uploadKnowledge", id: "prof_1" }), { status: "uploaded" });
  assert.deepEqual(calls, ["POST /api/assistant-profiles/prof_1/knowledge prepare", "POST /api/assistant-profiles/prof_1/knowledge finalize"]);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, storageUrl);
  assert.equal(puts[0].length, 7);
});

test("a knowledge upload never reaches an untrusted destination or an unsupported file", async () => {
  for (const uploadUrl of ["https://evil.example/upload?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc",
    "http://acct.r2.cloudflarestorage.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc",
    "https://acct.r2.cloudflarestorage.com/k"]) {
    const { api, puts } = assistantApi({ prepared: { uploadKey: "k1", uploadUrl, uploadHeaders: { "Content-Type": "text/markdown" } } });
    assert.deepEqual(await api.handle({ action: "uploadKnowledge", id: "prof_1" }), { status: "failed" });
    assert.equal(puts.length, 0);
  }
  const unsupported = assistantApi({ pick: { name: "tool.exe", bytes: new Uint8Array([1]) } });
  assert.deepEqual(await unsupported.api.handle({ action: "uploadKnowledge", id: "prof_1" }), { status: "failed", code: "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE" });
  assert.equal(unsupported.calls.length, 0);
  assert.deepEqual(await assistantApi({ pick: null }).api.handle({ action: "uploadKnowledge", id: "prof_1" }), { status: "cancelled" });
  const quota = assistantApi({ refuse: { path: "/api/assistant-profiles/prof_1/knowledge", code: "ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED" } });
  assert.deepEqual(await quota.api.handle({ action: "uploadKnowledge", id: "prof_1" }), { status: "failed", code: "ASSISTANT_KNOWLEDGE_QUOTA_EXCEEDED" });
  const storageDown = assistantApi({ put: new Response(null, { status: 403 }) });
  assert.deepEqual(await storageDown.api.handle({ action: "uploadKnowledge", id: "prof_1" }), { status: "failed" });
  assert.equal(storageDown.calls.length, 1, "no registration after a failed storage write");
});

test("an assistant package is saved only when it is a zip", async () => {
  const { api, saved } = assistantApi({});
  assert.deepEqual(await api.handle({ action: "saveAssistant", id: "prof_1", name: "My / helper" }), { status: "saved" });
  assert.equal(saved[0].readUInt32LE(0), 0x04034b50);
});

test("Review provider defaults and Model Finder map to their routes and validate the answers", async () => {
  const { settings, calls } = settingsWith((url, init) => {
    if (url.pathname === "/api/user/model-finder") return init?.method === "POST"
      ? Response.json({ defaultModelId: "m1", newConversationModelIds: ["m1", "m2"] })
      : Response.json({ settings: { preferredTasks: ["coding"], preferredPriority: "fast", defaultModelId: "m1", modelFinderCompletedAt: null } });
    return init?.method === "POST" ? Response.json({ success: true }) : Response.json({
      reviewEasyProviderOptions: ["openai", "anthropic", "google"], reviewEasyDefaultProviders: ["openai", "anthropic"],
      reviewEasyPlatformProviders: ["openai"], reviewEasyMaxProviders: "2", reviewEasyEffectiveProviders: ["openai", "anthropic"],
    });
  });
  const defaults = (await settings({ action: "reviewProviders" })) as AccountSettingsResult<"reviewProviders">;
  assert.deepEqual(defaults.reviewEasyDefaultProviders, ["openai", "anthropic"]);
  assert.equal(defaults.reviewEasyMaxProviders, 2);
  await settings({ action: "saveReviewProviders", providers: null });
  await settings({ action: "saveReviewProviders", providers: ["google"] });
  await settings({ action: "modelFinder" });
  const saved = (await settings({ action: "saveModelFinder", values: { mode: "default" } })) as AccountSettingsResult<"saveModelFinder">;
  assert.equal(saved.defaultModelId, "m1");
  await settings({ action: "saveModelFinder", values: { mode: "complete", tasks: ["coding", "writing"], priority: "deep", modelIds: ["m1", "m2"] } });
  assert.deepEqual(calls.map(call => [call.method, call.path, call.body]), [
    ["GET", "/api/user/settings", undefined],
    ["POST", "/api/user/settings", { reviewEasyDefaultProviders: null }],
    ["POST", "/api/user/settings", { reviewEasyDefaultProviders: ["google"] }],
    ["GET", "/api/user/model-finder", undefined],
    ["POST", "/api/user/model-finder", { action: "accept_default" }],
    ["POST", "/api/user/model-finder", { action: "complete", answers: { tasks: ["coding", "writing"], priority: "deep" }, modelIds: ["m1", "m2"] }],
  ]);
  for (const bad of [
    { action: "saveReviewProviders", providers: [] }, { action: "saveReviewProviders", providers: ["a", "b", "c", "d"] },
    { action: "saveReviewProviders", providers: ["Bad Name"] },
    { action: "saveModelFinder", values: { mode: "complete", tasks: [], priority: "fast", modelIds: ["m1"] } },
    { action: "saveModelFinder", values: { mode: "complete", tasks: ["coding"], priority: "slow", modelIds: ["m1"] } },
  ]) assert.equal(desktopAccountSettingsInput.safeParse(bad).success, false, JSON.stringify(bad));
});

test("a server that cannot answer with Review options or a coherent Model Finder save is not trusted", async () => {
  const { settings: noOptions } = settingsWith(() => Response.json({ theme: "dark" }));
  await assert.rejects(noOptions({ action: "reviewProviders" }));
  const { settings: incoherent } = settingsWith(() => Response.json({ defaultModelId: "m1", newConversationModelIds: ["m2"] }));
  await assert.rejects(incoherent({ action: "saveModelFinder", values: { mode: "default" } }));
});

test("the Model Finder choices stay equal to the web catalogue", async () => {
  const { MODEL_FINDER_TASKS, MODEL_FINDER_PRIORITIES } = await import("../../../lib/modelFinder");
  const { MODEL_FINDER_TASK_IDS, MODEL_FINDER_PRIORITY_IDS } = await import("../src/account-settings-contract");
  assert.deepEqual([...MODEL_FINDER_TASK_IDS], [...MODEL_FINDER_TASKS]);
  assert.deepEqual([...MODEL_FINDER_PRIORITY_IDS], [...MODEL_FINDER_PRIORITIES]);
});
