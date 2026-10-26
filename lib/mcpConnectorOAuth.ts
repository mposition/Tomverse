import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { auth, type OAuthClientProvider, type OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { prisma } from "@/lib/prisma";
import { takeAuditChainLock } from "@/lib/adminAudit";
import { guardedMcpFetch, resolvePublicMcpEndpoint, validateMcpEndpoint } from "@/lib/mcpConnectorClient";
import { MCP_LIMITS, McpConnectorError, mcpServer, type McpServerPolicy } from "@/lib/mcpConnectorPolicy";
import { auditMcp, connectMcp, decryptMcpSecret, encryptMcpSecret, mcpPolicyDigest } from "@/lib/mcpConnectorStore";
import { githubOAuthTokenRequest } from "@/lib/mcpConnectorGitHub";

type OAuthSecrets = { verifier?: string; clientInformation?: OAuthClientInformationMixed; tokens?: OAuthTokens };
const stateDigest = (state: string) => createHash("sha256").update(state).digest("hex");
const ownOAuth = (server: McpServerPolicy) => {
  if (server.auth !== "oauth" || !server.oauth) throw new McpConnectorError("oauth_not_configured");
  const oauth = server.oauth;
  for (const url of [oauth.issuer, oauth.authorizationUrl, oauth.tokenUrl, ...(oauth.registrationUrl ? [oauth.registrationUrl] : [])]) {
    validateMcpEndpoint({ ...server, url }, true);
  }
  if (!oauth.clientId && !oauth.registrationUrl) throw new McpConnectorError("oauth_client_required");
  if (oauth.clientSecretEnv && (!oauth.clientId || !process.env[oauth.clientSecretEnv])) throw new McpConnectorError("oauth_client_required");
  return oauth;
};

// Explicit operator-registered metadata replaces untrusted discovery. Every
// token/registration destination is checked and pinned by the same egress code.
function discovery(server: McpServerPolicy): OAuthDiscoveryState {
  const oauth = ownOAuth(server);
  return { authorizationServerUrl: oauth.issuer,
    authorizationServerMetadata: {
      issuer: oauth.issuer, authorization_endpoint: oauth.authorizationUrl, token_endpoint: oauth.tokenUrl,
      ...(oauth.registrationUrl ? { registration_endpoint: oauth.registrationUrl } : {}),
      response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["client_secret_post", "none"],
    }, resourceMetadata: { resource: server.url, authorization_servers: [oauth.issuer], scopes_supported: oauth.scope.split(/\s+/) } };
}

async function runOAuth(input: { flowId: string; userId: string; server: McpServerPolicy; redirectUri: string; state: string;
  secrets: OAuthSecrets; code?: string; signal?: AbortSignal }) {
  const oauth = ownOAuth(input.server), state = input.secrets;
  const signal = AbortSignal.any([AbortSignal.timeout(MCP_LIMITS.requestMs), ...(input.signal ? [input.signal] : [])]);
  await resolvePublicMcpEndpoint({ ...input.server, url: oauth.authorizationUrl }, signal, true);
  let redirect: string | undefined;
  const save = async () => {
    const serialized = JSON.stringify(state);
    if (Buffer.byteLength(serialized) > 32_768) throw new McpConnectorError("oauth_response_limit");
    const updated = await prisma.mcpOAuthFlow.updateMany({ where: { id: input.flowId, userId: input.userId, state: { in: ["pending", "running"] }, expiresAt: { gt: new Date() } },
      data: { secretCiphertext: encryptMcpSecret(serialized) } });
    if (!updated.count) throw new McpConnectorError("oauth_flow_expired");
  };
  const provider: OAuthClientProvider = {
    redirectUrl: input.redirectUri,
    clientMetadata: { client_name: "Tomverse", redirect_uris: [input.redirectUri], grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"], token_endpoint_auth_method: oauth.clientSecretEnv ? "client_secret_post" : "none", scope: oauth.scope },
    state: () => input.state,
    clientInformation: () => oauth.clientId ? { client_id: oauth.clientId, issuer: oauth.issuer,
      ...(oauth.clientSecretEnv ? { client_secret: process.env[oauth.clientSecretEnv] } : {}) } : state.clientInformation,
    saveClientInformation: async info => { if (info.issuer !== oauth.issuer) throw new McpConnectorError("oauth_issuer_mismatch"); state.clientInformation = info; await save(); },
    tokens: () => state.tokens,
    saveTokens: async tokens => {
      if (tokens.issuer !== oauth.issuer || tokens.token_type.toLowerCase() !== "bearer" || tokens.access_token.length > 4096 || /\s/.test(tokens.access_token)) throw new McpConnectorError("oauth_token_refused");
      const allowed = new Set(oauth.scope.split(/\s+/));
      if (tokens.scope && tokens.scope.split(/\s+/).some(scope => !allowed.has(scope))) throw new McpConnectorError("oauth_scope_expanded");
      state.tokens = tokens; await save();
    },
    redirectToAuthorization: url => {
      const allowed = new URL(oauth.authorizationUrl);
      if (url.origin !== allowed.origin || url.pathname !== allowed.pathname || url.username || url.password || url.hash || url.searchParams.get("redirect_uri") !== input.redirectUri || url.searchParams.get("state") !== input.state || url.searchParams.get("code_challenge_method") !== "S256")
        throw new McpConnectorError("oauth_redirect_refused");
      redirect = url.href;
    },
    saveCodeVerifier: async verifier => { state.verifier = verifier; await save(); },
    codeVerifier: () => { if (!state.verifier) throw new McpConnectorError("oauth_verifier_missing"); return state.verifier; },
    discoveryState: () => discovery(input.server),
    // Never let discovery invalidation broaden the configured issuer/endpoints.
    invalidateCredentials: async kind => {
      if (kind === "all" || kind === "tokens") delete state.tokens;
      if (kind === "all" || kind === "client") delete state.clientInformation;
      if (kind === "all" || kind === "verifier") delete state.verifier;
      await save();
    },
  };
  const endpoints = [oauth.tokenUrl, ...(oauth.registrationUrl ? [oauth.registrationUrl] : [])];
  const fetchers = new Map(endpoints.map(url => [new URL(url).href, guardedMcpFetch({ ...input.server, url }, null, signal, true)]));
  const outcome = await auth(provider, { serverUrl: input.server.url, scope: oauth.scope, authorizationCode: input.code,
    fetchFn: (url, init) => {
      const fetcher = fetchers.get(String(url instanceof Request ? url.url : url));
      if (!fetcher) throw new McpConnectorError("oauth_discovery_refused");
      return fetcher(url, githubOAuthTokenRequest(input.server, String(url instanceof Request ? url.url : url), init));
    } });
  return { outcome, redirect, secrets: state };
}

export async function startMcpOAuth(userId: string, serverId: string, redirectUri: string, signal?: AbortSignal) {
  const server = mcpServer(serverId); ownOAuth(server);
  const previous = await prisma.mcpConnection.findUnique({ where: { userId_serverId: { userId, serverId } }, select: { version: true, oauthCiphertext: true, policyDigest: true } });
  const state = randomBytes(32).toString("base64url");
  const secrets: OAuthSecrets = previous?.policyDigest === mcpPolicyDigest(server) && previous.oauthCiphertext ? JSON.parse(decryptMcpSecret(previous.oauthCiphertext) || "{}") : {};
  const flow = await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    if (await tx.mcpOAuthFlow.count({ where: { userId, expiresAt: { gt: new Date() } } }) >= 8) throw new McpConnectorError("oauth_flow_limit", 429);
    const row = await tx.mcpOAuthFlow.create({ data: { userId, serverId, policyDigest: mcpPolicyDigest(server), connectionVersion: previous?.version,
      stateHash: stateDigest(state), redirectUri, secretCiphertext: encryptMcpSecret(JSON.stringify(secrets)), expiresAt: new Date(Date.now() + MCP_LIMITS.pendingMs) } });
    await auditMcp(tx, userId, "authorization_started", row.id, "McpOAuthFlow");
    return row;
  });
  try {
    const result = await runOAuth({ flowId: flow.id, userId, server, redirectUri, state, secrets, signal });
    if (result.outcome === "AUTHORIZED" && result.secrets.tokens) {
      await prisma.mcpOAuthFlow.update({ where: { id: flow.id }, data: { state: "used", secretCiphertext: null } });
      return { status: "connected", connection: await connectMcp(userId, serverId, undefined, signal,
        { tokens: result.secrets.tokens, clientInformation: result.secrets.clientInformation, expectedVersion: previous?.version ?? null }) };
    }
    if (!result.redirect) throw new McpConnectorError("oauth_redirect_missing");
    return { status: "authorization_required", authorizationUrl: result.redirect };
  } catch { await prisma.mcpOAuthFlow.updateMany({ where: { id: flow.id }, data: { state: "failed", secretCiphertext: null } }); throw new McpConnectorError("oauth_authorization_failed", 502); }
}

export async function completeMcpOAuth(userId: string, state: string, code: string, issuer?: string, signal?: AbortSignal) {
  const flow = await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    const row = await tx.mcpOAuthFlow.findFirst({ where: { userId, stateHash: stateDigest(state), state: "pending", expiresAt: { gt: new Date() } } });
    if (!row?.secretCiphertext) throw new McpConnectorError("oauth_flow_expired", 409);
    const server = mcpServer(row.serverId);
    if (row.policyDigest !== mcpPolicyDigest(server) || (issuer && issuer !== server.oauth?.issuer)) throw new McpConnectorError("oauth_issuer_mismatch");
    const claimed = await tx.mcpOAuthFlow.updateMany({ where: { id: row.id, userId, state: "pending" }, data: { state: "running" } });
    if (!claimed.count) throw new McpConnectorError("oauth_flow_expired", 409);
    await auditMcp(tx, userId, "authorization_claimed", row.id, "McpOAuthFlow");
    return row;
  });
  try {
    const server = mcpServer(flow.serverId);
    const result = await runOAuth({ flowId: flow.id, userId, server, redirectUri: flow.redirectUri, state,
      secrets: JSON.parse(decryptMcpSecret(flow.secretCiphertext) || "{}"), code, signal });
    if (result.outcome !== "AUTHORIZED" || !result.secrets.tokens) throw new McpConnectorError("oauth_token_missing");
    const connection = await connectMcp(userId, flow.serverId, undefined, signal,
      { tokens: result.secrets.tokens, clientInformation: result.secrets.clientInformation, expectedVersion: flow.connectionVersion });
    await prisma.mcpOAuthFlow.update({ where: { id: flow.id }, data: { state: "used", secretCiphertext: null } });
    return connection;
  } catch { await prisma.mcpOAuthFlow.updateMany({ where: { id: flow.id }, data: { state: "failed", secretCiphertext: null } }); throw new McpConnectorError("oauth_authorization_failed", 502); }
}
