import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { MCP_PROVIDERS } from "@/lib/mcpProviderCatalog";
import { MCP_PROVIDER_PRESETS, providerEnvironmentPrefix } from "@/lib/mcpProviderPresets";
import { mcpServers } from "@/lib/mcpConnectorPolicy";
import { validateMcpEndpoint } from "@/lib/mcpConnectorClient";

test("catalog entries never grant connections and disabled preview ignores preset configuration", () => {
  assert.ok(MCP_PROVIDERS.length > 100);
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "false", MCP_CONNECTOR_PROVIDERS: "notion,unknown" }), []);
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "true" }), []);
  assert.throws(() => mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: "notion,notion" }));
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: "unregistered,linear" }).map(s => s.id), ["linear"]);
});

test("catalog assets stay local, provenance stays public, and unavailable brands use a fallback", () => {
  const provenance = JSON.parse(readFileSync("public/plugins/providers/sources.json", "utf8")) as { assets: Array<{ provider: string; path: string; source: string }> };
  for (const provider of MCP_PROVIDERS) {
    assert.equal(new URL(provider.docs).protocol, "https:");
    if (!provider.logo) continue;
    assert.match(provider.logo, /^\/plugins\/providers\/[a-z0-9-]+\.(png|svg|jpg|webp)$/);
    assert.ok(readFileSync(`public${provider.logo}`).length);
    const asset = provenance.assets.find(asset => asset.provider === provider.id);
    assert.equal(asset?.path, provider.logo);
    assert.ok(["raw.githubusercontent.com", "avatars.githubusercontent.com"].includes(new URL(asset!.source).hostname));
  }
});

test("known OAuth providers use pinned endpoints, explicit scopes and confirmation-only tools", () => {
  const servers = mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: "notion,linear,railway,figma" });
  assert.equal(servers.length, 4);
  for (const server of servers) {
    assert.equal(server.auth, "oauth"); assert.ok(server.oauth?.registrationUrl); assert.deepEqual(server.readTools, []);
    assert.doesNotThrow(() => validateMcpEndpoint(server));
  }
  assert.equal(servers.find(s => s.id === "notion")!.oauth!.scope, "default");
  assert.equal(servers.find(s => s.id === "figma")!.oauth!.scope, "mcp:connect");
});

test("static app setup and unspecified scope requirements remain closed", () => {
  const env = { MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: "asana,slack,zoom" };
  assert.deepEqual(mcpServers(env), []);
  const configured = mcpServers({ ...env, MCP_CONNECTOR_PROVIDERS: "zoom", MCP_PROVIDER_ZOOM_CLIENT_ID: "synthetic-client",
    MCP_PROVIDER_ZOOM_CLIENT_SECRET: "synthetic-client-secret", MCP_PROVIDER_ZOOM_TOKEN_SCOPE: "user:read" });
  assert.equal(configured.length, 1); assert.equal(configured[0].oauth?.tokenAuthMethod, "client_secret_basic");
  assert.equal(JSON.stringify(configured).includes("synthetic-client-secret"), false);
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: "notion,linear", MCP_PROVIDER_NOTION_SCOPE: "admin" }).map(s => s.id), ["linear"]);
  assert.deepEqual(mcpServers({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: "github" }), []);
});

test("every prepared profile validates as fixed HTTPS destinations using synthetic operator settings", () => {
  for (const profile of MCP_PROVIDER_PRESETS.filter(p => p.auth === "oauth" || p.auth === "none")) {
    const prefix = providerEnvironmentPrefix(profile.id);
    const env: Record<string, string> = { MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: profile.id,
      [`${prefix}_CLIENT_ID`]: "synthetic-client", [`${prefix}_CLIENT_SECRET`]: "synthetic-client-secret" };
    if ("oauth" in profile && profile.oauth?.scopeRequired) env[`${prefix}_SCOPE`] = profile.oauth.allowedScopes[0];
    if ("oauth" in profile && !profile.oauth?.scope && !env[`${prefix}_SCOPE`]) env[`${prefix}_TOKEN_SCOPE`] = profile.oauth?.allowedScopes[0] ?? "synthetic-provider-scope";
    const [server] = mcpServers(env);
    assert.ok(server, profile.id);
    assert.doesNotThrow(() => validateMcpEndpoint(server), profile.id);
    if (server.oauth) for (const url of [server.oauth.issuer, server.oauth.authorizationUrl, server.oauth.tokenUrl, ...(server.oauth.registrationUrl ? [server.oauth.registrationUrl] : [])])
      assert.doesNotThrow(() => validateMcpEndpoint({ ...server, url }, true), profile.id);
  }
});

test("provider defaults require an explicit token scope bound without guessing broad consent", () => {
  const base = { MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: "atlassian,dropbox" };
  assert.deepEqual(mcpServers(base), []);
  const [server] = mcpServers({ ...base, MCP_PROVIDER_ATLASSIAN_TOKEN_SCOPE: "documents:read" });
  assert.equal(server.id, "atlassian"); assert.equal(server.oauth?.scope, "");
  assert.equal(server.oauth?.tokenScope, "documents:read");
  assert.deepEqual(mcpServers({ ...base, MCP_PROVIDER_DROPBOX_TOKEN_SCOPE: "unadvertised:admin" }), []);
  assert.equal(mcpServers({ ...base, MCP_PROVIDER_ATLASSIAN_TOKEN_SCOPE: "" }).length, 1);
});
