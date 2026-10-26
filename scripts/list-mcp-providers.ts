import { MCP_PROVIDERS } from "../lib/mcpProviderCatalog";
import { MCP_PROVIDER_PRESETS, providerEnvironmentPrefix } from "../lib/mcpProviderPresets";
import { mcpServers } from "../lib/mcpConnectorPolicy";

const requested = process.argv.find(arg => arg.startsWith("--provider="))?.slice("--provider=".length);
const providers = MCP_PROVIDERS.filter(provider => !requested || provider.id === requested);
if (requested && providers.length === 0) throw new Error("unknown_mcp_provider");
const enabled = new Set(mcpServers().map(profile => profile.id));
const rows = providers.map(provider => ({ id: provider.id, name: provider.name, kind: provider.kind, docs: provider.docs,
  profiles: MCP_PROVIDER_PRESETS.filter(profile => profile.providerId === provider.id).map(profile => {
    const prefix = providerEnvironmentPrefix(profile.id);
    return { id: profile.id, url: profile.url, auth: profile.auth, configured: enabled.has(profile.id),
      ...("oauth" in profile && profile.oauth ? { scope: profile.oauth.scope,
        scopeEnvironment: `${prefix}_SCOPE`, availableScopes: profile.oauth.allowedScopes,
        clientIdEnvironment: `${prefix}_CLIENT_ID`, clientSecretEnvironment: `${prefix}_CLIENT_SECRET`,
        registration: "registrationUrl" in profile.oauth ? "dynamic-or-registered" : "registered-app-required" } : {}) };
  }) }));
if (process.argv.includes("--json")) process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
else for (const row of rows) {
  process.stdout.write(`${row.id}\t${row.kind}\t${row.profiles.map(profile => `${profile.id}:${profile.auth}${profile.configured ? ":configured" : ""}`).join(",")}\n`);
  if (requested) process.stdout.write(`Setup: ${row.docs}\nSelect fixed profiles with MCP_CONNECTOR_PROVIDERS. No profile is enabled by this command.\n`);
}
