import "server-only";
import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { OAuthTokens, OAuthClientInformationMixed } from "@modelcontextprotocol/sdk/shared/auth.js";
import { z } from "zod";
import { prisma } from "@/lib/prisma";
import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { decryptOAuthToken, encryptOAuthAccountTokens } from "@/lib/oauthTokenCrypto";
import { withMcpClient } from "@/lib/mcpConnectorClient";
import { connectorInputSchema } from "@/lib/mcpConnectorSchema";
import { containsMcpCredential } from "@/lib/mcpConnectorSecrets";
import { MCP_LIMITS, McpConnectorError, mcpServer, mcpServers, type McpGrant, type McpServerPolicy } from "@/lib/mcpConnectorPolicy";

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
    const server = mcpServer(row.serverId);
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
  const servers = mcpServers();
  return rows.map(row => {
    const policy = servers.find(server => server.id === row.serverId);
    return { id: row.id, serverId: row.serverId, name: policy?.name || row.serverId,
      status: row.status === "connected" && (!policy || row.policyDigest !== mcpPolicyDigest(policy)) ? "unavailable" : row.status,
      catalog: row.catalog, grants: row.grants, version: row.version, createdAt: row.createdAt };
  });
}

export async function connectMcp(userId: string, serverId: string, credential?: string, signal?: AbortSignal,
  oauthSession?: { tokens: OAuthTokens; clientInformation?: OAuthClientInformationMixed; expectedVersion: number | null }) {
  const server = mcpServer(serverId);
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
  const server = mcpServer(row.serverId);
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
    await auditMcp(tx, userId, "disconnected", id);
  });
}
