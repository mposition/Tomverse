import "server-only";
import presets from "@/config/mcp/provider-presets.json";

type ProviderEnvironment = Record<string, string | undefined>;
export const MCP_PROVIDER_PRESETS = presets.profiles;
export const providerEnvironmentPrefix = (id: string) => `MCP_PROVIDER_${id.replaceAll("-", "_").toUpperCase()}`;

/** Only operator-selected, fixed profiles become callable. Catalog browsing grants nothing. */
export function selectedMcpProviderPolicies(env: ProviderEnvironment = process.env) {
  const ids = (env.MCP_CONNECTOR_PROVIDERS || "").split(",").map(id => id.trim()).filter(Boolean);
  if (ids.length > 256 || new Set(ids).size !== ids.length) throw new Error("invalid_mcp_provider_selection");
  return ids.flatMap(id => {
    const preset = MCP_PROVIDER_PRESETS.find(profile => profile.id === id);
    if (!preset) return [];
    // GitHub retains the existing reviewed repository-specific App profile.
    if (preset.auth === "github" || preset.auth === "configure") return [];
    const base = { id: preset.id, name: preset.name, url: preset.url, readTools: [], auth: preset.auth };
    if (preset.auth === "none" || !("oauth" in preset) || !preset.oauth) return [base];
    const oauth = preset.oauth;
    const prefix = providerEnvironmentPrefix(id);
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecretEnv = `${prefix}_CLIENT_SECRET`;
    const scope = env[`${prefix}_SCOPE`] ?? oauth.scope;
    // Default grants must have an operator-declared bound even when the provider
    // requires the authorization request to omit scope entirely.
    const tokenScope = env[`${prefix}_TOKEN_SCOPE`];
    if (!scope && tokenScope === undefined) return [];
    if (oauth.scopeRequired && !env[`${prefix}_SCOPE`] && tokenScope === undefined) return [];
    if (tokenScope !== undefined && scope !== "") return [];
    const requestedScopes = [scope, tokenScope || ""].flatMap(value => value.split(/\s+/).filter(Boolean));
    if (scope.length > 500 || (tokenScope?.length || 0) > 500 || (oauth.allowedScopes.length && requestedScopes.some(value => !oauth.allowedScopes.includes(value)))) return [];
    const registrationUrl = "registrationUrl" in oauth ? oauth.registrationUrl : undefined;
    if (!clientId && !registrationUrl) return [];
    if (clientId && oauth.tokenAuthMethod !== "none" && !env[clientSecretEnv]) return [];
    if (!clientId && env[clientSecretEnv]) return [];
    return [{ ...base, oauth: { issuer: oauth.issuer, authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl, tokenAuthMethod: oauth.tokenAuthMethod, scope,
      ...(tokenScope === undefined ? {} : { tokenScope }),
      ...(clientId ? { clientId, ...(oauth.tokenAuthMethod === "none" ? {} : { clientSecretEnv }) } : { registrationUrl }) } }];
  });
}
