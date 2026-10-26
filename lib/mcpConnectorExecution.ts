import "server-only";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { prisma } from "@/lib/prisma";
import { takeAuditChainLock } from "@/lib/adminAudit";
import { withMcpClient } from "@/lib/mcpConnectorClient";
import { MCP_LIMITS, MCP_UNTRUSTED_NOTICE, McpConnectorError, mcpServer } from "@/lib/mcpConnectorPolicy";
import { connectorInputSchema, normalizeMcpResult, validateMcpArguments } from "@/lib/mcpConnectorSchema";
import { auditMcp, decryptMcpSecret, encryptMcpSecret, mcpPolicyDigest, ownMcpConnection, parseMcpGrants } from "@/lib/mcpConnectorStore";
import { containsMcpCredential } from "@/lib/mcpConnectorSecrets";
import { githubIssueReadSources, githubIssueSearchIsEmpty, validateGithubRepositoryScope } from "@/lib/mcpConnectorGitHub";

export type McpToolOutcome = Awaited<ReturnType<typeof normalizeMcpResult>> & { notice: string; approvalId?: string };
const safeError = (e: unknown) => e instanceof McpConnectorError ? e.code :
  e instanceof Error && ["AbortError", "TimeoutError"].includes(e.name) ? "cancelled_or_timeout" : "server_error";

async function createInvocation(userId: string, connectionId: string, version: number, name: string, args: Record<string, unknown>, confirm: boolean) {
  return prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    // Serializes quota admission across processes; no external I/O in this transaction.
    const recent = await tx.mcpInvocation.count({ where: { userId, createdAt: { gt: new Date(Date.now() - 60_000) } } });
    if (recent >= 24) throw new McpConnectorError("rate_limit", 429);
    const connection = await tx.mcpConnection.findFirst({ where: { id: connectionId, userId, version, status: "connected" } });
    if (!connection) throw new McpConnectorError("connection_changed", 409);
    // Reauthentication cannot clear an uncertain write. The user must verify
    // its outcome at the provider before this tool can be proposed again.
    if (confirm && await tx.mcpInvocation.findFirst({ where: { connectionId, toolName: name, state: { in: ["running", "unknown"] } }, select: { id: true } }))
      throw new McpConnectorError("previous_outcome_unknown", 409);
    const row = await tx.mcpInvocation.create({ data: { userId, connectionId, connectionVersion: version, toolName: name,
      state: confirm ? "pending" : "running", argumentsCiphertext: confirm ? encryptMcpSecret(JSON.stringify(args)) : null,
      expiresAt: new Date(Date.now() + MCP_LIMITS.pendingMs) } });
    await auditMcp(tx, userId, confirm ? "approval_requested" : "read_started", row.id, "McpInvocation");
    return row;
  });
}

async function performMcp(input: { userId: string; connectionId: string; version: number; name: string; args: Record<string, unknown>; signal?: AbortSignal; invocationId: string }) {
  const { userId, connectionId, version, name, args, invocationId } = input;
  const connection = await ownMcpConnection(userId, connectionId);
  const server = mcpServer(connection.serverId);
  const grant = parseMcpGrants(connection.grants).find(t => t.name === name);
  if (connection.version !== version || !grant) throw new McpConnectorError("connection_changed", 409);
  validateMcpArguments(grant, args);
  validateGithubRepositoryScope(server, name, args);
  const leaseId = randomUUID();
  const claimed = await prisma.mcpConnection.updateMany({ where: { id: connectionId, userId, version, status: "connected",
    OR: [{ leaseUntil: null }, { leaseUntil: { lt: new Date() } }] },
    data: { leaseId, leaseUntil: new Date(Date.now() + MCP_LIMITS.requestMs + 2_000) } });
  if (!claimed.count) throw new McpConnectorError("connection_busy", 409);
  const controller = new AbortController();
  const signal = AbortSignal.any([controller.signal, ...(input.signal ? [input.signal] : [])]);
  let checking = false, dispatched = false;
  const current = async () => {
    const row = await ownMcpConnection(userId, connectionId);
    if (row.version !== version || row.leaseId !== leaseId || row.policyDigest !== mcpPolicyDigest(mcpServer(row.serverId))) throw new McpConnectorError("connection_changed", 409);
    return row;
  };
  // The DB fence and result check work across instances; this poll additionally
  // aborts an already open socket when disconnect races an in-flight call.
  const timer = setInterval(() => {
    if (checking) return; checking = true;
    void current().catch(() => controller.abort()).finally(() => { checking = false; });
  }, 150);
  try {
    const result = await withMcpClient({ server, token: decryptMcpSecret(connection.credentialCiphertext), signal }, async (client, signal) => {
      const list = await client.listTools({}, { signal });
      const tool = list.tools.find(t => t.name === name);
      if (!tool || !isDeepStrictEqual(connectorInputSchema(tool.inputSchema), grant.inputSchema)) throw new McpConnectorError("tool_changed");
      await current(); signal.throwIfAborted();
      dispatched = true;
      return client.callTool({ name, arguments: args }, undefined, { signal, timeout: MCP_LIMITS.requestMs, maxTotalTimeout: MCP_LIMITS.requestMs });
    });
    await current(); signal.throwIfAborted();
    const normalized = normalizeMcpResult(result);
    if (githubIssueSearchIsEmpty(server, name, result)) normalized.status = "no_results";
    if (grant.mode === "confirm" && normalized.status === "server_error") throw new McpConnectorError("outcome_unknown");
    const token = decryptMcpSecret(connection.credentialCiphertext);
    if (containsMcpCredential(result, token)) throw new McpConnectorError("credential_echo_refused");
    if (normalized.status === "ok") normalized.sources.push(...githubIssueReadSources(server, name, args, result));
    await prisma.$transaction(async tx => {
      await takeAuditChainLock(tx);
      if (!await tx.mcpConnection.findFirst({ where: { id: connectionId, userId, version, status: "connected" }, select: { id: true } })) throw new McpConnectorError("connection_changed", 409);
      const finished = await tx.mcpInvocation.updateMany({ where: { id: invocationId, userId, state: "running" },
        data: { state: normalized.status === "server_error" ? "failed" : "completed", argumentsCiphertext: null } });
      if (!finished.count) throw new McpConnectorError("outcome_unknown");
      await auditMcp(tx, userId, "call_finished", invocationId, "McpInvocation");
    });
    // Do not let an upstream server echo its bearer credential into the model,
    // browser or stored answer. Remote errors are never surfaced verbatim.
    return { ...normalized, notice: MCP_UNTRUSTED_NOTICE };
  } catch (error) {
    const code = safeError(error);
    await prisma.mcpInvocation.updateMany({ where: { id: invocationId, userId, state: "running" },
      data: { state: dispatched && grant.mode === "confirm" ? "unknown" : "failed", argumentsCiphertext: null } });
    if (code === "reauth_required") {
      await prisma.mcpConnection.updateMany({ where: { id: connectionId, userId, version }, data: { status: "reauth_required", credentialCiphertext: null, version: { increment: 1 } } });
    }
    throw new McpConnectorError(dispatched && grant.mode === "confirm" ? "outcome_unknown" : code, 502);
  } finally {
    clearInterval(timer);
    await prisma.mcpConnection.updateMany({ where: { id: connectionId, userId, leaseId }, data: { leaseId: null, leaseUntil: null } });
  }
}

export async function invokeMcpTool(input: { userId: string; connectionId: string; version: number; name: string; args: unknown; signal?: AbortSignal }): Promise<McpToolOutcome> {
  const row = await ownMcpConnection(input.userId, input.connectionId);
  if (row.version !== input.version) throw new McpConnectorError("connection_changed", 409);
  const grant = parseMcpGrants(row.grants).find(t => t.name === input.name);
  if (!grant) throw new McpConnectorError("tool_not_allowed", 403);
  validateMcpArguments(grant, input.args);
  validateGithubRepositoryScope(mcpServer(row.serverId), input.name, input.args);
  const mode = mcpServer(row.serverId).readTools.includes(grant.name) ? grant.mode : "confirm";
  const invocation = await createInvocation(input.userId, row.id, row.version, grant.name, input.args, mode === "confirm");
  if (mode === "confirm") return { status: "approval_required", approvalId: invocation.id, content: "Review the exact action in Plugins. Nothing has been executed.", sources: [], notice: MCP_UNTRUSTED_NOTICE };
  try { return await performMcp({ ...input, args: input.args, invocationId: invocation.id }); }
  catch (error) { await prisma.mcpInvocation.updateMany({ where: { id: invocation.id, state: "running" }, data: { state: "failed", argumentsCiphertext: null } }); throw error; }
}

export async function decideMcpInvocation(userId: string, id: string, approve: boolean, signal?: AbortSignal) {
  const invocation = await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    const row = await tx.mcpInvocation.findFirst({ where: { id, userId, state: "pending", expiresAt: { gt: new Date() } } });
    if (!row || !row.argumentsCiphertext) throw new McpConnectorError("approval_unavailable", 409);
    if (approve && await tx.mcpInvocation.findFirst({ where: { connectionId: row.connectionId, toolName: row.toolName,
      id: { not: row.id }, state: { in: ["running", "unknown"] } }, select: { id: true } }))
      throw new McpConnectorError("previous_outcome_unknown", 409);
    const own = await tx.mcpConnection.findFirst({ where: { id: row.connectionId, userId, version: row.connectionVersion, status: "connected" } });
    if (!own) throw new McpConnectorError("connection_changed", 409);
    await tx.mcpInvocation.update({ where: { id }, data: { state: approve ? "running" : "rejected", argumentsCiphertext: null,
      ...(approve ? { expiresAt: new Date(Date.now() + MCP_LIMITS.requestMs + 30_000) } : {}) } });
    await auditMcp(tx, userId, approve ? "action_approved" : "action_rejected", id, "McpInvocation");
    return row;
  });
  if (!approve) return { status: "rejected" };
  try {
    return await performMcp({ userId, connectionId: invocation.connectionId, version: invocation.connectionVersion,
      name: invocation.toolName, args: JSON.parse(decryptMcpSecret(invocation.argumentsCiphertext) || "{}"), signal, invocationId: id });
  } catch (error) {
    await prisma.mcpInvocation.updateMany({ where: { id, userId, state: "running" }, data: { state: "failed", argumentsCiphertext: null } });
    throw error;
  }
}

export async function listMcpInvocations(userId: string) {
  const rows = await prisma.mcpInvocation.findMany({ where: { userId }, orderBy: { createdAt: "desc" }, take: 30 });
  return rows.map(row => ({ id: row.id, connectionId: row.connectionId, toolName: row.toolName,
    state: row.state === "pending" && row.expiresAt <= new Date() ? "expired" : row.state, expiresAt: row.expiresAt,
    arguments: row.state === "pending" && row.expiresAt > new Date() ? JSON.parse(decryptMcpSecret(row.argumentsCiphertext) || "null") : null }));
}

export async function confirmMcpOutcome(userId: string, id: string, outcome: "completed" | "not_executed") {
  await prisma.$transaction(async tx => {
    await takeAuditChainLock(tx);
    const updated = await tx.mcpInvocation.updateMany({ where: { id, userId, state: "unknown" },
      data: { state: outcome === "completed" ? "completed" : "failed", argumentsCiphertext: null } });
    if (!updated.count) throw new McpConnectorError("approval_unavailable", 409);
    await auditMcp(tx, userId, outcome === "completed" ? "outcome_confirmed_completed" : "outcome_confirmed_not_executed", id, "McpInvocation");
  });
  return { status: "confirmed" };
}
