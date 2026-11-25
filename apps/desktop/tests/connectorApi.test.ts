import test from "node:test";
import assert from "node:assert/strict";
import { createAccountSettingsApi } from "../src/host/account-settings-api";
import { createConnectorApi, type ConnectorOAuthEnd } from "../src/host/connector-api";
import type { ConnectorConnection, ConnectorInventory } from "../src/connector-contract";

const origin = "https://tomverse.example";
const sessionCookie = "fixture..account.settings.signature";
const state = "S".repeat(43);

const github = { id: "github", name: "GitHub", auth: "oauth" as const, origin: "https://api.githubcopilot.com", scopes: ["repo"], defaultScopes: ["repo"] };
function connection(overrides: Partial<ConnectorConnection> = {}): ConnectorConnection {
  return { id: "conn_1", serverId: "github", name: "GitHub", status: "connected", catalog: [{ name: "search", mode: "read" }], grants: [], version: 1, ...overrides };
}
const listing = (...connections: ConnectorConnection[]): ConnectorInventory =>
  ({ enabled: true, customEnabled: true, servers: [github], connections, invocations: [] });

type Call = { url: URL; init?: RequestInit };
/** A fake Tomverse: a connection list the test controls and the MCP routes the web page uses. */
function fixture(options: { start?: () => Response; callback?: (url: URL) => Response | Error; connectionAfterCallback?: ConnectorConnection;
  listing?: ConnectorInventory } = {}) {
  const calls: Call[] = [];
  let current = options.listing ?? listing();
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({ url, init });
    if (url.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: sessionCookie, expiresAt: Date.now() + 300_000 });
    if (url.pathname === "/api/mcp/connections" && (init?.method ?? "GET") === "GET") return Response.json(current);
    if (url.pathname === "/api/mcp/oauth/start") return options.start?.() ?? Response.json({ status: "authorization_required",
      authorizationUrl: "https://github.com/login/oauth/authorize?client_id=1&state=" + state });
    if (url.pathname === "/api/mcp/oauth/callback") {
      const outcome = options.callback?.(url) ?? new Response(null, { status: 303, headers: { Location: origin + "/plugins?oauth=connected" } });
      if (options.connectionAfterCallback) current = listing(options.connectionAfterCallback);
      if (outcome instanceof Error) throw outcome;
      return outcome;
    }
    if (url.pathname.startsWith("/api/mcp/")) return Response.json({ status: "saved" });
    throw new Error("Unexpected request " + url.pathname);
  };
  return { calls, transport };
}

function connector(transport: typeof fetch, authorize: (url: URL) => Promise<ConnectorOAuthEnd>, account = new AbortController()) {
  const settings = createAccountSettingsApi(origin, async () => "fixture-desktop", account.signal, transport);
  return createConnectorApi({ send: settings.send, authorize, signal: account.signal });
}
const neverOpened = async (): Promise<ConnectorOAuthEnd> => { throw new Error("The sign-in window must not open."); };

test("the connection list is read over the account session cookie and parsed", async () => {
  const { calls, transport } = fixture({ listing: listing(connection()) });
  const result = await connector(transport, neverOpened).inventory();
  assert.equal(result.connections[0].id, "conn_1");
  const [, read] = calls;
  assert.equal(read.url.href, origin + "/api/mcp/connections");
  const headers = new Headers(read.init?.headers);
  assert.equal(headers.get("cookie"), "__Secure-next-auth.session-token=" + sessionCookie);
  assert.equal(headers.get("authorization"), null);
  assert.equal(headers.get("origin"), origin);
});

test("a refused connect reports a typed failure without echoing the credential", async () => {
  const transport: typeof fetch = async (input) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/auth/desktop/settings-session") return Response.json({ token: sessionCookie, expiresAt: Date.now() + 300_000 });
    return Response.json({ code: "unsafe_address" }, { status: 400 });
  };
  const result = await connector(transport, neverOpened).run({ action: "connectCustom", custom: { url: "https://10.0.0.1/mcp", auth: "bearer" }, credential: "secret-token-value" });
  assert.deepEqual(result, { kind: "failed", code: "unsafe_address" });
  assert.equal(JSON.stringify(result).includes("secret-token-value"), false);
  const unknown = fixture({ start: () => Response.json({ code: "<b>boom</b>" }, { status: 502 }) });
  assert.deepEqual(await connector(unknown.transport, neverOpened).run({ action: "oauth", serverId: "github" }), { kind: "failed", code: "request_failed" });
});

test("approving an action reports whether the external service ran it", async () => {
  let reply: object = { status: "ok" };
  const transport: typeof fetch = async (input) => new URL(String(input)).pathname === "/api/auth/desktop/settings-session"
    ? Response.json({ token: sessionCookie, expiresAt: Date.now() + 300_000 }) : Response.json(reply);
  const api = connector(transport, neverOpened);
  assert.deepEqual(await api.run({ action: "decide", invocationId: "inv_1", approve: true }), { kind: "ok", executed: true });
  reply = { status: "approval_required" };
  assert.deepEqual(await api.run({ action: "decide", invocationId: "inv_1", approve: true }), { kind: "ok", executed: false });
  assert.deepEqual(await api.run({ action: "decide", invocationId: "inv_1", approve: false }), { kind: "ok" });
});

test("OAuth: the provider page opens in the app window and the callback is answered over the account session", async () => {
  const { calls, transport } = fixture({ connectionAfterCallback: connection() });
  const opened: URL[] = [];
  const api = connector(transport, async (url) => {
    opened.push(url);
    return { kind: "callback", state, code: "provider-code", issuer: "https://github.com/login/oauth" };
  });
  assert.deepEqual(await api.run({ action: "oauth", serverId: "github", scopes: ["repo"] }), { kind: "connected" });
  assert.deepEqual(opened.map(String), ["https://github.com/login/oauth/authorize?client_id=1&state=" + state]);
  const callback = calls.find(({ url }) => url.pathname === "/api/mcp/oauth/callback")!;
  assert.equal(callback.url.origin, origin);
  assert.equal(callback.url.searchParams.get("state"), state);
  assert.equal(callback.url.searchParams.get("code"), "provider-code");
  assert.equal(callback.url.searchParams.get("iss"), "https://github.com/login/oauth");
  assert.equal(new Headers(callback.init?.headers).get("cookie"), "__Secure-next-auth.session-token=" + sessionCookie);
  assert.deepEqual(JSON.parse(String(calls.find(({ url }) => url.pathname === "/api/mcp/oauth/start")?.init?.body)), { serverId: "github", scopes: ["repo"] });
});

test("the account cookie is sent only to the Tomverse origin, never toward a provider", async () => {
  const { calls, transport } = fixture({ connectionAfterCallback: connection() });
  const api = connector(transport, async () => ({ kind: "callback", state, code: "provider-code" }));
  await api.run({ action: "oauth", serverId: "github" });
  assert.ok(calls.length >= 4);
  for (const { url, init } of calls) {
    assert.equal(url.origin, origin, url.href);
    assert.equal(init?.redirect, "error");
    const headers = new Headers(init?.headers);
    if (url.pathname === "/api/auth/desktop/settings-session") assert.equal(headers.get("cookie"), null);
    else assert.equal(headers.get("cookie"), "__Secure-next-auth.session-token=" + sessionCookie);
  }
  assert.equal(calls.some(({ url }) => url.hostname === "github.com"), false);
});

test("OAuth success is decided by the connection list, not by the callback response", async () => {
  // The callback replies with a redirect the transport refuses; the connection exists afterwards.
  const redirected = fixture({ connectionAfterCallback: connection(), callback: () => new TypeError("fetch failed") });
  assert.deepEqual(await connector(redirected.transport, async () => ({ kind: "callback", state, code: "c" })).run({ action: "oauth", serverId: "github" }),
    { kind: "connected" });
  // The callback says everything is fine, but the server shows no connection: not connected.
  const hollow = fixture({ callback: () => Response.json({ connected: true }) });
  assert.deepEqual(await connector(hollow.transport, async () => ({ kind: "callback", state, code: "c" })).run({ action: "oauth", serverId: "github" }),
    { kind: "failed", code: "request_failed" });
  // An unchanged existing connection is not evidence of a new sign-in.
  const unchanged = fixture({ listing: listing(connection()), connectionAfterCallback: connection() });
  assert.deepEqual(await connector(unchanged.transport, async () => ({ kind: "callback", state, code: "c" })).run({ action: "oauth", serverId: "github" }),
    { kind: "failed", code: "request_failed" });
  // A re-sign-in that advanced the stored connection is.
  const advanced = fixture({ listing: listing(connection()), connectionAfterCallback: connection({ version: 2 }) });
  assert.deepEqual(await connector(advanced.transport, async () => ({ kind: "callback", state, code: "c" })).run({ action: "oauth", serverId: "github" }),
    { kind: "connected" });
});

test("closing the window or a provider refusal ends the sign-in without calling the callback", async () => {
  for (const end of [{ kind: "closed" }, { kind: "denied" }] as const) {
    const { calls, transport } = fixture();
    assert.deepEqual(await connector(transport, async () => end).run({ action: "oauth", serverId: "github" }), { kind: "cancelled" });
    assert.equal(calls.some(({ url }) => url.pathname === "/api/mcp/oauth/callback"), false);
  }
});

test("a provider that blocks embedded sign-in is reported and its page is never opened", async () => {
  const { transport } = fixture({ start: () => Response.json({ status: "authorization_required", authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=" + state }) });
  assert.deepEqual(await connector(transport, neverOpened).run({ action: "oauth", serverId: "google-drive" }), { kind: "unsupported", host: "accounts.google.com" });
  const unsafe = fixture({ start: () => Response.json({ status: "authorization_required", authorizationUrl: "http://127.0.0.1/authorize" }) });
  assert.deepEqual(await connector(unsafe.transport, neverOpened).run({ action: "oauth", serverId: "github" }), { kind: "failed", code: "request_failed" });
});

test("a stored connection that is still valid connects without opening a window", async () => {
  const { transport } = fixture({ start: () => Response.json({ status: "connected", connection: { id: "conn_1" } }) });
  assert.deepEqual(await connector(transport, neverOpened).run({ action: "oauth", serverId: "github" }), { kind: "connected" });
});

test("signing out of the account abandons an OAuth flow in progress", async () => {
  const { calls, transport } = fixture();
  const account = new AbortController();
  const api = connector(transport, async () => { account.abort(); return { kind: "closed" }; }, account);
  await assert.rejects(api.run({ action: "oauth", serverId: "github" }), { name: "AbortError" });
  assert.equal(calls.some(({ url }) => url.pathname === "/api/mcp/oauth/callback"), false);
});
