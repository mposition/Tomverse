import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { before, after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { startMcpSyntheticServer } from "../fixtures/mcpSyntheticServer";
import { startMcpOAuth, completeMcpOAuth } from "@/lib/mcpConnectorOAuth";
import { decryptMcpSecret, disconnectMcp, encryptMcpSecret, grantMcpTools, listMcpConnections, ownMcpConnection } from "@/lib/mcpConnectorStore";
import { invokeMcpTool } from "@/lib/mcpConnectorExecution";
import { buildAccountDataExport } from "@/lib/accountDataExport";
import { assertMcpTestDatabase } from "../fixtures/mcpTestDatabase";
let fixture: Awaited<ReturnType<typeof startMcpSyntheticServer>>;
const alice = `mcp-oauth-${randomUUID()}`, bob = `mcp-oauth-${randomUUID()}`;
const callback = "http://127.0.0.1:3131/api/mcp/oauth/callback";
before(async () => {
  assertMcpTestDatabase();
  process.env.MCP_CONNECTOR_PREVIEW_ENABLED = "true"; process.env.MCP_CONNECTOR_SYNTHETIC_OAUTH = "true";
  process.env.OAUTH_TOKEN_ENCRYPTION_KEY = "synthetic-mcp-encryption-key-32-characters";
  process.env.NEXTAUTH_SECRET = "synthetic-mcp-audit-integrity-key";
  fixture = await startMcpSyntheticServer(); process.env.MCP_CONNECTOR_SYNTHETIC_PORT = String(fixture.port);
  await prisma.user.createMany({ data: [{ id: alice }, { id: bob }] });
});
after(async () => { await prisma.user.deleteMany({ where: { id: { in: [alice, bob] } } }); await fixture.close(); await prisma.$disconnect(); });
async function authorize(userId: string) {
  const started = await startMcpOAuth(userId, "synthetic", callback);
  assert.equal(started.status, "authorization_required"); assert.ok(started.authorizationUrl);
  const url = new URL(started.authorizationUrl);
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(url.searchParams.get("redirect_uri"), callback);
  assert.equal(url.searchParams.get("resource"), `http://127.0.0.1:${fixture.port}/mcp`);
  const response = await fetch(url, { redirect: "manual" }); assert.equal(response.status, 302);
  const location = new URL(response.headers.get("location")!);
  return { state: location.searchParams.get("state")!, code: location.searchParams.get("code")!, issuer: location.searchParams.get("iss")! };
}
test("SDK dynamic registration, PKCE code exchange and MCP connect keep secrets server-side", async () => {
  const flow = await authorize(alice);
  const before = await prisma.mcpOAuthFlow.findUniqueOrThrow({ where: { stateHash: createHash("sha256").update(flow.state).digest("hex") } });
  assert.ok(before.secretCiphertext?.startsWith("enc:v1:")); assert.notEqual(before.stateHash, flow.state);
  const connected = await completeMcpOAuth(alice, flow.state, flow.code, flow.issuer);
  assert.ok(connected.catalog.some(t => t.name === "read")); assert.equal(fixture.tokenExchanges, 1);
  assert.ok(fixture.oauthMcpRequests >= 2);
  const row = await prisma.mcpConnection.findUniqueOrThrow({ where: { id: connected.id } });
  assert.equal(decryptMcpSecret(row.credentialCiphertext), "synthetic-oauth-access");
  assert.ok(row.oauthCiphertext?.startsWith("enc:v1:"));
  await grantMcpTools(alice, row.id, ["read"], row.version);
  const active = await ownMcpConnection(alice, row.id);
  const read = await invokeMcpTool({ userId: alice, connectionId: row.id, version: active.version, name: "read", args: { id: "release" } });
  assert.equal(read.sources.length, 1);
  await assert.rejects(() => invokeMcpTool({ userId: alice, connectionId: row.id, version: active.version, name: "read", args: { id: "credential_echo" } }), { code: "credential_echo_refused" });
  const after = await prisma.mcpOAuthFlow.findUniqueOrThrow({ where: { id: before.id } });
  assert.equal(after.state, "used"); assert.equal(after.secretCiphertext, null);
  const publicData = JSON.stringify([await listMcpConnections(alice), (await buildAccountDataExport(alice)).data.plugin_authorizations]);
  for (const secret of ["synthetic-oauth-access", "secretCiphertext", "stateHash", "code_verifier"]) assert.equal(publicData.includes(secret), false);
  await assert.rejects(() => completeMcpOAuth(alice, flow.state, flow.code, flow.issuer), { code: "oauth_flow_expired" });
});
test("callbacks reject another account and issuer mismatch before token exchange", async () => {
  const flow = await authorize(bob), count = fixture.tokenExchanges;
  await assert.rejects(() => completeMcpOAuth(alice, flow.state, flow.code, flow.issuer), { code: "oauth_flow_expired" });
  await assert.rejects(() => completeMcpOAuth(bob, flow.state, flow.code, "http://169.254.169.254"), { code: "oauth_issuer_mismatch" });
  assert.equal(fixture.tokenExchanges, count);
  await completeMcpOAuth(bob, flow.state, flow.code, flow.issuer);
});
test("PKCE mismatch fails without a connection or saved secret", async () => {
  const flow = await authorize(bob);
  const row = await prisma.mcpOAuthFlow.findUniqueOrThrow({ where: { stateHash: createHash("sha256").update(flow.state).digest("hex") } });
  const secrets = JSON.parse(decryptMcpSecret(row.secretCiphertext)!); secrets.verifier = "incorrect-verifier";
  await prisma.mcpOAuthFlow.update({ where: { id: row.id }, data: { secretCiphertext: encryptMcpSecret(JSON.stringify(secrets)) } });
  await assert.rejects(() => completeMcpOAuth(bob, flow.state, flow.code, flow.issuer), { code: "oauth_authorization_failed" });
  assert.equal((await prisma.mcpOAuthFlow.findUniqueOrThrow({ where: { id: row.id } })).secretCiphertext, null);
});
test("expiry and disconnect invalidate outstanding authorization and account deletion cascades flows", async () => {
  const expired = await authorize(alice);
  await prisma.mcpOAuthFlow.updateMany({ where: { userId: alice, state: "pending" }, data: { expiresAt: new Date(0) } });
  await assert.rejects(() => completeMcpOAuth(alice, expired.state, expired.code, expired.issuer), { code: "oauth_flow_expired" });
  const pending = await authorize(alice);
  const row = await prisma.mcpConnection.findUniqueOrThrow({ where: { userId_serverId: { userId: alice, serverId: "synthetic" } } });
  await disconnectMcp(alice, row.id);
  await assert.rejects(() => completeMcpOAuth(alice, pending.state, pending.code, pending.issuer), { code: "oauth_flow_expired" });
  const disconnected = await prisma.mcpConnection.findUniqueOrThrow({ where: { id: row.id } });
  assert.equal(disconnected.credentialCiphertext, null); assert.equal(disconnected.oauthCiphertext, null);
  await prisma.user.delete({ where: { id: bob } });
  assert.equal(await prisma.mcpOAuthFlow.count({ where: { userId: bob } }), 0);
});
test("OAuth token redirects cannot forward credentials to a metadata endpoint", async () => {
  const flow = await authorize(alice), count = fixture.tokenExchanges;
  fixture.setOAuthRedirect(true);
  try { await assert.rejects(() => completeMcpOAuth(alice, flow.state, flow.code, flow.issuer), { code: "oauth_authorization_failed" }); }
  finally { fixture.setOAuthRedirect(false); }
  assert.equal(fixture.tokenExchanges, count);
  assert.equal((await prisma.mcpConnection.findUniqueOrThrow({ where: { userId_serverId: { userId: alice, serverId: "synthetic" } } })).status, "disconnected");
});
