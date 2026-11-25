import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { createImportedSourceUnlock } from "../src/host/imported-source-unlock";
import {
  chatImportedSource, chatImportedSourceWire, chatUnlockImportedInput, chatUnlockImportedResult,
} from "../src/chat-contract";

const origin = "https://tomverse.example";
const sessionToken = "fixture..account.settings.signature";
const sessionCookie = "__Secure-next-auth.session-token=" + sessionToken;
const grantValue = (expiresInSeconds = 1_800, version = 0) =>
  `${Math.floor(Date.now() / 1_000) + expiresInSeconds}.${version}.${"s".repeat(43)}`;
const grantCookie = (externalId: string, value = grantValue()) => `tomverse_unlock_external_conversation_${externalId}=${value}`;

type Call = { url: URL; init?: RequestInit };
function harness(handler: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const transport: typeof fetch = async (input, init) => {
    const call = { url: new URL(String(input)), init };
    calls.push(call);
    if (call.url.pathname === "/api/auth/desktop/settings-session") {
      return Response.json({ token: sessionToken, expiresAt: Date.now() + 300_000 });
    }
    return handler(call);
  };
  const account = new AbortController();
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", account.signal, transport);
  const unlock = createImportedSourceUnlock({ settings, signal: account.signal });
  return { calls, account, unlock, settings };
}

const lockedWire = (externalConversationId?: string) => chatImportedSourceWire.parse({
  provider: "chatgpt", source: { status: "locked", ...(externalConversationId ? { externalConversationId } : {}) },
});
const availableBody = { provider: "chatgpt", source: { status: "available", offset: 0, messageTotal: 1,
  messages: [{ id: "m1", role: "user", content: "hello" }] } };
const verifyPath = (id: string) => `/api/external-conversations/${id}/lock/verify`;
const unlockedResponse = (externalId: string, value?: string) => new Response(JSON.stringify({ success: true }), {
  status: 200, headers: { "Content-Type": "application/json",
    "Set-Cookie": `${grantCookie(externalId, value)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=1800; Priority=High; Secure` },
});

test("a locked original is shown to the renderer without its snapshot id, and says it can be unlocked", async () => {
  const { unlock } = harness(() => { throw new Error("no account call expected"); });
  const page = await unlock.read({ id: "c1" }, async () => lockedWire("ext1"));
  assert.deepEqual(page, { provider: "chatgpt", source: { status: "locked", unlockable: true } });
  assert.equal(JSON.stringify(page).includes("ext1"), false);
  assert.deepEqual(chatImportedSource.parse(page), page);
  // A server that does not name the snapshot (switch off) gives the old, non-unlockable answer.
  assert.deepEqual(await unlock.read({ id: "c1" }, async () => lockedWire()), { provider: "chatgpt", source: { status: "locked", unlockable: false } });
  const refused = await unlock.unlock("c1", "secret-password");
  assert.deepEqual(refused, { status: "unavailable" });
});

test("a correct password stores the grant in memory and the next read carries it to the account origin only", async () => {
  const { unlock, calls } = harness((call) => {
    if (call.url.pathname === verifyPath("ext1")) return unlockedResponse("ext1");
    if (call.url.pathname === "/api/conversations/c1/continuation") return Response.json(availableBody);
    return new Response(null, { status: 404 });
  });
  await unlock.read({ id: "c1" }, async () => lockedWire("ext1"));
  assert.deepEqual(await unlock.unlock("c1", "secret-password"), { status: "unlocked" });
  assert.equal(unlock.held(), 1);

  const verify = calls.find((call) => call.url.pathname === verifyPath("ext1"))!;
  assert.equal(verify.init?.method, "POST");
  assert.deepEqual(JSON.parse(String(verify.init?.body)), { password: "secret-password" });
  const verifyHeaders = new Headers(verify.init?.headers);
  assert.equal(verifyHeaders.get("cookie"), sessionCookie);
  assert.equal(verifyHeaders.get("origin"), origin);
  assert.equal(verifyHeaders.get("authorization"), null);

  let bearerReads = 0;
  const page = await unlock.read({ id: "c1" }, async () => { bearerReads += 1; return lockedWire("ext1"); });
  assert.equal(bearerReads, 0, "an unlocked original is read on the account session, not the bearer path");
  assert.deepEqual(page, chatImportedSource.parse(availableBody));
  const read = calls.find((call) => call.url.pathname === "/api/conversations/c1/continuation")!;
  assert.equal(read.url.search, "?offset=end&limit=50");
  const cookie = new Headers(read.init?.headers).get("cookie")!;
  assert.ok(cookie.startsWith(sessionCookie + "; tomverse_unlock_external_conversation_ext1="), cookie);
  assert.equal(new Headers(read.init?.headers).get("authorization"), null);

  // Every request went to the account origin; the grant never rode a settings-session call or another snapshot's read.
  for (const call of calls) assert.equal(call.url.origin, origin);
  const withGrant = calls.filter((call) => new Headers(call.init?.headers).get("cookie")?.includes("tomverse_unlock_"));
  assert.deepEqual(withGrant.map((call) => call.url.pathname), ["/api/conversations/c1/continuation"]);
  await unlock.read({ id: "c2" }, async () => lockedWire("ext2"));
  assert.equal(calls.filter((call) => new Headers(call.init?.headers).get("cookie")?.includes("tomverse_unlock_")).length, 1);
});

test("the password outcomes are told apart", async () => {
  const outcomes: Record<string, () => Response> = {
    wrong: () => Response.json({ success: false, error: "Invalid password." }, { status: 403 }),
    limited: () => Response.json({ success: false, code: "LOCK_RATE_LIMITED" }, { status: 429, headers: { "Retry-After": "120" } }),
    unavailable: () => Response.json({ error: "off" }, { status: 503 }),
    failed: () => Response.json({ error: "boom" }, { status: 500 }),
  };
  for (const [expected, make] of Object.entries(outcomes)) {
    const { unlock } = harness(() => make());
    await unlock.read({ id: "c1" }, async () => lockedWire("ext1"));
    const result = chatUnlockImportedResult.parse(await unlock.unlock("c1", "pw-123456"));
    assert.equal(result.status, expected);
    if (expected === "limited") assert.equal(result.retryAfterSeconds, 120);
    assert.equal(unlock.held(), 0);
  }
  // The settings session itself being off is "unavailable", not a wrong password.
  const calls: string[] = [];
  const account = new AbortController();
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", account.signal, async (input) => {
    calls.push(new URL(String(input)).pathname);
    return Response.json({ code: "NOT_AVAILABLE" }, { status: 503 });
  });
  const off = createImportedSourceUnlock({ settings, signal: account.signal });
  await off.read({ id: "c1" }, async () => lockedWire("ext1"));
  assert.deepEqual(await off.unlock("c1", "pw-123456"), { status: "unavailable" });
  assert.deepEqual(calls, ["/api/auth/desktop/settings-session"]);
});

test("a success without a valid grant cookie for this snapshot is not an unlock", async () => {
  const bad: Array<[string, () => Response]> = [
    ["no cookie", () => Response.json({ success: true })],
    ["another snapshot's cookie", () => unlockedResponse("ext9")],
    ["an expired grant", () => unlockedResponse("ext1", grantValue(-60))],
    ["a grant far beyond the server's lifetime", () => unlockedResponse("ext1", grantValue(48 * 3_600))],
    ["a malformed grant", () => unlockedResponse("ext1", "not-a-grant")],
  ];
  for (const [label, response] of bad) {
    const { unlock } = harness(() => response());
    await unlock.read({ id: "c1" }, async () => lockedWire("ext1"));
    assert.deepEqual(await unlock.unlock("c1", "pw-123456"), { status: "failed" }, label);
    assert.equal(unlock.held(), 0, label);
  }
});

test("a lock that was removed meanwhile reads normally, and a stale grant falls back to the original request", async () => {
  const removed = harness(() => Response.json({ success: false, error: "This conversation is not locked." }, { status: 400 }));
  await removed.unlock.read({ id: "c1" }, async () => lockedWire("ext1"));
  assert.deepEqual(await removed.unlock.unlock("c1", "pw-123456"), { status: "unlocked" });
  assert.equal(removed.unlock.held(), 0);

  const stale = harness((call) => call.url.pathname === verifyPath("ext1") ? unlockedResponse("ext1")
    : Response.json(lockedWire("ext1")));
  await stale.unlock.read({ id: "c1" }, async () => lockedWire("ext1"));
  await stale.unlock.unlock("c1", "pw-123456");
  assert.equal(stale.unlock.held(), 1);
  let bearerReads = 0;
  const page = await stale.unlock.read({ id: "c1" }, async () => { bearerReads += 1; return lockedWire("ext1"); });
  assert.equal(bearerReads, 1);
  assert.equal(page.source.status, "locked");
  assert.equal(stale.unlock.held(), 0, "a grant the server no longer honours is dropped");
});

test("signing out or switching account discards every grant", async () => {
  const { unlock, account } = harness((call) => call.url.pathname === verifyPath("ext1") ? unlockedResponse("ext1") : Response.json(availableBody));
  await unlock.read({ id: "c1" }, async () => lockedWire("ext1"));
  await unlock.unlock("c1", "pw-123456");
  assert.equal(unlock.held(), 1);
  account.abort();
  assert.equal(unlock.held(), 0);
  await assert.rejects(unlock.read({ id: "c1" }, async () => lockedWire("ext1")), { name: "AbortError" });
  await assert.rejects(unlock.unlock("c1", "pw-123456"), { name: "AbortError" });
});

test("the account session never leaves the account origin, whatever path a module builds", async () => {
  const { calls, settings } = harness(() => Response.json({}));
  await assert.rejects(settings.send({ path: "https://evil.example/api/conversations" }), /account origin/);
  await assert.rejects(settings.send({ path: "//evil.example/x" }), /account origin/);
  assert.equal(calls.some((call) => call.url.origin !== origin), false);
  // A grant cookie added by a caller follows the session cookie and cannot replace it.
  await settings.send({ path: "/api/ping" }, "application/json", undefined, { Cookie: "extra=1", "X-Test": "yes" });
  const sent = new Headers(calls.at(-1)!.init?.headers);
  assert.equal(sent.get("cookie"), sessionCookie + "; extra=1");
  assert.equal(sent.get("x-test"), "yes");
});

test("the unlock IPC takes only a conversation id and a bounded password", () => {
  assert.equal(chatUnlockImportedInput.safeParse({ id: "c1", password: "pw" }).success, true);
  assert.equal(chatUnlockImportedInput.safeParse({ id: "c1", password: "pw", externalConversationId: "ext1" }).success, false);
  assert.equal(chatUnlockImportedInput.safeParse({ id: "../x", password: "pw" }).success, false);
  assert.equal(chatUnlockImportedInput.safeParse({ id: "c1", password: "" }).success, false);
  assert.equal(chatUnlockImportedInput.safeParse({ id: "c1", password: "p".repeat(129) }).success, false);
  assert.equal(chatUnlockImportedResult.safeParse({ status: "unlocked", cookie: "x" }).success, false);
});

test("the main process routes the original read and the unlock through the same unlock object", () => {
  const main = readFileSync(new URL("../src/host/main.ts", import.meta.url), "utf8");
  assert.match(main, /connectedImportedUnlock\(\)\.read\(input, \(\) => withChatAccount\(\(api\) => api\.importedSource\(input\)\)\)/);
  assert.match(main, /main\("chat:unlock-imported-source"/);
  assert.match(main, /createImportedSourceUnlock\(\{ settings, signal \}\)/);
  const preload = readFileSync(new URL("../src/host/preload.ts", import.meta.url), "utf8");
  assert.match(preload, /"chat:unlock-imported-source"/);
  const renderer = readFileSync(new URL("../src/renderer/ImportedSourceUnlock.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(renderer, /useState<string>|setPassword|localStorage|sessionStorage/);
});
