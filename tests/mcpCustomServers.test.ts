import assert from "node:assert/strict";
import test from "node:test";
import { isCustomMcpServerId, mcpCustomServersEnabled, mcpServers } from "@/lib/mcpConnectorPolicy";
import { assertPublicCustomMcpUrl, customMcpServerInputSchema, customMcpServerName, customMcpServerPolicy, discoverCustomOAuth,
  normalizeCustomMcpUrl } from "@/lib/mcpCustomServers";

test("custom servers are on with the preview by default and the kill switch turns them off", () => {
  assert.equal(mcpCustomServersEnabled({}), false);
  assert.equal(mcpCustomServersEnabled({ MCP_CONNECTOR_PREVIEW_ENABLED: "true" }), true);
  assert.equal(mcpCustomServersEnabled({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CUSTOM_SERVERS_DISABLED: "false" }), true);
  assert.equal(mcpCustomServersEnabled({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CUSTOM_SERVERS_DISABLED: "" }), true);
  for (const value of ["true", "1", "yes"]) assert.equal(mcpCustomServersEnabled({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CUSTOM_SERVERS_DISABLED: value }), false);
  assert.equal(mcpCustomServersEnabled({ MCP_CONNECTOR_PREVIEW_ENABLED: "false" }), false);
});

test("operator policies cannot claim the custom id namespace", () => {
  assert.equal(isCustomMcpServerId("custom-0123456789abcdef01234567"), true);
  assert.equal(isCustomMcpServerId("customer-portal"), false);
  assert.throws(() => mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "true",
    MCP_CONNECTOR_SERVERS: JSON.stringify([{ id: "custom-abc", name: "Spoof", url: "https://mcp.example.com/mcp" }]) }), { code: "invalid_server_policy" });
});

test("only public HTTPS URLs without credentials, query, fragment or private IP literals are accepted", () => {
  assert.equal(normalizeCustomMcpUrl(" https://mcp.example.com/mcp "), "https://mcp.example.com/mcp");
  assert.equal(normalizeCustomMcpUrl("https://mcp.example.com:443/v1/mcp"), "https://mcp.example.com/v1/mcp");
  for (const url of ["not a url", "http://mcp.example.com/mcp", "ftp://mcp.example.com/mcp", "https://mcp.example.com:8443/mcp",
    "https://user:pass@mcp.example.com/mcp", "https://mcp.example.com/mcp?token=x", "https://mcp.example.com/mcp#x",
    "https://127.0.0.1/mcp", "https://10.0.0.5/mcp", "https://192.168.1.2/mcp", "https://169.254.169.254/latest", "https://[::1]/mcp",
    "https://[fd00::1]/mcp", "https://100.64.0.1/mcp", "https://0.0.0.0/mcp"]) {
    assert.throws(() => normalizeCustomMcpUrl(url), (error: { code?: string }) => ["invalid_custom_url", "unsafe_endpoint"].includes(error.code || ""), url);
  }
  assert.equal(customMcpServerInputSchema.safeParse({ url: "https://mcp.example.com/mcp", auth: "oauth", extra: true }).success, false);
  assert.equal(customMcpServerInputSchema.safeParse({ url: "https://mcp.example.com/mcp", auth: "cookie" }).success, false);
});

test("a hostname that resolves to loopback is refused before anything is stored", async () => {
  await assert.rejects(() => assertPublicCustomMcpUrl("https://localhost/mcp", AbortSignal.timeout(5_000)), { code: "unsafe_address" });
});

test("a custom policy never pre-approves read tools and keeps a user's name out of control characters", () => {
  const policy = customMcpServerPolicy({ id: "custom-0123456789abcdef01234567", name: "Mine", url: "https://mcp.example.com/mcp", auth: "bearer", oauth: null });
  assert.deepEqual(policy.readTools, []);
  assert.equal(policy.auth, "bearer");
  assert.equal(customMcpServerName("  Team\u0000 tools\n ", "https://mcp.example.com/mcp"), "Team tools");
  assert.equal(customMcpServerName(undefined, "https://mcp.example.com/mcp"), "mcp.example.com");
  assert.equal(customMcpServerName("x".repeat(200), "https://mcp.example.com/mcp").length, 80);
});

const resource = { resource: "https://mcp.example.com/mcp", authorization_servers: ["https://auth.example.com"], scopes_supported: ["notes:read", "notes:write"] };
const metadata = { issuer: "https://auth.example.com", authorization_endpoint: "https://auth.example.com/authorize", token_endpoint: "https://auth.example.com/token",
  registration_endpoint: "https://auth.example.com/register", code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_post"] };
const fake = (documents: Record<string, unknown>) => {
  const requested: string[] = [];
  return { requested, getJson: async (url: string) => { requested.push(url); return documents[url] ?? null; } };
};

test("OAuth discovery follows protected-resource then server metadata and fixes the endpoints", async () => {
  const { requested, getJson } = fake({ "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": resource,
    "https://auth.example.com/.well-known/oauth-authorization-server": metadata });
  const oauth = await discoverCustomOAuth("https://mcp.example.com/mcp", AbortSignal.timeout(1_000), getJson);
  assert.deepEqual(oauth, { issuer: "https://auth.example.com", authorizationUrl: "https://auth.example.com/authorize", tokenUrl: "https://auth.example.com/token",
    registrationUrl: "https://auth.example.com/register", scope: "notes:read notes:write" });
  assert.deepEqual(requested, ["https://mcp.example.com/.well-known/oauth-protected-resource/mcp", "https://auth.example.com/.well-known/oauth-authorization-server"]);
  const policy = customMcpServerPolicy({ id: "custom-0123456789abcdef01234567", name: "Notes", url: "https://mcp.example.com/mcp", auth: "oauth", oauth });
  assert.equal(policy.oauth?.registrationUrl, "https://auth.example.com/register");

  const legacy = fake({ "https://mcp.example.com/.well-known/openid-configuration": { ...metadata, issuer: "https://mcp.example.com",
    authorization_endpoint: "https://mcp.example.com/authorize", token_endpoint: "https://mcp.example.com/token", registration_endpoint: "https://mcp.example.com/register",
    token_endpoint_auth_methods_supported: ["client_secret_basic"] } });
  const fallback = await discoverCustomOAuth("https://mcp.example.com/mcp", AbortSignal.timeout(1_000), legacy.getJson);
  assert.equal(fallback.tokenAuthMethod, "client_secret_basic");
  assert.equal(fallback.scope, "");
});

test("OAuth discovery refuses servers without registration, PKCE, a matching issuer or public endpoints", async () => {
  const run = (server: Record<string, unknown>, protectedResource: Record<string, unknown> = resource) => discoverCustomOAuth("https://mcp.example.com/mcp", AbortSignal.timeout(1_000),
    fake({ "https://mcp.example.com/.well-known/oauth-protected-resource/mcp": protectedResource, "https://auth.example.com/.well-known/oauth-authorization-server": server }).getJson);
  const withoutRegistration: Record<string, unknown> = { ...metadata };
  delete withoutRegistration.registration_endpoint;
  await assert.rejects(() => run(withoutRegistration), { code: "oauth_discovery_failed" });
  await assert.rejects(() => run({ ...metadata, code_challenge_methods_supported: ["plain"] }), { code: "oauth_discovery_failed" });
  const withoutPkce: Record<string, unknown> = { ...metadata };
  delete withoutPkce.code_challenge_methods_supported;
  await assert.rejects(() => run(withoutPkce), { code: "oauth_discovery_failed" });
  await assert.rejects(() => run(metadata, { ...resource, resource: "https://mcp.example.com/other" }), { code: "oauth_discovery_failed" });
  await assert.rejects(() => run(metadata, { ...resource, resource: "https://mcp.example.com/mc" }), { code: "oauth_discovery_failed" });
  assert.equal((await run(metadata, { ...resource, resource: "https://mcp.example.com/" })).issuer, "https://auth.example.com");
  await assert.rejects(() => run({ ...metadata, issuer: "https://other.example.com" }), { code: "oauth_discovery_failed" });
  await assert.rejects(() => run({ ...metadata, token_endpoint_auth_methods_supported: ["private_key_jwt"] }), { code: "oauth_discovery_failed" });
  await assert.rejects(() => run({ ...metadata, token_endpoint: "https://10.0.0.8/token" }), { code: "unsafe_endpoint" });
  await assert.rejects(() => run({ ...metadata, token_endpoint: "http://auth.example.com/token" }), { code: "unsafe_endpoint" });
  await assert.rejects(() => run(metadata, { ...resource, resource: "https://elsewhere.example.com/mcp" }), { code: "oauth_discovery_failed" });
  await assert.rejects(() => discoverCustomOAuth("https://mcp.example.com/mcp", AbortSignal.timeout(1_000), fake({}).getJson), { code: "oauth_discovery_failed" });
});
