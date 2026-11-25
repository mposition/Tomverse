import test from "node:test";
import assert from "node:assert/strict";
import { desktopProjectInput } from "../src/project-contract";
import { createProjectRunner, materialMimeFor, pickMaterialFiles, projectTransport, trustedStorageUrl } from "../src/host/project-api";

type Sent = { path: string; method?: string; body?: object };
const origin = "https://tomverse.example";
const signedStorage = "https://account.r2.cloudflarestorage.com/object?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=abc";

function fakeSettings(respond: (request: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  let forgotten = 0;
  return {
    sent, get forgotten() { return forgotten; },
    send: async (request: Sent) => { sent.push(request); return respond(request); },
    forget: () => { forgotten++; },
  };
}
const io = { chooseMaterialFiles: async () => null, saveMaterial: async () => false };

test("the project IPC names an action and rejects paths, bad ids and unknown fields", () => {
  assert.equal(desktopProjectInput.safeParse({ action: "detail", projectId: "p_1" }).success, true);
  assert.equal(desktopProjectInput.safeParse({ action: "detail", projectId: "../users" }).success, false);
  assert.equal(desktopProjectInput.safeParse({ action: "detail", projectId: "p_1", path: "/api/admin" }).success, false);
  assert.equal(desktopProjectInput.safeParse({ action: "fetch", path: "/api/projects" }).success, false);
  assert.equal(desktopProjectInput.safeParse({ action: "update", projectId: "p_1", expectedRevision: 2, patch: { plan: "Max" } }).success, false);
  assert.equal(desktopProjectInput.safeParse({ action: "saveSource", projectId: "p_1", clientRequestId: "request-0001",
    source: { sourceKind: "research_report", runId: "run_1" } }).success, true);
  assert.equal(desktopProjectInput.safeParse({ action: "saveSource", projectId: "p_1", clientRequestId: "request-0001",
    source: { sourceKind: "review_result", conversationId: "c", analysis: {} } }).success, false);
  assert.equal(desktopProjectInput.safeParse({ action: "moveConversation", conversationId: "c_1", projectId: null }).success, true);
});

test("project actions become the workspace requests the web uses, on the account session", async () => {
  const settings = fakeSettings((request) => request.path.endsWith("view=deletion")
    ? Response.json({ deletion: { conversations: 1, materials: 2, memories: 3, revision: 4 } }) : Response.json({ projects: [], ok: true }));
  const run = createProjectRunner(settings, origin, io);
  await run({ action: "list" });
  await run({ action: "rename", projectId: "p_1", name: "Launch" });
  await run({ action: "update", projectId: "p_1", expectedRevision: 7, patch: { instructions: "Be brief", contextEnabled: true } });
  const plan = await run({ action: "deletionSummary", projectId: "p_1" });
  await run({ action: "remove", projectId: "p_1", confirmation: { revision: 4, materials: 2, memories: 3 } });
  await run({ action: "moveConversation", conversationId: "c_9", projectId: null });
  await run({ action: "moveMemory", memoryId: "m_2", expectedRevision: 3, targetProjectId: "p_1" });
  await run({ action: "search", projectId: "p_1", query: "pricing" });
  assert.deepEqual(plan, { ok: true, value: { conversations: 1, materials: 2, memories: 3, revision: 4 } });
  assert.deepEqual(settings.sent.map(({ method, path }) => `${method ?? "GET"} ${path}`), [
    "GET /api/projects",
    "PATCH /api/projects/p_1",
    "PATCH /api/projects/p_1",
    "GET /api/projects/p_1?view=deletion",
    "DELETE /api/projects/p_1",
    "PATCH /api/conversations/c_9",
    "POST /api/memories/m_2/scope",
    "POST /api/projects/p_1/search",
  ]);
  assert.deepEqual(settings.sent[1].body, { name: "Launch" });
  assert.deepEqual(settings.sent[2].body, { instructions: "Be brief", contextEnabled: true, expectedRevision: 7 });
  assert.deepEqual(settings.sent[4].body, { confirmation: { revision: 4, materials: 2, memories: 3 } });
  assert.deepEqual(settings.sent[5].body, { projectId: null });
  assert.deepEqual(settings.sent[6].body, { expectedRevision: 3, targetProjectId: "p_1" });
});

test("a refused call returns the status and server code instead of throwing", async () => {
  const settings = fakeSettings(() => Response.json({ code: "PROJECT_ARCHIVED", details: { revision: 2 } }, { status: 409 }));
  const run = createProjectRunner(settings, origin, io);
  assert.deepEqual(await run({ action: "addNote", projectId: "p_1", title: "Note", text: "Body", clientRequestId: "request-0001" }),
    { ok: false, status: 409, code: "PROJECT_ARCHIVED", details: { revision: 2 } });
  const down = createProjectRunner(fakeSettings(() => { throw new TypeError("network"); }), origin, io);
  assert.deepEqual(await down({ action: "list" }), { ok: false, status: 0, code: "PROJECT_REQUEST_FAILED" });
  const aborted = createProjectRunner(fakeSettings(() => { throw new DOMException("gone", "AbortError"); }), origin, io);
  await assert.rejects(aborted({ action: "list" }), { name: "AbortError" });
});

test("the transport refuses routes outside the workspace and forgets a rejected session", async () => {
  const settings = fakeSettings(() => new Response("{}", { status: 401 }));
  const transport = projectTransport(settings);
  await assert.rejects(transport("/api/admin/users"), /not a project workspace route/);
  await assert.rejects(transport("/api/conversations/c_1/export"), /not a project workspace route/);
  await assert.rejects(transport("/api/conversations"), /not a project workspace route/);
  assert.equal((await transport("/api/projects")).status, 401);
  assert.equal(settings.forgotten, 1);
});

test("file bytes travel only to the signed storage address", () => {
  assert.ok(trustedStorageUrl(signedStorage, origin));
  assert.equal(trustedStorageUrl("https://account.r2.cloudflarestorage.com/object", origin), null);
  assert.equal(trustedStorageUrl("https://account.r2.cloudflarestorage.com:8443/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=a", origin), null);
  assert.equal(trustedStorageUrl("https://evil.example/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=a", origin), null);
  assert.equal(trustedStorageUrl("https://u:p@account.r2.cloudflarestorage.com/o?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Signature=a", origin), null);
  assert.equal(trustedStorageUrl("http://127.0.0.1:4000/upload", origin), null);
  assert.ok(trustedStorageUrl("http://127.0.0.1:4000/upload", "http://127.0.0.1:3100"));
  assert.equal(trustedStorageUrl("not a url", origin), null);
});

test("uploading materials prepares, puts the bytes to storage and finalizes each picked file", async () => {
  const puts: Array<{ url: string; type: string | null; size: number }> = [];
  const settings = fakeSettings((request) => {
    const body = request.body as { action?: string; filename?: string; mime?: string };
    if (body.action === "prepare") {
      return Response.json({ uploadKey: "key-" + body.filename, uploadUrl: body.filename === "bad.pdf" ? "https://evil.example/o" : signedStorage,
        uploadHeaders: { "Content-Type": body.mime } });
    }
    return Response.json({ file: { id: "file-" + body.filename, name: body.filename, processingStatus: "pending" } }, { status: 201 });
  });
  const transport: typeof fetch = async (input, init) => {
    const file = init?.body as Blob;
    puts.push({ url: String(input), type: new Headers(init?.headers).get("content-type"), size: file.size });
    assert.equal(init?.credentials, "omit");
    return new Response(null, { status: 200 });
  };
  const run = createProjectRunner(settings, origin, {
    ...io, transport,
    chooseMaterialFiles: async () => [
      { name: "brief.md", mime: "text/markdown", bytes: new Uint8Array([35, 32, 104, 105]) },
      { name: "bad.pdf", mime: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
    ],
  });
  const outcome = await run({ action: "uploadMaterials", projectId: "p_1" });
  assert.deepEqual(outcome, { ok: true, value: { cancelled: false, files: [
    { name: "brief.md", id: "file-brief.md" },
    { name: "bad.pdf", code: "PROJECT_MATERIAL_UPLOAD_FAILED" },
  ] } });
  assert.deepEqual(puts, [{ url: signedStorage, type: "text/markdown", size: 4 }]);
  assert.deepEqual(settings.sent.map(({ body }) => (body as { action: string }).action), ["prepare", "finalize", "prepare"]);
  const cancelled = createProjectRunner(settings, origin, io);
  assert.deepEqual(await cancelled({ action: "uploadMaterials", projectId: "p_1" }), { ok: true, value: { cancelled: true, files: [] } });
});

test("downloading a material saves verified bytes through the save dialog", async () => {
  const settings = fakeSettings(() => Response.json({ url: signedStorage, name: "plan.pdf", mime: "application/pdf" }));
  let saved: { bytes: Uint8Array; suggestedName: string; extension: string } | undefined;
  const run = createProjectRunner(settings, origin, {
    ...io, transport: async () => new Response(new Uint8Array([1, 2, 3, 4])),
    saveMaterial: async (load) => { saved = await load(); return true; },
  });
  assert.deepEqual(await run({ action: "downloadMaterial", projectId: "p_1", fileId: "f_1" }), { ok: true, value: true });
  assert.deepEqual(saved && { size: saved.bytes.byteLength, name: saved.suggestedName, extension: saved.extension },
    { size: 4, name: "plan.pdf", extension: "pdf" });
  const hostile = createProjectRunner(fakeSettings(() => Response.json({ url: "https://evil.example/f", name: "x.pdf", mime: "application/pdf" })), origin, {
    ...io, saveMaterial: async (load) => { await load(); return true; },
  });
  assert.deepEqual(await hostile({ action: "downloadMaterial", projectId: "p_1", fileId: "f_1" }),
    { ok: false, status: 502, code: "PROJECT_MATERIAL_DOWNLOAD_FAILED" });
});

test("the file picker keeps only supported, non-empty, in-limit files", async () => {
  assert.equal(materialMimeFor("notes.MD"), "text/markdown");
  assert.equal(materialMimeFor("archive.zip"), null);
  assert.equal(materialMimeFor("README"), null);
  const cancelled = await pickMaterialFiles({ showOpenDialog: async () => ({ canceled: true, filePaths: [] }), readFile: async () => new Uint8Array(), title: "t", filterName: "f" });
  assert.equal(cancelled, null);
  let filters: unknown;
  const files = await pickMaterialFiles({
    title: "Choose", filterName: "Documents",
    showOpenDialog: async (options) => { filters = options.filters; return { canceled: false, filePaths: ["/a/brief.md", "/a/movie.mov", "/a/empty.txt", "/a/data.csv"] }; },
    readFile: async (path) => path.endsWith("empty.txt") ? new Uint8Array() : new Uint8Array([1, 2]),
  });
  assert.deepEqual(files?.map(({ name, mime }) => [name, mime]), [["brief.md", "text/markdown"], ["data.csv", "text/csv"]]);
  assert.ok((filters as Array<{ extensions: string[] }>)[0].extensions.includes("pdf"));
});
