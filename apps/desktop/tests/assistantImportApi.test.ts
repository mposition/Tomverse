import test from "node:test";
import assert from "node:assert/strict";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { createAssistantImportApi } from "../src/host/assistant-import-api";
import { AccountDataRefusal } from "../src/host/account-data-refusal";
import { assistantImportInput } from "../src/assistant-import-contract";

const origin = "https://tomverse.example";
const storageUrl = "https://acct.r2.cloudflarestorage.com/assistant-knowledge/key?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";
const identity = { name: "Helper", icon: null, description: null };
const createBody = {
  mode: "create" as const, identity, stagingManifest: { kind: "agent-skill", draft: {} },
  declared: { sourceKind: null, sourceName: null, sourceUrl: null, previousProvenance: null },
};
const publishBody = {
  approvedDigest: "a".repeat(64), digestVersion: 1, keepFileIds: ["file_1"], identity,
  draft: { instructions: "Be brief.", modelIds: [], toolPolicy: { webSearch: false, deepResearch: false },
    memoryPolicy: { useAccountMemory: false }, starters: [] },
};

type Reply = (url: URL, init?: RequestInit) => Response | Promise<Response>;

function setup(options: { reply?: Reply; pick?: { name: string; bytes: Uint8Array } | null | "tooLarge"; put?: Response } = {}) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const puts: { url: string; length: number; headers: HeadersInit | undefined }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: "a.b.c.d.e", expiresAt: Date.now() + 300_000 });
    if (url.hostname.endsWith("r2.cloudflarestorage.com")) {
      puts.push({ url: String(input), length: (init?.body as Uint8Array).byteLength, headers: init?.headers });
      return options.put ?? new Response(null, { status: 200 });
    }
    calls.push({ method: init?.method ?? "GET", path: url.pathname, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    return (options.reply ?? (() => Response.json({})))(url, init);
  };
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", new AbortController().signal, transport);
  const api = createAssistantImportApi({
    settings, origin, transport,
    pickFile: async () => {
      if (options.pick === "tooLarge") throw new AccountDataRefusal("failed", "FILE_TOO_LARGE");
      return options.pick === undefined ? { name: "skill.zip", bytes: new Uint8Array([0x50, 0x4b, 3, 4]) } : options.pick;
    },
  });
  return { api, calls, puts };
}

const knowledgeReply = (prepared?: object): Reply => (url, init) => {
  if (url.pathname.endsWith("/knowledge")) {
    const body = JSON.parse(String(init?.body));
    if (body.action === "prepare") return Response.json(prepared ?? { uploadKey: "k1", uploadUrl: storageUrl, uploadHeaders: { "Content-Type": "text/markdown" } });
    return Response.json({ id: "file_1", name: body.filename, mime: body.mime, bytes: 7, processingStatus: "pending" });
  }
  return Response.json({});
};

test("the window can only name the actions the wizard needs, with bounded fields", () => {
  const ok = (value: unknown) => assistantImportInput.safeParse(value).success;
  assert.ok(ok({ action: "targets" }) && ok({ action: "pickPackage" }) && ok({ action: "read", importId: "imp_1" }));
  assert.ok(ok({ action: "create", body: createBody }));
  assert.ok(ok({ action: "publish", importId: "imp_1", body: publishBody }));
  assert.ok(ok({ action: "upload", importId: "imp_1", filename: "notes.md", bytes: new Uint8Array(3) }));
  // No path, no URL, no extra field crosses.
  assert.equal(ok({ action: "read", importId: "../x" }), false);
  assert.equal(ok({ action: "read", importId: "imp_1", path: "/api/user" }), false);
  assert.equal(ok({ action: "fetch", path: "/api/user" }), false);
  assert.equal(ok({ action: "create", body: { ...createBody, mode: "merge" } }), false, "a merge needs its target");
  assert.equal(ok({ action: "create", body: { ...createBody, extra: 1 } }), false);
  assert.equal(ok({ action: "publish", importId: "imp_1", body: { ...publishBody, keepFileIds: Array(65).fill("f") } }), false);
  assert.equal(ok({ action: "publish", importId: "imp_1", body: { ...publishBody, draft: { ...publishBody.draft, instructions: "x".repeat(200_000) } } }), false);
  assert.equal(ok({ action: "upload", importId: "imp_1", filename: "notes.md", bytes: new Uint8Array(0) }), false);
  assert.equal(ok({ action: "upload", importId: "imp_1", filename: "notes.md", bytes: "text" }), false);
});

test("the entry point is offered only when the server says the import is on", async () => {
  const list = (features?: object) => setup({ reply: () => Response.json({ profiles: [
    { id: "prof_1", name: "Writer", icon: "W", description: "d", published: true, currentRevision: 3, publishedAt: null, versionCount: 3, knowledgeFileCount: 2 },
  ], limits: { maxProfilesPerAccount: 10 }, ...(features ? { features } : {}) }) });
  const on = list({ packageImport: true });
  assert.deepEqual(await on.api.handle({ action: "targets" }), { ok: true, value: { enabled: true, targets: [
    { id: "prof_1", name: "Writer", icon: "W", currentRevision: 3, knowledgeFileCount: 2 },
  ] } });
  assert.deepEqual(on.calls, [{ method: "GET", path: "/api/assistant-profiles", body: undefined }]);
  const off = await list({ packageImport: false }).api.handle({ action: "targets" });
  assert.ok(off.ok && "enabled" in off.value && off.value.enabled === false);
  // A server that does not report the switch is treated as off.
  const unknown = await list().api.handle({ action: "targets" });
  assert.ok(unknown.ok && "enabled" in unknown.value && unknown.value.enabled === false);
});

test("a package is picked in the main process, and a file that cannot be one is refused before the wizard reads it", async () => {
  const picked = await setup().api.handle({ action: "pickPackage" });
  assert.ok(picked.ok && "bytes" in picked.value);
  assert.equal(picked.ok && "name" in picked.value && picked.value.name, "skill.zip");
  assert.deepEqual(await setup({ pick: null }).api.handle({ action: "pickPackage" }), { ok: true, value: { kind: "cancelled" } });
  assert.deepEqual(await setup({ pick: { name: "notes.exe", bytes: new Uint8Array(9) } }).api.handle({ action: "pickPackage" }),
    { ok: true, value: { kind: "refused", code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED", name: "notes.exe", size: 9 } });
  assert.deepEqual(await setup({ pick: { name: "noextension", bytes: new Uint8Array(9) } }).api.handle({ action: "pickPackage" }),
    { ok: true, value: { kind: "refused", code: "ASSISTANT_PACKAGE_FORMAT_UNSUPPORTED", name: "noextension", size: 9 } });
  assert.equal((await setup({ pick: { name: "SKILL.JSON", bytes: new Uint8Array(2) } }).api.handle({ action: "pickPackage" })).ok, true);
  const large = await setup({ pick: "tooLarge" }).api.handle({ action: "pickPackage" });
  assert.ok(large.ok && "code" in large.value && large.value.code === "ASSISTANT_PACKAGE_TOO_LARGE");
});

test("an import is created, read, published and cancelled on the import routes", async () => {
  const { api, calls } = setup({ reply: (url, init) => {
    if (url.pathname === "/api/assistant-profiles/imports") return Response.json({ id: "imp_1", profileId: "prof_9", mode: "create", status: "staging", extra: "ignored" }, { status: 201 });
    if (url.pathname.endsWith("/publish")) return Response.json({ outcome: "published", version: { id: "v1", revision: 1 } });
    if (init?.method === "DELETE") return Response.json({ outcome: "cancelled", deletedProfile: true });
    return Response.json({ id: "imp_1", mode: "create", status: "staging", profileId: "prof_9", ready: false, stagingManifest: { secret: 1 },
      files: [{ id: "file_1", name: "a.md", mime: "text/markdown", bytes: 4, processingStatus: "pending", failureCode: null }] });
  } });
  assert.deepEqual(await api.handle({ action: "create", body: createBody }), { ok: true, value: { id: "imp_1", profileId: "prof_9", mode: "create", status: "staging" } });
  const read = await api.handle({ action: "read", importId: "imp_1" });
  assert.deepEqual(read, { ok: true, value: { id: "imp_1", mode: "create", status: "staging", profileId: "prof_9", ready: false,
    files: [{ id: "file_1", name: "a.md", processingStatus: "pending", failureCode: null }] } });
  assert.deepEqual(await api.handle({ action: "publish", importId: "imp_1", body: publishBody }), { ok: true, value: { outcome: "published", version: { id: "v1", revision: 1 } } });
  assert.deepEqual(await api.handle({ action: "cancel", importId: "imp_1" }), { ok: true, value: {} });
  assert.deepEqual(calls.map(call => call.method + " " + call.path), [
    "POST /api/assistant-profiles/imports", "GET /api/assistant-profiles/imports/imp_1",
    "POST /api/assistant-profiles/imports/imp_1/publish", "DELETE /api/assistant-profiles/imports/imp_1",
  ]);
  assert.deepEqual(calls[0].body, createBody);
  assert.deepEqual(calls[2].body, publishBody);
});

test("a document uploads to Tomverse storage between its reservation and its registration, in that order", async () => {
  const { api, calls, puts } = setup({ reply: knowledgeReply() });
  assert.deepEqual(await api.handle({ action: "upload", importId: "imp_1", filename: "notes.md", bytes: new TextEncoder().encode("# Notes") }), { ok: true, value: { id: "file_1" } });
  assert.deepEqual(calls.map(call => call.method + " " + call.path + " " + (call.body as { action: string }).action), [
    "POST /api/assistant-profiles/imports/imp_1/knowledge prepare", "POST /api/assistant-profiles/imports/imp_1/knowledge finalize",
  ]);
  assert.deepEqual(calls[0].body, { action: "prepare", filename: "notes.md", mime: "text/markdown", bytes: 7 });
  assert.deepEqual(calls[1].body, { action: "finalize", uploadKey: "k1", filename: "notes.md", mime: "text/markdown" });
  assert.equal(puts.length, 1);
  assert.equal(puts[0].url, storageUrl);
  assert.equal(puts[0].length, 7);
});

test("a document never reaches an untrusted destination, an unsupported type or a failed storage write's registration", async () => {
  for (const uploadUrl of ["https://evil.example/upload?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc",
    "http://acct.r2.cloudflarestorage.com/k?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc",
    "https://acct.r2.cloudflarestorage.com/k"]) {
    const { api, puts } = setup({ reply: knowledgeReply({ uploadKey: "k1", uploadUrl, uploadHeaders: { "Content-Type": "text/markdown" } }) });
    const refused = await api.handle({ action: "upload", importId: "imp_1", filename: "notes.md", bytes: new Uint8Array([35, 32, 65]) });
    assert.deepEqual(refused, { ok: false, status: 0, code: "ASSISTANT_PACKAGE_UPLOAD_FAILED" });
    assert.equal(puts.length, 0);
  }
  const wrongHeader = setup({ reply: knowledgeReply({ uploadKey: "k1", uploadUrl: storageUrl, uploadHeaders: { "Content-Type": "text/csv" } }) });
  assert.equal((await wrongHeader.api.handle({ action: "upload", importId: "imp_1", filename: "notes.md", bytes: new Uint8Array([35]) })).ok, false);
  assert.equal(wrongHeader.puts.length, 0);
  const unsupported = setup({ reply: knowledgeReply() });
  assert.deepEqual(await unsupported.api.handle({ action: "upload", importId: "imp_1", filename: "tool.exe", bytes: new Uint8Array([1]) }),
    { ok: false, status: 415, code: "ASSISTANT_KNOWLEDGE_UNSUPPORTED_FILE" });
  assert.equal(unsupported.calls.length, 0, "nothing is asked of the server for a file that cannot be knowledge");
  const down = setup({ reply: knowledgeReply(), put: new Response(null, { status: 403 }) });
  assert.deepEqual(await down.api.handle({ action: "upload", importId: "imp_1", filename: "notes.md", bytes: new Uint8Array([35]) }),
    { ok: false, status: 403, code: "ASSISTANT_PACKAGE_UPLOAD_FAILED" });
  assert.equal(down.calls.length, 1, "no registration after a failed storage write");
});

test("a refusal keeps the status and the server's code, a document still being read is an answer, and a lapsed session is dropped", async () => {
  const disabled = setup({ reply: () => Response.json({ error: "private message", code: "ASSISTANT_PACKAGE_IMPORT_DISABLED" }, { status: 403 }) });
  assert.deepEqual(await disabled.api.handle({ action: "create", body: createBody }), { ok: false, status: 403, code: "ASSISTANT_PACKAGE_IMPORT_DISABLED" });
  const stale = setup({ reply: () => Response.json({ code: "ASSISTANT_PROFILE_VERSION_STALE" }, { status: 409 }) });
  assert.deepEqual(await stale.api.handle({ action: "publish", importId: "imp_1", body: publishBody }), { ok: false, status: 409, code: "ASSISTANT_PROFILE_VERSION_STALE" });
  const waiting = setup({ reply: () => Response.json({ outcome: "not_ready", pending: 2, failed: 0 }, { status: 409 }) });
  assert.deepEqual(await waiting.api.handle({ action: "publish", importId: "imp_1", body: publishBody }), { ok: true, value: { outcome: "not_ready", pending: 2, failed: 0 } });
  const html = setup({ reply: () => new Response("<html>bad gateway</html>", { status: 502, headers: { "content-type": "text/html" } }) });
  assert.deepEqual(await html.api.handle({ action: "read", importId: "imp_1" }), { ok: false, status: 502, code: "HTTP_502" });
  const garbled = setup({ reply: () => Response.json({ unexpected: true }) });
  assert.deepEqual(await garbled.api.handle({ action: "read", importId: "imp_1" }), { ok: false, status: 0, code: "ASSISTANT_PACKAGE_IMPORT_FAILED" });
  // The same session is asked again after a 401: it was forgotten, so a new one is issued.
  let sessions = 0;
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") { sessions += 1; return Response.json({ token: "a.b.c.d.e", expiresAt: Date.now() + 300_000 }); }
    return Response.json({ code: "UNAUTHORIZED" }, { status: 401 });
  };
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", new AbortController().signal, transport);
  const api = createAssistantImportApi({ settings, origin, pickFile: async () => null, transport });
  await api.handle({ action: "read", importId: "imp_1" });
  await api.handle({ action: "read", importId: "imp_1" });
  assert.equal(sessions, 2);
});
