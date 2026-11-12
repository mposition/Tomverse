import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { decryptOAuthToken, encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";
import { withMcpClient } from "@/lib/mcpConnectorClient";
import { connectorInputSchema } from "@/lib/mcpConnectorSchema";
import { containsMcpCredential } from "@/lib/mcpConnectorSecrets";
import { GITHUB_ISSUE_TOOLS } from "@/lib/mcpConnectorGitHub";
import { MCP_LIMITS, McpConnectorError, isCustomMcpServerId, mcpCustomServersEnabled, mcpServers, type McpGrant, type McpServerPolicy } from "@/lib/mcpConnectorPolicy";
import { assertPublicCustomMcpUrl, customMcpServerName, customMcpServerPolicy, discoverCustomOAuth, listCustomMcpServers, mcpServerFor, normalizeCustomMcpUrl,
  type customMcpServerInputSchema } from "@/lib/mcpCustomServers";

export const mcpPolicyDigest = (server: McpServerPolicy) => createHash("sha256").update(JSON.stringify(server)).digest("hex");
export const encryptMcpSecret = (value: string) => {
  if (value.startsWith("enc:v1:")) throw new McpConnectorError("invalid_credential");
  return encryptOAuthAccountTokens({ access_token: value }).access_token;
};
export const decryptMcpSecret = (value: string | null) => decryptOAuthToken(value);
export const mcpGrantSchema = z.object({ name: z.string().min(1).max(128), mode: z.enum(["read", "confirm"]), inputSchema: z.record(z.string(), z.unknown()) }).strict();
export const parseMcpGrants = (v: unknown): McpGrant[] => z.array(mcpGrantSchema).max(MCP_LIMITS.tools).parse(v);
export const parseMcpCatalog = (v: unknown): McpGrant[] => z.array(mcpGrantSchema).max(MCP_LIMITS.catalogTools).parse(v);

export async function auditMcp(tx: Prisma.TransactionClient, userId: string, action: string, id: string, targetType = "McpConnection") {
  await writeAdminAuditLog({ tx, session: { user: { id: userId }, expires: "" },
    action: `mcp.${action}`, targetType, targetId: id,
    summary: `MCP connector ${action}.` });
}
export async function ownMcpConnection(userId: string, id: string, active = true) {
  const row = await prisma.mcpConnection.findFirst({ where: { id, userId } });
  if (!row) throw new McpConnectorError("connection_not_found", 404);
  if (active) {
    const server = await mcpServerFor(userId, row.serverId);
    if (row.status !== "connected" || row.policyDigest !== mcpPolicyDigest(server)) throw new McpConnectorError("connection_unavailable", 409);
  }
  return row;
}
export async function listMcpConnections(userId: string) {
  // Pending outbound content has a short TTL, including while the preview is off.
  await prisma.mcpInvocation.updateMany({ where: { userId, expiresAt: { lte: new Date() }, argumentsCiphertext: { not: null } },
    data: { argumentsCiphertext: null, state: "expired" } });
  const rows = await prisma.mcpConnection.findMany({ where: { userId }, orderBy: { createdAt: "asc" },
    select: { id: true, serverId: true, status: true, catalog: true, grants: true, version: true, policyDigest: true, createdAt: true } });
  const servers = [...mcpServers(), ...await listCustomMcpServers(userId)];
  return rows.map(row => {
    const policy = servers.find(server => server.id === row.serverId);
    return { id: row.id, serverId: row.serverId, name: policy?.name || row.serverId,
      status: row.status === "connected" && (!policy || row.policyDigest !== mcpPolicyDigest(policy)) ? "unavailable" : row.status,
      catalog: row.catalog, grants: row.grants, version: row.version, createdAt: row.createdAt };
  });
}

export async function connectMcp(userId: string, serverId: string, credential?: string, signal?: AbortSignal,
  oauthSession?: { tokens: OAuthTokens; clientInformation?: OAuthClientInformationMixed; expectedVersion: number | null }) {
  const server = await mcpServerFor(userId, serverId);
  const previous = await prisma.mcpConnection.findUnique({ where: { userId_serverId: { userId, serverId } }, select: { id: true, version: true, status: true } });
  if (server.auth === "oauth" && (!oauthSession || (previous?.version ?? null) !== oauthSession.expectedVersion)) throw new McpConnectorError("oauth_required", 409);
  if ((!previous || previous.status === "disconnected") && await prisma.mcpConnection.count({ where: { userId, status: { not: "disconnected" } } }) >= MCP_LIMITS.connections) throw new McpConnectorError("connection_limit", 429);
  if (server.auth === "bearer" && (!credential || credential.length > 4096 || /[\s\r\n]/.test(credential))) throw new McpConnectorError("credential_required");
  // No Tomverse session or login credential is reused. OAuth sessions come
  // only from the owner-bound, one-use authorization-code callback.
  const token = server.auth === "oauth" ? oauthSession!.tokens.access_token : server.auth === "bearer" ? credential! : null;
  const catalog = await withMcpClient({ server, token, signal }, async (client, signal) => {
    const result = await client.listTools({}, { signal });
    if (result.tools.length > MCP_LIMITS.catalogTools || result.nextCursor) throw new McpConnectorError("tool_catalog_limit");
    return result.tools.flatMap(t => {
      try {
        if (server.githubRepository && !GITHUB_ISSUE_TOOLS.has(t.name)) return [];
        if (t.outputSchema) connectorInputSchema(t.outputSchema, "output");
        return [{ name: z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/).parse(t.name),
          mode: server.readTools.includes(t.name) ? "read" as const : "confirm" as const,
          inputSchema: connectorInputSchema(t.inputSchema) }];
      } catch { return []; }
    });
  });
  signal?.throwIfAborted();
  if (containsMcpCredential(catalog, token)) throw new McpConnectorError("credential_echo_refused");
  const ciphertext = token ? encryptMcpSecret(token) : null;
  const row = await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    const current = await tx.mcpConnection.findUnique({ where: { userId_serverId: { userId, serverId } }, select: { id: true, version: true } });
    if (previous ? current?.version !== previous.version : current !== null) throw new McpConnectorError("connection_changed", 409);
    if ((!previous || previous.status === "disconnected") && await tx.mcpConnection.count({ where: { userId, status: { not: "disconnected" } } }) >= MCP_LIMITS.connections) throw new McpConnectorError("connection_limit", 429);
    const data = { status: "connected", policyDigest: mcpPolicyDigest(server), credentialCiphertext: ciphertext,
      oauthCiphertext: oauthSession ? encryptMcpSecret(JSON.stringify({ tokens: oauthSession.tokens, clientInformation: oauthSession.clientInformation })) : null,
      catalog: catalog as Prisma.InputJsonValue };
    const row = previous ? await tx.mcpConnection.update({ where: { id: previous.id, version: previous.version }, data: { ...data, grants: [], version: { increment: 1 } } }) :
      await tx.mcpConnection.create({ data: { userId, serverId, ...data } });
    await tx.mcpInvocation.updateMany({ where: { connectionId: row.id, state: "pending" }, data: { state: "rejected", argumentsCiphertext: null } });
    await auditMcp(tx, userId, "connected", row.id);
    return row;
  });
  return { id: row.id, catalog, version: row.version };
}

export async function grantMcpTools(userId: string, id: string, names: string[], version: number) {
  const row = await ownMcpConnection(userId, id);
  const catalog = parseMcpCatalog(row.catalog);
  if (new Set(names).size !== names.length || names.some(name => !catalog.some(t => t.name === name))) throw new McpConnectorError("tool_not_allowed");
  const server = await mcpServerFor(userId, row.serverId);
  const grants = catalog.filter(t => names.includes(t.name)).map(t => ({ ...t, mode: server.readTools.includes(t.name) ? "read" as const : "confirm" as const }));
  if (JSON.stringify(grants).length > 12_000) throw new McpConnectorError("schema_budget");
  await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    const changed = await tx.mcpConnection.updateMany({ where: { id, userId, version, status: "connected" }, data: { grants: grants as Prisma.InputJsonValue, version: { increment: 1 } } });
    if (!changed.count) throw new McpConnectorError("connection_changed", 409);
    await tx.mcpInvocation.updateMany({ where: { connectionId: id, state: "pending" }, data: { state: "rejected", argumentsCiphertext: null } });
    await auditMcp(tx, userId, "permissions_changed", id);
  });
}

export async function disconnectMcp(userId: string, id: string) {
  // Always available, even when the feature or provider was disabled.
  await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    const changed = await tx.mcpConnection.updateMany({ where: { id, userId }, data: {
      status: "disconnected", credentialCiphertext: null, oauthCiphertext: null, catalog: [], grants: [], version: { increment: 1 } } });
    if (!changed.count) throw new McpConnectorError("connection_not_found", 404);
    const row = await tx.mcpConnection.findUniqueOrThrow({ where: { id }, select: { serverId: true } });
    await tx.mcpOAuthFlow.updateMany({ where: { userId, serverId: row.serverId, state: { in: ["pending", "running"] } },
      data: { state: "failed", secretCiphertext: null } });
    await tx.mcpInvocation.updateMany({ where: { connectionId: id, userId, state: "pending" }, data: { state: "rejected", argumentsCiphertext: null } });
    if (isCustomMcpServerId(row.serverId)) await removeCustomServerIfSettled(tx, userId, row.serverId);
    await auditMcp(tx, userId, "disconnected", id);
  });
}

// Registration fixes the policy (URL, auth, discovered OAuth endpoints) once.
// Rows that never got a live connection are dropped so they free the cap.
export async function registerCustomMcpServer(userId: string, input: z.infer<typeof customMcpServerInputSchema>, signal?: AbortSignal) {
  if (!mcpCustomServersEnabled()) throw new McpConnectorError("custom_servers_disabled", 503);
  const url = normalizeCustomMcpUrl(input.url);
  const existing = await prisma.mcpCustomServer.findUnique({ where: { userId_url_auth: { userId, url, auth: input.auth } } });
  if (existing) return { server: customMcpServerPolicy(existing), created: false };
  await refuseUnverifiedWriteOnUrl(prisma, userId, url);
  const stale = await prisma.mcpCustomServer.findMany({ where: { userId, createdAt: { lt: new Date(Date.now() - MCP_LIMITS.pendingMs) } }, select: { id: true } });
  for (const row of stale) await forgetUnusedCustomMcpServer(userId, row.id);
  const deadline = AbortSignal.any([AbortSignal.timeout(MCP_LIMITS.requestMs), ...(signal ? [signal] : [])]);
  await assertPublicCustomMcpUrl(url, deadline);
  const oauth = input.auth === "oauth" ? await discoverCustomOAuth(url, deadline) : undefined;
  const data = { id: `custom-${randomBytes(12).toString("hex")}`, userId, name: customMcpServerName(input.name, url), url, auth: input.auth };
  const server = customMcpServerPolicy({ ...data, oauth: oauth ?? null }); // validated before anything is stored
  try {
    await prisma.$transaction(async tx => {
      await takeAuditChainLock(tx);
      const raced = await tx.mcpCustomServer.findUnique({ where: { userId_url_auth: { userId, url, auth: input.auth } } });
      if (raced) return;
      // Again under the audit lock, which approvals also take: a pending call
      // approved during discovery is running by now and is seen here.
      await refuseUnverifiedWriteOnUrl(tx, userId, url);
      if (await tx.mcpCustomServer.count({ where: { userId } }) >= MCP_LIMITS.customServers) throw new McpConnectorError("custom_server_limit", 429);
      await tx.mcpCustomServer.create({ data: { ...data, ...(oauth ? { oauth: oauth as Prisma.InputJsonValue } : {}) } });
      await auditMcp(tx, userId, "custom_server_added", data.id, "McpCustomServer");
    });
  } catch (error) { if ((error as { code?: string })?.code !== "P2002") throw error; }
  const stored = await prisma.mcpCustomServer.findUniqueOrThrow({ where: { userId_url_auth: { userId, url, auth: input.auth } } });
  return { server: stored.id === data.id ? server : customMcpServerPolicy(stored), created: stored.id === data.id };
}
export async function forgetUnusedCustomMcpServer(userId: string, id: string) {
  await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    await removeCustomServerIfSettled(tx, userId, id);
  });
}
// Another auth type for the same URL would get a fresh connection and so
// escape the fence on an unverified write made through the kept row.
async function refuseUnverifiedWriteOnUrl(db: Prisma.TransactionClient, userId: string, url: string) {
  const ids = (await db.mcpCustomServer.findMany({ where: { userId, url }, select: { id: true } })).map(row => row.id);
  if (ids.length && await db.mcpInvocation.count({ where: { userId, state: { in: ["running", "unknown"] }, connection: { serverId: { in: ids } } } }))
    throw new McpConnectorError("previous_outcome_unknown", 409);
}
// A user-entered server lives only as long as its connection, except while a
// dispatched write's outcome is unverified: the row (so its serverId and
// connection, which carry the replay fence) stays until the owner records it.
async function removeCustomServerIfSettled(tx: Prisma.TransactionClient, userId: string, id: string) {
  if (await tx.mcpConnection.count({ where: { userId, serverId: id, status: { not: "disconnected" } } })) return;
  if (await tx.mcpInvocation.count({ where: { userId, state: { in: ["running", "unknown"] }, connection: { serverId: id } } })) return;
  const removed = await tx.mcpCustomServer.deleteMany({ where: { id, userId } });
  if (removed.count) await auditMcp(tx, userId, "custom_server_removed", id, "McpCustomServer");
}
