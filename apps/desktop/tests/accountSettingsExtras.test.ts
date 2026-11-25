import test from "node:test";
import assert from "node:assert/strict";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { createAccountDataApi } from "../src/host/account-data-api";
import { desktopAccountSettingsInput, type DesktopAccountSettingsInput } from "../src/account-settings-contract";

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
  assert.equal((await settings({ action: "extractionRuns" })).activeRunId, "run_1");
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
  const old = await settings({ action: "memoryDetail", id: "mem_1" });
  assert.equal(old.memory.revision, undefined);
  const { settings: current } = settingsWith(() => Response.json({ memory: { ...base, revision: 2, projectId: "proj_1" }, conflicts: [] }));
  const detail = await current({ action: "memoryDetail", id: "mem_1" });
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
