import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { request as httpRequest } from "node:http";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { createAccountDataApi } from "../src/host/account-data-api";
import { desktopAccountDataInput } from "../src/account-data-contract";
import { linkLoginMethodThroughBrowser } from "../src/host/login-method-link";

const origin = "https://tomverse.example";
const linkState = "dl1." + "s".repeat(120) + "." + "g".repeat(43);
const providerPage = "https://accounts.google.com/o/oauth2/v2/auth?client_id=fixture&state=" + linkState;

type Seen = { path: string; method?: string; body: Record<string, string> };

/** A browser that follows the provider page and returns to the loopback address the app announced. */
function fixture(options: { start?: () => Response; complete?: () => Response; provider?: string; providers?: string[] } = {}) {
  const seen: Seen[] = [];
  let redirect = "";
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: "fixture..account.settings.signature", expiresAt: Date.now() + 300_000 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    seen.push({ path: url.pathname, method: init?.method, body });
    if (url.pathname.endsWith("/desktop/start")) {
      redirect = body.redirectUri;
      return options.start?.() ?? Response.json({ ok: true, url: options.provider ?? providerPage, linkState });
    }
    return options.complete?.() ?? Response.json({ ok: true, provider: "google" });
  };
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", new AbortController().signal, transport);
  const opened: string[] = [];
  let browser: (url: string) => Promise<void> | void = () => {};
  const session = new AbortController();
  const api = createAccountDataApi({
    settings, save: async () => false, afterAccountDeleted: async () => {}, language: () => "en",
    openExternal: async (url) => { opened.push(url); await browser(url); },
    linkProviders: () => options.providers ?? ["google", "azure-ad"], signal: session.signal,
  });
  const returnToApp = (query: Record<string, string>, host?: string) => {
    const target = new URL(redirect);
    for (const [name, value] of Object.entries(query)) target.searchParams.set(name, value);
    // fetch ignores a Host header; a request with another Host is made at the socket.
    return host ? new Promise<{ status: number }>((resolve, reject) => {
      httpRequest(target, { headers: { host } }, (response) => { response.resume(); resolve({ status: response.statusCode ?? 0 }); })
        .on("error", reject).end();
    }) : fetch(target);
  };
  return { api, seen, opened, session, returnToApp, onBrowser: (handler: typeof browser) => { browser = handler; }, loopback: () => redirect };
}

test("the provider opens in the system browser, and the code and the Desktop verifier complete the link", async () => {
  const { api, seen, opened, returnToApp, onBrowser, loopback } = fixture();
  onBrowser(async () => { assert.equal((await returnToApp({ state: linkState, code: "provider-code" })).status, 200); });
  assert.deepEqual(await api.handle({ action: "linkLoginMethod", method: "google" }), { status: "saved" });

  assert.deepEqual(opened, [providerPage]);
  assert.match(loopback(), /^http:\/\/127\.0\.0\.1:\d{4,5}\/desktop-login\/callback$/);
  const [start, complete] = seen;
  assert.equal(start.path, "/api/user/login-methods/oauth/desktop/start");
  assert.deepEqual(Object.keys(start.body).sort(), ["codeChallenge", "provider", "redirectUri"]);
  assert.equal(start.body.provider, "google");
  assert.equal(complete.path, "/api/user/login-methods/oauth/desktop/complete");
  assert.deepEqual(Object.keys(complete.body).sort(), ["code", "codeVerifier", "linkState"]);
  assert.equal(complete.body.code, "provider-code");
  assert.equal(complete.body.linkState, linkState);
  // The verifier that was sent last is the one behind the challenge sent first, and it was never in a URL.
  assert.equal(createHash("sha256").update(complete.body.codeVerifier).digest("base64url"), start.body.codeChallenge);
  assert.ok(!opened.join().includes(complete.body.codeVerifier));
});

test("declining at the provider is a cancellation and links nothing", async () => {
  const { api, seen, returnToApp, onBrowser } = fixture();
  onBrowser(async () => { await returnToApp({ state: linkState, error: "access_denied" }); });
  assert.deepEqual(await api.handle({ action: "linkLoginMethod", method: "google" }), { status: "cancelled" });
  assert.equal(seen.length, 1, "only the start was sent");
});

test("a return with another state, extra values, or the wrong host is refused and the wait goes on", async () => {
  const { api, seen, returnToApp, onBrowser } = fixture();
  const statuses: number[] = [];
  let browser: Promise<void> = Promise.resolve();
  onBrowser(() => {
    // Collected rather than asserted inside: the flow ends at the genuine return and would hide a later throw.
    browser = (async () => {
      for (const [query, host] of [
        [{ state: "dl1." + "x".repeat(linkState.length - 4), code: "attacker" }],
        // Same number of characters, different number of bytes: a byte comparison that throws would end the app.
        [{ state: "é".repeat(linkState.length), code: "attacker" }], [{ state: linkState, code: "c", extra: "1" }],
        [{ state: linkState }], [{ state: linkState, code: "c", error: "access_denied" }],
        [{ state: linkState, code: "c" }, "evil.example"], [{ state: linkState, code: "genuine" }],
      ] as const) statuses.push((await returnToApp(query, host)).status);
    })();
  });
  assert.deepEqual(await api.handle({ action: "linkLoginMethod", method: "google" }), { status: "saved" });
  await browser;
  // Refused: another state, an extra value, no answer, two answers, another host. Then the genuine one.
  assert.deepEqual(statuses, [400, 400, 400, 400, 400, 404, 200]);
  assert.equal(seen.length, 2);
  assert.equal(seen[1].body.code, "genuine");
});

test("the browser is sent only to the provider's own https page, whatever the server answers", async () => {
  for (const provider of [
    "https://evil.example/o/oauth2/v2/auth", "http://accounts.google.com/o/oauth2/v2/auth",
    "https://accounts.google.com.evil.example/auth", "https://user:pass@accounts.google.com/auth",
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize", "javascript:alert(1)",
  ]) {
    const { api, opened } = fixture({ provider });
    assert.deepEqual(await api.handle({ action: "linkLoginMethod", method: "google" }), { status: "failed" }, provider);
    assert.deepEqual(opened, []);
  }
  const microsoft = fixture({ provider: "https://login.microsoftonline.com/tenant/oauth2/v2.0/authorize?x=1" });
  microsoft.onBrowser(async () => { await microsoft.returnToApp({ state: linkState, code: "c" }); });
  assert.deepEqual(await microsoft.api.handle({ action: "linkLoginMethod", method: "azure-ad" }), { status: "saved" });
});

test("a state that is not the server's shape is not trusted", async () => {
  const { api, opened } = fixture({ start: () => Response.json({ ok: true, url: providerPage, linkState: "not-a-state" }) });
  assert.deepEqual(await api.handle({ action: "linkLoginMethod", method: "google" }), { status: "failed" });
  assert.deepEqual(opened, []);
});

test("the server's refusals reach the person as they do for other account actions", async () => {
  const recent = fixture({ start: () => Response.json({ code: "ACCOUNT_REAUTHENTICATION_REQUIRED" }, { status: 428 }) });
  assert.deepEqual(await recent.api.handle({ action: "linkLoginMethod", method: "google" }), { status: "reauth", code: "ACCOUNT_REAUTHENTICATION_REQUIRED" });
  assert.deepEqual(recent.opened, []);

  const off = fixture({ start: () => Response.json({ ok: false, code: "NOT_AVAILABLE" }, { status: 503 }) });
  assert.deepEqual(await off.api.handle({ action: "linkLoginMethod", method: "google" }), { status: "unavailable", code: "NOT_AVAILABLE" });

  const taken = fixture({ complete: () => Response.json({ code: "ALREADY_LINKED_ELSEWHERE" }, { status: 400 }) });
  taken.onBrowser(async () => { await taken.returnToApp({ state: linkState, code: "c" }); });
  assert.deepEqual(await taken.api.handle({ action: "linkLoginMethod", method: "google" }), { status: "failed", code: "ALREADY_LINKED_ELSEWHERE" });
});

test("a provider the server did not offer is never started", async () => {
  const { api, seen, opened } = fixture({ providers: ["azure-ad"] });
  assert.deepEqual(await api.handle({ action: "linkLoginMethod", method: "google" }), { status: "unavailable" });
  const none = fixture({ providers: [] });
  assert.deepEqual(await none.api.handle({ action: "linkLoginMethod", method: "azure-ad" }), { status: "unavailable" });
  assert.deepEqual([seen, opened, none.seen, none.opened], [[], [], [], []]);
});

test("cancel ends the wait and the loopback address stops listening", async () => {
  const { api, loopback, onBrowser } = fixture();
  let announced!: () => void;
  const waiting = new Promise<void>((resolve) => { announced = resolve; });
  onBrowser(() => announced());
  const linking = api.handle({ action: "linkLoginMethod", method: "google" });
  await waiting;
  // One flow at a time.
  assert.deepEqual(await api.handle({ action: "linkLoginMethod", method: "google" }), { status: "failed" });
  assert.deepEqual(await api.handle({ action: "cancelLinkLoginMethod" }), { status: "cancelled" });
  assert.deepEqual(await linking, { status: "cancelled" });
  await assert.rejects(fetch(loopback() + "?state=" + linkState + "&code=late"));
  // A cancel with nothing to cancel is harmless, and the next attempt starts fresh.
  assert.deepEqual(await api.handle({ action: "cancelLinkLoginMethod" }), { status: "cancelled" });
});

test("ending the account session ends the wait, and an unanswered wait expires", async () => {
  const ended = fixture();
  let announced!: () => void;
  const waiting = new Promise<void>((resolve) => { announced = resolve; });
  ended.onBrowser(() => announced());
  const linking = ended.api.handle({ action: "linkLoginMethod", method: "google" });
  await waiting;
  ended.session.abort();
  assert.deepEqual(await linking, { status: "cancelled" });

  const calls: string[] = [];
  const result = await linkLoginMethodThroughBrowser({
    call: async (request) => { calls.push(request.path); return Response.json({ ok: true, url: providerPage, linkState }); },
    openExternal: async () => {}, provider: "google", signal: new AbortController().signal, timeoutMs: 50,
  });
  assert.deepEqual(result, { status: "expired" });
  assert.deepEqual(calls, ["/api/user/login-methods/oauth/desktop/start"]);
});

test("only the two providers can be linked and cancel carries nothing", () => {
  assert.equal(desktopAccountDataInput.safeParse({ action: "linkLoginMethod", method: "google" }).success, true);
  assert.equal(desktopAccountDataInput.safeParse({ action: "linkLoginMethod", method: "azure-ad" }).success, true);
  for (const bad of [{ action: "linkLoginMethod", method: "email" }, { action: "linkLoginMethod", method: "apple" },
    { action: "linkLoginMethod", method: "google", url: "https://evil.example" }, { action: "cancelLinkLoginMethod", method: "google" }]) {
    assert.equal(desktopAccountDataInput.safeParse(bad).success, false, JSON.stringify(bad));
  }
});

test("a cancel that arrives while the server is answering never opens the provider page", async () => {
  const cancel = new AbortController();
  const opened: string[] = [];
  const result = await linkLoginMethodThroughBrowser({
    call: async () => { cancel.abort(); return Response.json({ ok: true, url: providerPage, linkState }); },
    openExternal: async (url) => { opened.push(url); }, provider: "google", signal: cancel.signal,
  });
  assert.deepEqual(result, { status: "cancelled" });
  assert.deepEqual(opened, []);
});
