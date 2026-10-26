import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { startMcpSyntheticServer, SYNTHETIC_GOLD } from "./fixtures/mcpSyntheticServer";
import { publicMcpAddress, validateMcpEndpoint, withMcpClient } from "@/lib/mcpConnectorClient";
import { mcpServer, mcpServers } from "@/lib/mcpConnectorPolicy";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";

let server: Awaited<ReturnType<typeof startMcpSyntheticServer>>;
before(async () => {
  server = await startMcpSyntheticServer();
  process.env.MCP_CONNECTOR_PREVIEW_ENABLED = "true";
  process.env.MCP_CONNECTOR_SYNTHETIC_PORT = String(server.port);
});
after(async () => { await server.close(); });
test("official SDK initializes, lists, searches, reads and closes over real Streamable HTTP", async () => {
  await withMcpClient({ server: mcpServer("synthetic") }, async (client, signal) => {
    const list = await client.listTools({}, { signal });
    assert.deepEqual(list.tools.map(t => t.name).sort(), ["create_note", "dangerous_delete", "read", "search"]);
    const search = await client.callTool({ name: "search", arguments: { query: "Atlas" } }, CallToolResultSchema, { signal });
    assert.equal((CallToolResultSchema.parse(search) as { content: Array<{ type: string }> }).content[0].type, "resource_link");
    const read = await client.callTool({ name: "read", arguments: { id: "release" } }, CallToolResultSchema, { signal });
    assert.equal((CallToolResultSchema.parse(read) as { content: Array<{ type: string }> }).content[0].type, "resource");
    const serialized = JSON.stringify(read);
    for (const expected of Object.values(SYNTHETIC_GOLD)) assert.ok(serialized.includes(expected));
  });
});
test("unsafe addresses and production loopback are refused", () => {
  for (const ip of ["127.0.0.1", "169.254.169.254", "10.1.2.3", "::1", "::ffff:127.0.0.1", "fd00::1", "2001:db8::1", "100.64.0.1"]) assert.equal(publicMcpAddress(ip), false, ip);
  assert.equal(publicMcpAddress("8.8.8.8"), true);
  assert.throws(() => validateMcpEndpoint({ ...mcpServer("synthetic"), id: "arbitrary" }));
  assert.deepEqual(mcpServers({ NODE_ENV: "production", MCP_CONNECTOR_PREVIEW_ENABLED: "true", MCP_CONNECTOR_SYNTHETIC_PORT: String(server.port) }), []);
});
test("response byte ceiling, remote errors and cancellation survive the protocol boundary", async () => {
  await assert.rejects(() => withMcpClient({ server: mcpServer("synthetic"), token: "expired" }, async () => {}));
  await assert.rejects(() => withMcpClient({ server: mcpServer("synthetic"), token: "redirect" }, async () => {}));
  await assert.rejects(() => withMcpClient({ server: mcpServer("synthetic") },
    (client, signal) => client.callTool({ name: "search", arguments: { query: "oversized" } }, undefined, { signal })));
  const result = await withMcpClient({ server: mcpServer("synthetic") },
    (client, signal) => client.callTool({ name: "search", arguments: { query: "error" } }, undefined, { signal }));
  assert.equal(result.isError, true);
  await assert.rejects(() => withMcpClient({ server: mcpServer("synthetic"), signal: AbortSignal.timeout(100) },
    (client, signal) => client.callTool({ name: "search", arguments: { query: "timeout" } }, undefined, { signal })));
});
