import test from "node:test";
import assert from "node:assert/strict";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { createAccountDataApi, type AccountDataSave } from "../src/host/account-data-api";
import { desktopAccountDataInput } from "../src/account-data-contract";

const origin = "https://tomverse.example";
const cookie = "fixture..account.settings.signature";
const ticketPath = "/api/user/account/export/" + "t".repeat(43);

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

function setup(handler: Handler) {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: cookie, expiresAt: Date.now() + 300_000 });
    calls.push({ url, init });
    return handler(url, init);
  };
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", new AbortController().signal, transport);
  const saved: { name: string; bytes: Buffer }[] = [];
  let cancel = false;
  let signedOut = 0;
  const save: AccountDataSave = async (file) => {
    if (cancel) return false;
    saved.push({ name: file.suggestedName, bytes: Buffer.from(await file.load()) });
    return true;
  };
  const api = createAccountDataApi({
    settings, save, afterAccountDeleted: async () => { signedOut += 1; }, language: () => "ko",
  });
  return { api, calls, saved, cancel: (value: boolean) => { cancel = value; }, signedOut: () => signedOut };
}

const exportBody = JSON.stringify({ manifest: { schemaVersion: 1 }, conversations: [] });

test("an account export is requested, then saved once from the single-use link", async () => {
  const { api, calls, saved } = setup((url, init) => {
    if (init?.method === "POST") return Response.json({ downloadPath: ticketPath, expiresAt: new Date(Date.now() + 300_000).toISOString(), singleUse: true }, { status: 201 });
    assert.equal(url.pathname, ticketPath);
    return new Response(exportBody, { headers: { "content-type": "application/json; charset=utf-8" } });
  });
  const requested = await api.handle({ action: "requestExport" });
  assert.equal(requested.status, "ready");
  assert.ok(requested.expiresAt);
  assert.deepEqual(await api.handle({ action: "saveExport" }), { status: "saved" });
  assert.match(saved[0].name, /^tomverse-account-data-\d{4}-\d{2}-\d{2}\.json$/);
  assert.equal(saved[0].bytes.toString("utf8"), exportBody);
  assert.equal(new Headers(calls[0].init?.headers).get("cookie"), "__Secure-next-auth.session-token=" + cookie);
  assert.equal(calls[0].init?.redirect, "error");
  // The link was spent by the download: a second save asks for a new one.
  assert.deepEqual(await api.handle({ action: "saveExport" }), { status: "expired" });
  assert.equal(calls.length, 2);
});

test("cancelling the save dialog leaves the link unused and checks the file format", async () => {
  let body = exportBody;
  let type = "application/json";
  const { api, calls, cancel, saved } = setup((_url, init) => init?.method === "POST"
    ? Response.json({ downloadPath: ticketPath, expiresAt: new Date(Date.now() + 300_000).toISOString() })
    : new Response(body, { headers: { "content-type": type } }));
  await api.handle({ action: "requestExport" });
  cancel(true);
  assert.deepEqual(await api.handle({ action: "saveExport" }), { status: "cancelled" });
  assert.equal(calls.length, 1, "no download before a destination is chosen");
  cancel(false);
  type = "text/html";
  assert.deepEqual(await api.handle({ action: "saveExport" }), { status: "failed" });
  await api.handle({ action: "requestExport" });
  type = "application/json";
  body = "{ truncated";
  assert.deepEqual(await api.handle({ action: "saveExport" }), { status: "failed" });
  await api.handle({ action: "requestExport" });
  body = JSON.stringify({ items: [] });
  assert.deepEqual(await api.handle({ action: "saveExport" }), { status: "failed" });
  assert.equal(saved.length, 0);
});

test("an export link that points outside the export route is never fetched", async () => {
  const { api, calls } = setup(() => Response.json({ downloadPath: "/api/admin/users", expiresAt: new Date(Date.now() + 300_000).toISOString() }));
  assert.deepEqual(await api.handle({ action: "requestExport" }), { status: "failed" });
  assert.deepEqual(await api.handle({ action: "saveExport" }), { status: "expired" });
  assert.equal(calls.length, 1);
});

test("server refusals become quiet states instead of errors", async () => {
  for (const [code, status] of [[428, "reauth"], [404, "unavailable"], [503, "unavailable"], [403, "notIncluded"], [423, "locked"], [500, "failed"]] as const) {
    const { api } = setup(() => Response.json({}, { status: code }));
    assert.equal((await api.handle({ action: "requestExport" })).status, status, "export " + code);
    assert.equal((await api.handle({ action: "saveAllConversations" })).status, status, "all conversations " + code);
    assert.equal((await api.handle({ action: "deleteAllConversations", confirmation: "DELETE ALL CHATS" })).status, status, "delete all " + code);
  }
});

test("all conversations download as verified plain text with the naming headers", async () => {
  let type = "text/plain; charset=utf-8";
  const { api, calls, saved } = setup(() => new Response("Chat one\n", { headers: { "content-type": type } }));
  assert.deepEqual(await api.handle({ action: "saveAllConversations" }), { status: "saved" });
  assert.equal(saved[0].name, "tomverse-all-conversations.txt");
  assert.equal(saved[0].bytes.toString("utf8"), "Chat one\n");
  const headers = new Headers(calls[0].init?.headers);
  assert.equal(calls[0].url.pathname, "/api/conversations/export-all");
  assert.equal(headers.get("x-tomverse-language"), "ko");
  assert.ok(headers.get("x-tomverse-time-zone"));
  type = "text/html";
  assert.deepEqual(await api.handle({ action: "saveAllConversations" }), { status: "failed" });
});

test("deleting every conversation needs the typed phrase and reports locked chats", async () => {
  assert.equal(desktopAccountDataInput.safeParse({ action: "deleteAllConversations" }).success, false);
  assert.equal(desktopAccountDataInput.safeParse({ action: "deleteAllConversations", confirmation: "yes" }).success, false);
  const { api, calls } = setup(() => Response.json({ success: true, deleted: 7 }));
  assert.deepEqual(await api.handle({ action: "deleteAllConversations", confirmation: "DELETE ALL CHATS" }), { status: "deleted", deleted: 7 });
  assert.equal(calls[0].init?.method, "DELETE");
  assert.equal(calls[0].url.pathname, "/api/conversations");
  const locked = setup(() => Response.json({ code: "CONVERSATION_LOCKED" }, { status: 423 }));
  assert.deepEqual(await locked.api.handle({ action: "deleteAllConversations", confirmation: "DELETE ALL CHATS" }), { status: "locked", code: "CONVERSATION_LOCKED" });
});

test("account deletion signs Desktop out only after the server accepts it", async () => {
  assert.equal(desktopAccountDataInput.safeParse({ action: "deleteAccount", confirmation: "delete my account" }).success, false);
  assert.equal(desktopAccountDataInput.safeParse({ action: "deleteAccount", confirmation: "DELETE MY ACCOUNT", path: "/api/x" }).success, false);
  const refused = setup(() => Response.json({ code: "ACCOUNT_REAUTHENTICATION_REQUIRED" }, { status: 428 }));
  assert.deepEqual(await refused.api.handle({ action: "deleteAccount", confirmation: "DELETE MY ACCOUNT" }), { status: "reauth", code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });
  assert.equal(refused.signedOut(), 0);
  const accepted = setup(() => Response.json({ success: true, scheduledFor: new Date().toISOString() }));
  assert.deepEqual(await accepted.api.handle({ action: "deleteAccount", confirmation: "DELETE MY ACCOUNT" }), { status: "deleted" });
  assert.equal(accepted.signedOut(), 1);
  const call = accepted.calls[0];
  assert.equal(call.init?.method, "DELETE");
  assert.equal(call.url.pathname, "/api/user/account");
  assert.deepEqual(JSON.parse(String(call.init?.body)), { confirm: true, confirmationText: "DELETE MY ACCOUNT" });
});

test("the export history is read through the settings contract", async () => {
  const { desktopAccountSettingsOutput } = await import("../src/account-settings-contract");
  const parsed = desktopAccountSettingsOutput.exportHistory.parse({ requests: [{
    id: "req_1", status: "downloaded", refusalReason: null, expiresAt: "2026-11-25T00:00:00.000Z", consumedAt: null,
    byteLength: 2048, createdAt: "2026-11-25T00:00:00.000Z", includedDomainCount: 4,
  }] });
  assert.equal(parsed.requests[0].byteLength, 2048);
});
