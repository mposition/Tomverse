import "server-only";
import presets from "@/config/mcp/provider-presets.json";

type ProviderEnvironment = Record<string, string | undefined>;
export const MCP_PROVIDER_PRESETS = presets.profiles;
export const providerEnvironmentPrefix = (id: string) => `MCP_PROVIDER_${id.replaceAll("-", "_").toUpperCase()}`;

/**
 * Scopes a user may choose from when connecting. An operator-set scope is the
 * upper bound; otherwise the preset's published scope list is. A fixed token
 * scope bound (request without scope) leaves nothing to choose.
 */
function userSelectableScopes(allowedScopes: readonly string[], envScope: string | undefined, tokenScope: string | undefined) {
  if (tokenScope !== undefined) return [];
  return [...new Set(envScope === undefined ? allowedScopes : envScope.split(/\s+/).filter(Boolean))].slice(0, 512);
}

/**
 * Providers the operator switched off with the comma-separated
 * MCP_CONNECTOR_PROVIDERS_DISABLED (empty by default). Unknown IDs are ignored.
 */
export function disabledMcpProviderIds(env: ProviderEnvironment = process.env) {
  return new Set((env.MCP_CONNECTOR_PROVIDERS_DISABLED || "").split(",").map(id => id.trim()).filter(Boolean));
}

/**
 * Every catalog preset is a candidate; no selection list is read. A preset becomes callable only when it can
 * connect without operator secrets (dynamic registration or no auth) or the operator supplied its registered app
 * and scope bounds. Users choose scopes within the bound. Catalog browsing grants nothing.
 */
export function selectedMcpProviderPolicies(env: ProviderEnvironment = process.env) {
  const disabled = disabledMcpProviderIds(env);
  return MCP_PROVIDER_PRESETS.filter(profile => !disabled.has(profile.id)).flatMap(preset => {
    const id = preset.id;
    // GitHub retains the existing reviewed repository-specific App profile.
    if (preset.auth === "github" || preset.auth === "configure") return [];
    const base = { id: preset.id, name: preset.name, url: preset.url, readTools: [], auth: preset.auth };
    if (preset.auth === "none" || !("oauth" in preset) || !preset.oauth) return [base];
    const oauth = preset.oauth;
    const prefix = providerEnvironmentPrefix(id);
    const clientId = env[`${prefix}_CLIENT_ID`];
    const clientSecretEnv = `${prefix}_CLIENT_SECRET`;
    const envScope = env[`${prefix}_SCOPE`];
    const scope = envScope ?? oauth.scope;
    // Default grants must have an operator-declared bound even when the provider
    // requires the authorization request to omit scope entirely.
    const tokenScope = env[`${prefix}_TOKEN_SCOPE`];
    const selectableScopes = userSelectableScopes(oauth.allowedScopes, envScope, tokenScope);
    if (!scope && tokenScope === undefined && !selectableScopes.length) return [];
    if (oauth.scopeRequired && !envScope && tokenScope === undefined && !selectableScopes.length) return [];
    if (tokenScope !== undefined && scope !== "") return [];
    const requestedScopes = [scope, tokenScope || ""].flatMap(value => value.split(/\s+/).filter(Boolean));
    if (scope.length > 500 || (tokenScope?.length || 0) > 500 || (oauth.allowedScopes.length && requestedScopes.some(value => !oauth.allowedScopes.includes(value)))) return [];
    const registrationUrl = "registrationUrl" in oauth ? oauth.registrationUrl : undefined;
    if (!clientId && !registrationUrl) return [];
    if (clientId && oauth.tokenAuthMethod !== "none" && !env[clientSecretEnv]) return [];
    if (!clientId && env[clientSecretEnv]) return [];
    // Present only on profiles that declare it, so every other policy (and its
    // connection digest) is unchanged.
    const authorizationParams = "authorizationParams" in oauth ? oauth.authorizationParams : undefined;
    return [{ ...base, oauth: { issuer: oauth.issuer, authorizationUrl: oauth.authorizationUrl,
      tokenUrl: oauth.tokenUrl, tokenAuthMethod: oauth.tokenAuthMethod, scope,
      ...(authorizationParams ? { authorizationParams } : {}),
      ...(tokenScope === undefined ? {} : { tokenScope }), ...(selectableScopes.length ? { selectableScopes } : {}),
      ...(clientId ? { clientId, ...(oauth.tokenAuthMethod === "none" ? {} : { clientSecretEnv }) } : { registrationUrl }) } }];
  });
}
