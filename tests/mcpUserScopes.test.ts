import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { MCP_PROVIDER_PRESETS } from "@/lib/mcpProviderPresets";
import { MCP_SCOPE_LIMITS, mcpScopedServer, mcpServerSchema, mcpServers } from "@/lib/mcpConnectorPolicy";
import { mcpPolicyDigest } from "@/lib/mcpConnectorStore";

const env = (providers: string, extra: Record<string, string> = {}) => ({ MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_PROVIDERS: providers, ...extra });
const preset = (id: string) => MCP_PROVIDER_PRESETS.find(profile => profile.id === id)!;

test("published scope lists make providers connectable without an operator scope", () => {
  const [supabase] = mcpServers(env("supabase"));
  assert.equal(supabase.id, "supabase"); assert.equal(supabase.oauth?.scope, "");
  assert.deepEqual(supabase.oauth?.selectableScopes, preset("supabase").oauth!.allowedScopes);
  // Providers without a published list stay closed ("server configuration required").
  assert.deepEqual(mcpServers(env("atlassian,canva,monday")), []);
  // The largest published list still validates as policy.
  const [cloudflare] = mcpServers(env("cloudflare"));
  assert.equal(cloudflare.oauth?.selectableScopes?.length, preset("cloudflare").oauth!.allowedScopes.length);
});

test("user scope choices must be a subset of the bound", () => {
  const [linear] = mcpServers(env("linear"));
  assert.deepEqual(linear.oauth?.selectableScopes, ["read", "write", "openid", "email"]);
  assert.equal(mcpScopedServer(linear, ["email", "read"]).oauth?.scope, "read email");
  assert.equal(mcpScopedServer(linear, ["write", "read"]).oauth?.scope, "read write");
  assert.equal(mcpScopedServer(linear, ["read"]).oauth?.selectableScopes, undefined);
  for (const bad of [[], ["read", "admin"], ["read", "read"], ["read write"]])
    assert.throws(() => mcpScopedServer(linear, bad), { code: "oauth_scope_not_allowed" }, JSON.stringify(bad));
  const [cloudflare] = mcpServers(env("cloudflare"));
  const many = cloudflare.oauth!.selectableScopes!.slice(0, MCP_SCOPE_LIMITS.chosen + 1);
  assert.throws(() => mcpScopedServer(cloudflare, many), { code: "oauth_scope_not_allowed" });
});

test("an operator scope is the upper bound for the user's choice", () => {
  const [linear] = mcpServers(env("linear", { MCP_PROVIDER_LINEAR_SCOPE: "read" }));
  assert.deepEqual(linear.oauth?.selectableScopes, ["read"]);
  assert.doesNotThrow(() => mcpScopedServer(linear, ["read"]));
  assert.throws(() => mcpScopedServer(linear, ["write"]), { code: "oauth_scope_not_allowed" });
  // An operator scope outside the published list still closes the provider.
  assert.deepEqual(mcpServers(env("linear", { MCP_PROVIDER_LINEAR_SCOPE: "admin" })), []);
  // A fixed token bound (no request scope) offers no choice.
  const [dropbox] = mcpServers(env("dropbox", { MCP_PROVIDER_DROPBOX_TOKEN_SCOPE: "files.metadata.read" }));
  assert.equal(dropbox.oauth?.selectableScopes, undefined);
  assert.throws(() => mcpScopedServer(dropbox, ["files.metadata.read"]), { code: "oauth_scope_not_allowed" });
});

test("policy digests stay compatible with default-scope connections and bind each choice", () => {
  const [linear] = mcpServers(env("linear"));
  const { selectableScopes: _bound, ...legacyOAuth } = linear.oauth!;
  const legacy = createHash("sha256").update(JSON.stringify({ ...linear, oauth: legacyOAuth })).digest("hex");
  assert.equal(mcpPolicyDigest(linear), legacy);
  assert.equal(mcpPolicyDigest(linear, ["write", "read"]), legacy);
  assert.notEqual(mcpPolicyDigest(linear, ["read"]), legacy);
  assert.notEqual(mcpPolicyDigest(linear, ["read"]), mcpPolicyDigest(linear, ["read", "email"]));
});

test("selectable scopes cannot coexist with a token bound or omit the default scope", () => {
  const base = { id: "x", name: "X", url: "https://mcp.example.com/mcp", auth: "oauth" as const,
    oauth: { issuer: "https://mcp.example.com", authorizationUrl: "https://mcp.example.com/a", tokenUrl: "https://mcp.example.com/t", scope: "read" } };
  assert.ok(mcpServerSchema.safeParse({ ...base, oauth: { ...base.oauth, selectableScopes: ["read", "write"] } }).success);
  assert.equal(mcpServerSchema.safeParse({ ...base, oauth: { ...base.oauth, selectableScopes: ["write"] } }).success, false);
  assert.equal(mcpServerSchema.safeParse({ ...base, oauth: { ...base.oauth, scope: "", tokenScope: "read", selectableScopes: ["read"] } }).success, false);
  assert.equal(mcpServerSchema.safeParse({ ...base, oauth: { ...base.oauth, selectableScopes: ["read", "bad scope"] } }).success, false);
});

test("the connect dialog enforces the same choice limits as the server", async () => {
  const { PLUGIN_SCOPE_LIMITS } = await import("@/lib/mcpConnectorClientContract");
  assert.deepEqual(PLUGIN_SCOPE_LIMITS, { chosen: MCP_SCOPE_LIMITS.chosen, chosenCharacters: MCP_SCOPE_LIMITS.chosenCharacters });
});
