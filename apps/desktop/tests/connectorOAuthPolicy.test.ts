import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyOAuthNavigation, connectionEstablished, embeddedOAuthRefused, oauthCallbackPath, oauthStartTarget, serverSignInRefused,
} from "../src/connector-oauth-policy";
import type { ConnectorConnection, ConnectorInventory } from "../src/connector-contract";

const account = "https://tomverse.example";
const state = "A".repeat(43);

test("Google sign-in is reported as unavailable instead of being opened or redirected", () => {
  for (const host of ["accounts.google.com", "ACCOUNTS.GOOGLE.COM.", "oauth2.googleapis.com", "drivemcp.googleapis.com"]) {
    assert.equal(embeddedOAuthRefused(host), true, host);
  }
  for (const host of ["github.com", "notgoogle.com", "google.com.evil.example", "slack.com"]) assert.equal(embeddedOAuthRefused(host), false, host);
  assert.equal(serverSignInRefused("https://drivemcp.googleapis.com"), "drivemcp.googleapis.com");
  assert.equal(serverSignInRefused("https://mcp.linear.app"), null);
  assert.equal(serverSignInRefused("not a url"), null);
  assert.deepEqual(oauthStartTarget("https://accounts.google.com/o/oauth2/v2/auth?client_id=1"), { ok: false, kind: "unsupported", host: "accounts.google.com" });
});

test("only an https provider page on a public-looking name opens in the sign-in window", () => {
  const ok = oauthStartTarget("https://github.com/login/oauth/authorize?client_id=1&state=" + state);
  assert.equal(ok.ok && ok.url.host, "github.com");
  for (const value of ["http://github.com/login", "https://user:pass@github.com/login", "https://127.0.0.1/login", "https://localhost/login",
    "https://[::1]/login", "https://10.0.0.5/login", "https://intranet/login", "javascript:alert(1)", "file:///C:/x", "tomverse://desktop", ""]) {
    assert.deepEqual(oauthStartTarget(value), { ok: false, kind: "invalid" }, value);
  }
});

test("the Tomverse callback is recognised by origin, path and parameter shape", () => {
  const callback = `${account}/api/mcp/oauth/callback?state=${state}&code=abc123&iss=${encodeURIComponent("https://github.com/login/oauth")}`;
  const parsed = classifyOAuthNavigation(callback, account);
  assert.deepEqual(parsed, { kind: "callback", state, code: "abc123", issuer: "https://github.com/login/oauth" });
  assert.equal(parsed.kind === "callback" && oauthCallbackPath(parsed),
    `/api/mcp/oauth/callback?state=${state}&code=abc123&iss=${encodeURIComponent("https://github.com/login/oauth")}`);
  assert.deepEqual(classifyOAuthNavigation(`${account}/api/mcp/oauth/callback?state=${state}&code=x`, account), { kind: "callback", state, code: "x" });
  // A provider that refuses, or a malformed return, ends the sign-in without calling Tomverse.
  assert.deepEqual(classifyOAuthNavigation(`${account}/api/mcp/oauth/callback?error=access_denied&state=${state}`, account), { kind: "denied" });
  assert.deepEqual(classifyOAuthNavigation(`${account}/api/mcp/oauth/callback?state=short&code=x`, account), { kind: "denied" });
  assert.deepEqual(classifyOAuthNavigation(`${account}/api/mcp/oauth/callback?state=${state}`, account), { kind: "denied" });
  assert.deepEqual(classifyOAuthNavigation(`${account}/api/mcp/oauth/callback?state=${state}&code=${"c".repeat(4_097)}`, account), { kind: "denied" });
});

test("the window's navigation rule refuses a Tomverse page, an insecure page and a local name or address literal", () => {
  for (const value of [`${account}/plugins?oauth=connected`, `${account}/api/auth/session`, `${account}/api/mcp/connections`,
    `${account}/api/mcp/oauth/callback/../session?state=${state}&code=x`, `${account}/`, "http://github.com/login", "https://127.0.0.1:3000/x",
    "https://localhost/x", "https://user:pw@github.com/x", "data:text/html,hi", "about:blank", "not a url"]) {
    assert.equal(classifyOAuthNavigation(value, account).kind, "block", value);
  }
  // The same path on another host is an ordinary provider page, not a callback to answer.
  assert.equal(classifyOAuthNavigation(`https://provider.org/api/mcp/oauth/callback?state=${state}&code=x`, account).kind, "allow");
  assert.equal(classifyOAuthNavigation("https://github.com/login/oauth/authorize", account).kind, "allow");
  assert.equal(classifyOAuthNavigation("https://login.microsoftonline.com/common/oauth2/v2.0/authorize", account).kind, "allow");
});

function connection(overrides: Partial<ConnectorConnection>): ConnectorConnection {
  return { id: "conn_1", serverId: "github", name: "GitHub", status: "connected", catalog: [], grants: [], version: 1, ...overrides };
}
const inventory = (...connections: ConnectorConnection[]): ConnectorInventory =>
  ({ enabled: true, servers: [], connections, invocations: [] });

test("a connection counts as made only when the server's list shows a new or advanced connected row", () => {
  assert.equal(connectionEstablished(inventory(), inventory(connection({})), "github"), true);
  assert.equal(connectionEstablished(null, inventory(connection({})), "github"), true);
  assert.equal(connectionEstablished(inventory(connection({})), inventory(connection({ version: 2 })), "github"), true);
  assert.equal(connectionEstablished(inventory(connection({ status: "disconnected" })), inventory(connection({ version: 2 })), "github"), true);
  assert.equal(connectionEstablished(inventory(connection({})), inventory(connection({})), "github"), false);
  assert.equal(connectionEstablished(inventory(), inventory(connection({ status: "unavailable" })), "github"), false);
  assert.equal(connectionEstablished(inventory(), inventory(connection({ serverId: "slack" })), "github"), false);
  assert.equal(connectionEstablished(inventory(), inventory(connection({ id: "conn_2", serverId: "custom-ab12" }))), true);
  assert.equal(connectionEstablished(inventory(connection({})), inventory(connection({})), undefined), false);
});
