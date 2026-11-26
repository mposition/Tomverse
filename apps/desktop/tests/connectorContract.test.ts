import test from "node:test";
import assert from "node:assert/strict";
import { SUPPORTED_LANGUAGES } from "../../../lib/language";
import { mcpConnectorCopy } from "../../../lib/mcpConnectorCopy";
import { desktopConnectorCopy } from "../../../locales/desktopConnectors";
import {
  CONNECTOR_FAILURE_CODES, connectorFailureCode, connectorFailureKey, connectorInput, connectorInventory, connectorRequest, connectorResult,
} from "../src/connector-contract";
import { describeConnectorResult } from "../src/renderer/connector-message";

test("the connector IPC accepts typed actions only and never a path or an unrelated field", () => {
  assert.equal(connectorInput.safeParse({ action: "disconnect", connectionId: "conn_1", path: "/api/user/account" }).success, false);
  assert.equal(connectorInput.safeParse({ action: "disconnect", connectionId: "../users" }).success, false);
  assert.equal(connectorInput.safeParse({ action: "inventory" }).success, false);
  assert.equal(connectorInput.safeParse({ action: "oauthCustom", custom: { url: "https://mcp.example.com/mcp", auth: "bearer" } }).success, false);
  assert.equal(connectorInput.safeParse({ action: "oauth", serverId: "github", scopes: [] }).success, false);
  assert.equal(connectorInput.safeParse({ action: "saveTools", connectionId: "conn_1", tools: ["search"], version: 0 }).success, false);
  assert.equal(connectorInput.safeParse({ action: "decide", invocationId: "inv_1", approve: "yes" }).success, false);
  assert.equal(connectorInput.safeParse({ action: "connect", serverId: "github", credential: "x".repeat(4_097) }).success, false);
  const custom = connectorInput.parse({ action: "connectCustom", custom: { url: " https://mcp.example.com/mcp ", name: "  Team  ", auth: "none" } });
  assert.deepEqual(custom.action === "connectCustom" && custom.custom, { url: "https://mcp.example.com/mcp", name: "Team", auth: "none" });
});

test("every connector action maps to the web Plugins page route and body", () => {
  assert.deepEqual(connectorRequest({ action: "inventory" }), { path: "/api/mcp/connections", method: "GET" });
  assert.deepEqual(connectorRequest({ action: "connect", serverId: "railway", credential: "secret-token" }), {
    path: "/api/mcp/connections", method: "POST", body: { serverId: "railway", credential: "secret-token" } });
  assert.deepEqual(connectorRequest({ action: "connect", serverId: "linear" }).body, { serverId: "linear" });
  assert.deepEqual(connectorRequest({ action: "connectCustom", custom: { url: "https://mcp.example.com/mcp", auth: "bearer", name: "Team" }, credential: "t" }), {
    path: "/api/mcp/connections", method: "POST",
    body: { custom: { url: "https://mcp.example.com/mcp", auth: "bearer", name: "Team" }, credential: "t" } });
  assert.deepEqual(connectorRequest({ action: "oauth", serverId: "github", scopes: ["repo", "read:org"] }), {
    path: "/api/mcp/oauth/start", method: "POST", body: { serverId: "github", scopes: ["repo", "read:org"] } });
  assert.deepEqual(connectorRequest({ action: "oauth", serverId: "slack" }).body, { serverId: "slack" });
  assert.deepEqual(connectorRequest({ action: "oauthCustom", custom: { url: "https://mcp.example.com/mcp", auth: "oauth" } }), {
    path: "/api/mcp/oauth/start", method: "POST", body: { custom: { url: "https://mcp.example.com/mcp", auth: "oauth" } } });
  assert.deepEqual(connectorRequest({ action: "saveTools", connectionId: "conn_1", tools: ["search"], version: 3 }), {
    path: "/api/mcp/connections/conn_1", method: "PATCH", body: { tools: ["search"], version: 3 } });
  assert.deepEqual(connectorRequest({ action: "disconnect", connectionId: "conn_1" }), { path: "/api/mcp/connections/conn_1", method: "DELETE" });
  assert.deepEqual(connectorRequest({ action: "decide", invocationId: "inv_1", approve: true }), {
    path: "/api/mcp/invocations/inv_1", method: "POST", body: { approve: true } });
  assert.deepEqual(connectorRequest({ action: "confirmOutcome", invocationId: "inv_1", verifiedOutcome: "not_executed" }), {
    path: "/api/mcp/invocations/inv_1", method: "POST", body: { verifiedOutcome: "not_executed" } });
});

test("the inventory parser accepts the web response and drops what Desktop does not use", () => {
  const parsed = connectorInventory.parse({
    enabled: true, customEnabled: true,
    servers: [{ id: "github", name: "GitHub", auth: "oauth", origin: "https://api.githubcopilot.com", scopes: ["repo"], defaultScopes: ["repo"] },
      { id: "custom-ab12", name: "Team", auth: "bearer", origin: "https://mcp.example.com", custom: true }],
    connections: [{ id: "conn_1", serverId: "github", name: "GitHub", status: "connected", version: 2, createdAt: "2026-11-25T00:00:00.000Z",
      catalog: [{ name: "search_issues", mode: "read", inputSchema: { type: "object" } }], grants: [{ name: "search_issues", mode: "read", inputSchema: {} }] }],
    invocations: [{ id: "inv_1", connectionId: "conn_1", toolName: "create_issue", state: "pending", arguments: { title: "x" }, expiresAt: "2026-11-25T00:10:00.000Z" }],
  });
  assert.equal("inputSchema" in parsed.connections[0].catalog[0], false);
  assert.equal("createdAt" in parsed.connections[0], false);
  assert.equal(connectorInventory.safeParse({ enabled: false, customEnabled: false, servers: [], connections: [], invocations: [] }).success, true);
  assert.equal(connectorInventory.safeParse({ enabled: true, servers: [{ id: "BAD ID", name: "x", auth: "oauth", origin: "" }], connections: [], invocations: [] }).success, false);
});

test("failure codes keep the web page's wording and unknown codes become a generic failure", () => {
  assert.equal(connectorFailureCode("custom_server_limit"), "custom_server_limit");
  assert.equal(connectorFailureCode("<script>alert(1)</script>"), "request_failed");
  assert.equal(connectorFailureCode(undefined), "request_failed");
  assert.equal(connectorFailureKey("outcome_unknown"), "unknown");
  assert.equal(connectorFailureKey("previous_outcome_unknown"), "unknown");
  for (const code of ["invalid_custom_url", "unsafe_endpoint", "unsafe_address"] as const) assert.equal(connectorFailureKey(code), "customUrlRefused");
  assert.equal(connectorFailureKey("oauth_discovery_failed"), "customOAuthUnsupported");
  assert.equal(connectorFailureKey("oauth_flow_expired"), "expired");
  assert.equal(connectorFailureKey("connector_disabled"), "serverSetup");
  assert.equal(connectorFailureKey("request_failed"), "error");
  for (const code of CONNECTOR_FAILURE_CODES) assert.equal(connectorResult.safeParse({ kind: "failed", code }).success, true);
});

test("every supported language words each connector result", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = desktopConnectorCopy[language];
    for (const key of Object.keys(desktopConnectorCopy.en) as Array<keyof typeof copy>) assert.ok(copy[key].length > 0, `${language}.${key}`);
    assert.match(copy.windowTitle, /\{host\}/);
    assert.match(copy.oauthUnsupportedHost, /\{host\}/);
    assert.match(copy.toolsAllowed, /\{granted\}.*\{total\}/);
    assert.equal(describeConnectorResult({ kind: "connected" }, language)?.text, mcpConnectorCopy[language].connected);
    assert.equal(describeConnectorResult({ kind: "failed", code: "custom_server_limit" }, language)?.text, mcpConnectorCopy[language].customLimit);
    assert.equal(describeConnectorResult({ kind: "unsupported", host: "accounts.google.com" }, language)?.text.includes("accounts.google.com"), true);
    assert.equal(describeConnectorResult({ kind: "cancelled" }, language)?.tone, "status");
    assert.equal(describeConnectorResult(undefined, language)?.text, mcpConnectorCopy[language].error);
    assert.equal(describeConnectorResult({ kind: "ok" }, language), undefined);
    assert.equal(describeConnectorResult({ kind: "ok", executed: true }, language)?.text, mcpConnectorCopy[language].executed);
  }
});
