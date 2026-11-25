import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { desktopAccountSettingsInput } from "../src/account-settings-contract";

const origin = "https://tomverse.example";
const fixtureCookie = "fixture..account.settings.signature";

test("native settings send the short-lived cookie only to allowlisted settings APIs", async () => {
  const calls: { url: URL; init?: RequestInit }[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/auth/desktop/settings-session") {
      return Response.json({ token: fixtureCookie, expiresAt: Date.now() + 300_000 });
    }
    if (init?.method === "POST") return Response.json({ success: true });
    return Response.json({ theme: "dark", language: "ko", timeZone: "Australia/Brisbane", timeZoneChangeAllowedAt: null });
  };
  const account = new AbortController();
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", account.signal, transport);
  const [preferences] = await Promise.all([settings({ action: "preferences" }), settings({ action: "preferences" })]);
  assert.deepEqual(preferences, {
    theme: "dark", language: "ko", timeZone: "Australia/Brisbane", timeZoneChangeAllowedAt: null, newConversationModelIds: [],
  });
  await settings({ action: "savePreferences", changes: { timeZone: "UTC" } });
  assert.deepEqual(calls.map(call => call.url.pathname),
    ["/api/auth/desktop/settings-session", "/api/user/settings", "/api/user/settings", "/api/user/settings"]);
  assert.equal(new Headers(calls[0].init?.headers).get("authorization"), "Bearer fixture-desktop");
  assert.equal(new Headers(calls[0].init?.headers).get("cookie"), null);
  for (const { url, init } of calls.slice(1)) {
    assert.equal(url.origin, origin);
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    assert.equal(headers.get("cookie"), "__Secure-next-auth.session-token=" + fixtureCookie);
    assert.equal(headers.get("authorization"), null);
  }
  assert.deepEqual(JSON.parse(String(calls.at(-1)?.init?.body)), { timeZone: "UTC", timeZoneSource: "user" });
  account.abort();
  await assert.rejects(settings({ action: "preferences" }), { name: "AbortError" });
  assert.equal(calls.length, 4);
});

test("the settings IPC refuses arbitrary routes and rejects an invalid resource identifier", () => {
  assert.equal(desktopAccountSettingsInput.safeParse({ action: "preferences", path: "https://other.example" }).success, false);
  assert.equal(desktopAccountSettingsInput.safeParse({ action: "revokeKey", id: "../users" }).success, false);
  assert.equal(desktopAccountSettingsInput.safeParse({ action: "savePreferences", changes: { plan: "Max" } }).success, false);
});

test("a conversation export with original messages requires complete verified bytes", async () => {
  const content = "Original and continued conversations.\n";
  const digest = createHash("sha256").update(content).digest("hex");
  const headers: Record<string, string> = { "content-type": "text/plain", "x-export-sha256": digest, "x-export-bytes": String(content.length) };
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") {
      return Response.json({ token: fixtureCookie, expiresAt: Date.now() + 300_000 });
    }
    assert.equal(url.href, origin + "/api/conversations/test-conversation/export?include=source");
    return new Response(content, { headers });
  };
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", new AbortController().signal, transport);
  assert.equal((await settings.exportConversation("test-conversation", true)).toString("utf8"), content);
  headers["x-export-sha256"] = "0".repeat(64);
  await assert.rejects(settings.exportConversation("test-conversation", true), /verification/);
  delete headers["x-export-bytes"];
  await assert.rejects(settings.exportConversation("test-conversation", true), /verification headers/);
});
