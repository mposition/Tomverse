import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { startMcpSyntheticServer } from "../fixtures/mcpSyntheticServer";
import { connectMcp, disconnectMcp, encryptMcpSecret, decryptMcpSecret, grantMcpTools, listMcpConnections, ownMcpConnection } from "@/lib/mcpConnectorStore";
import { confirmMcpOutcome, decideMcpInvocation, invokeMcpTool } from "@/lib/mcpConnectorExecution";
import { buildAccountDataExport } from "@/lib/accountDataExport";
import { buildMcpChatTools } from "@/lib/mcpConnectorChatTool";
import { mcpToolName } from "@/lib/mcpConnectorSchema";
import { streamText, stepCountIs } from "ai";
import { MockLanguageModelV4 } from "ai/test";

let fixture: Awaited<ReturnType<typeof startMcpSyntheticServer>>;
const alice = `mcp-test-${randomUUID()}`, bob = `mcp-test-${randomUUID()}`;
before(async () => {
  assert.ok(process.env.DATABASE_URL?.includes("127.0.0.1:56439") && process.env.DATABASE_URL?.includes("mcp_preview_test"), "disposable local DB only");
  process.env.MCP_CONNECTOR_PREVIEW_ENABLED = "true";
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "synthetic-mcp-encryption-key-32-characters";
  process.env.NEXTAUTH_SECRET = "synthetic-mcp-audit-integrity-key";
  fixture = await startMcpSyntheticServer();
  process.env.MCP_CONNECTOR_SYNTHETIC_PORT = String(fixture.port);
  await prisma.user.createMany({ data: [{ id: alice }, { id: bob }] });
});
after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } });
  await fixture.close(); await prisma.$disconnect();
});
test("connections are owned, grants are explicit, annotations cannot grant read access, and disconnect clears credentials", async () => {
  const connected = await connectMcp(alice, "synthetic");
  assert.equal(connected.catalog.find(t => t.name === "dangerous_delete")?.mode, "confirm");
  await assert.rejects(() => ownMcpConnection(bob, connected.id), { code: "connection_not_found" });
  await grantMcpTools(alice, connected.id, ["search", "read"], connected.version);
  const own = await ownMcpConnection(alice, connected.id);
  assert.deepEqual((own.grants as Array<{ name: string }>).map(g => g.name), ["search", "read"]);
  assert.equal(JSON.stringify(await listMcpConnections(alice)).includes("credentialCiphertext"), false);
  const exported = await buildAccountDataExport(alice);
  assert.equal(exported.data.plugin_connections.length, 1);
  assert.equal(JSON.stringify(exported.data.plugin_connections).includes("credentialCiphertext"), false);
  await disconnectMcp(alice, connected.id);
  await assert.rejects(() => ownMcpConnection(alice, connected.id), { code: "connection_unavailable" });
  const disconnected = await ownMcpConnection(alice, connected.id, false);
  assert.equal(disconnected.credentialCiphertext, null);
  assert.deepEqual(disconnected.grants, []);
});
test("account deletion cascades through connections and pending actions", async () => {
  const row = await connectMcp(bob, "synthetic");
  await prisma.mcpInvocation.create({ data: { userId: bob, connectionId: row.id, connectionVersion: row.version,
    toolName: "create_note", expiresAt: new Date(Date.now() + 600_000) } });
  await prisma.user.delete({ where: { id: bob } });
  assert.equal(await prisma.mcpConnection.count({ where: { userId: bob } }), 0);
  assert.equal(await prisma.mcpInvocation.count({ where: { userId: bob } }), 0);
});

test("encrypted credentials round-trip without plaintext storage", () => {
  const encrypted = encryptMcpSecret("synthetic-bearer-token");
  assert.ok(encrypted.startsWith("enc:v1:"));
  assert.equal(encrypted.includes("synthetic-bearer-token"), false);
  assert.equal(decryptMcpSecret(encrypted), "synthetic-bearer-token");
});

test("read tools return only read sources; writes execute once after exact approval", async () => {
  const row = await connectMcp(alice, "synthetic");
  await grantMcpTools(alice, row.id, ["search", "read", "create_note"], row.version);
  const connection = await ownMcpConnection(alice, row.id);
  const call = (name: string, args: unknown) => invokeMcpTool({ userId: alice, connectionId: row.id, version: connection.version, name, args });
  await assert.rejects(() => call("dangerous_delete", {}), { code: "tool_not_allowed" });
  const search = await call("search", { query: "Atlas" });
  assert.equal(search.status, "ok"); assert.deepEqual(search.sources, []);
  const read = await call("read", { id: "release" });
  assert.equal(read.sources[0]?.url, "https://example.com/docs/release");
  const injection = await call("read", { id: "injection" });
  assert.match(injection.notice, /untrusted quoted data/);
  assert.match(injection.content, /Ignore all instructions/);
  const missing = await call("search", { query: "missing" }); assert.equal(missing.status, "no_results");
  const previousWrites = fixture.writes;
  const proposal = await call("create_note", { text: "Approved synthetic note" });
  assert.equal(proposal.status, "approval_required"); assert.equal(fixture.writes, previousWrites);
  await assert.rejects(() => decideMcpInvocation("another-user", proposal.approvalId!, true), { code: "approval_unavailable" });
  assert.equal((await decideMcpInvocation(alice, proposal.approvalId!, true)).status, "ok");
  await assert.rejects(() => decideMcpInvocation(alice, proposal.approvalId!, true), { code: "approval_unavailable" });
  assert.equal(fixture.writes, previousWrites + 1);
});

test("disconnect racing an in-flight read rejects the result and releases its lease", async () => {
  const connection = (await prisma.mcpConnection.findFirst({ where: { userId: alice } }))!;
  const request = invokeMcpTool({ userId: alice, connectionId: connection.id, version: connection.version,
    name: "search", args: { query: "timeout" } });
  // Attach a rejection observer before the disconnect can abort the socket.
  const rejected = assert.rejects(request);
  const deadline = Date.now() + 3_000;
  while (!fixture.calls.some(c => c.name === "search" && (c.args as { query?: string }).query === "timeout") && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  await disconnectMcp(alice, connection.id); await rejected;
  const row = await ownMcpConnection(alice, connection.id, false);
  assert.equal(row.leaseId, null); assert.equal(row.credentialCiphertext, null);
});

test("mock Chat model completes search/read/answer with real MCP and no paid provider", async () => {
  const row = await connectMcp(alice, "synthetic");
  await grantMcpTools(alice, row.id, ["search", "read"], row.version);
  const config = await buildMcpChatTools({ userId: alice, connectionId: row.id,
    modelId: "gpt-5-6-sol", nativeSearch: false, signal: new AbortController().signal });
  config.setBudget({ inputTokens: 30_000, outputTokens: 1000, instructions: "Synthetic task" });
  let step = 0;
  const model = new MockLanguageModelV4({ doStream: async () => ({ stream: new ReadableStream({ start(controller) {
    const index = step++;
    if (index < 2) controller.enqueue({ type: "tool-call", toolCallId: `mock-${index}`,
      toolName: mcpToolName(row.id, index === 0 ? "search" : "read"), input: JSON.stringify(index === 0 ? { query: "Atlas" } : { id: "release" }) });
    else {
      controller.enqueue({ type: "text-start", id: "answer" });
      controller.enqueue({ type: "text-delta", id: "answer", delta: "Atlas: 30 October; Mina; blocker: billing QA. https://example.com/docs/release" });
      controller.enqueue({ type: "text-end", id: "answer" });
    }
    controller.enqueue({ type: "finish", finishReason: { unified: index < 2 ? "tool-calls" : "stop", raw: index < 2 ? "tool_use" : "stop" },
      usage: { inputTokens: { total: 100, noCache: 100, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 10, text: 10, reasoning: 0 } } });
    controller.close();
  } }) }) });
  const result = streamText({ model, prompt: "Read the Atlas checklist and name the owner and blocker.", tools: config.tools,
    stopWhen: stepCountIs(4), prepareStep: config.prepareStep, maxRetries: 0 });
  let answer = ""; for await (const chunk of result.textStream) answer += chunk;
  assert.match(answer, /Mina/); assert.equal(step, 3);
  assert.deepEqual(config.sources().map(s => s.url), ["https://example.com/docs/release"]);
  config.cancel();
});

test("server-side call ceiling refuses the seventh call without opening a socket", async () => {
  const row = await prisma.mcpConnection.findFirstOrThrow({ where: { userId: alice } });
  const config = await buildMcpChatTools({ userId: alice, connectionId: row.id, modelId: "gpt-5-6-sol", nativeSearch: false, signal: new AbortController().signal });
  const execute = config.tools[mcpToolName(row.id, "search")].execute!;
  const before = fixture.calls.length;
  for (let i = 0; i < 7; i++) {
    const result = await execute({ query: "missing" }, { toolCallId: `bound-${i}`, messages: [], context: {} });
    assert.equal((result as { status: string }).status, i < 6 ? "no_results" : "limit_reached");
  }
  assert.equal(fixture.calls.length - before, 6); config.cancel();
});

test("unknown writes survive reauthentication and require owner verification instead of replay", async () => {
  const row = await connectMcp(alice, "synthetic");
  await grantMcpTools(alice, row.id, ["create_note"], row.version);
  const own = await ownMcpConnection(alice, row.id);
  const proposal = await invokeMcpTool({ userId: alice, connectionId: row.id, version: own.version, name: "create_note", args: { text: "unknown" } });
  const queued = await invokeMcpTool({ userId: alice, connectionId: row.id, version: own.version, name: "create_note", args: { text: "previously proposed action" } });
  const controller = new AbortController(), writes = fixture.writes;
  const approval = decideMcpInvocation(alice, proposal.approvalId!, true, controller.signal);
  const rejected = assert.rejects(approval, { code: "outcome_unknown" });
  const deadline = Date.now() + 3000; while (fixture.writes === writes && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
  controller.abort(); await rejected;
  assert.equal((await prisma.mcpInvocation.findUniqueOrThrow({ where: { id: proposal.approvalId } })).state, "unknown");
  await assert.rejects(() => decideMcpInvocation(alice, queued.approvalId!, true), { code: "previous_outcome_unknown" });
  const reconnected = await connectMcp(alice, "synthetic");
  await grantMcpTools(alice, row.id, ["create_note"], reconnected.version);
  const next = await ownMcpConnection(alice, row.id);
  const again = () => invokeMcpTool({ userId: alice, connectionId: row.id, version: next.version, name: "create_note", args: { text: "unknown" } });
  await assert.rejects(again, { code: "previous_outcome_unknown" });
  await assert.rejects(() => confirmMcpOutcome(bob, proposal.approvalId!, "completed"), { code: "approval_unavailable" });
  await confirmMcpOutcome(alice, proposal.approvalId!, "completed");
  assert.equal(fixture.writes, writes + 1);
});

test("a reconnect started before disconnect cannot resurrect the revoked connection", async () => {
  const row = await ownMcpConnection(alice, (await prisma.mcpConnection.findFirstOrThrow({ where: { userId: alice } })).id);
  const requests = fixture.requests; fixture.pause();
  const reconnecting = connectMcp(alice, "synthetic");
  const rejected = assert.rejects(reconnecting, { code: "connection_changed" });
  try {
    const deadline = Date.now() + 3000; while (fixture.requests === requests && Date.now() < deadline) await new Promise(r => setTimeout(r, 10));
    await disconnectMcp(alice, row.id);
  } finally { fixture.resume(); }
  await rejected;
  assert.equal((await ownMcpConnection(alice, row.id, false)).status, "disconnected");
});
