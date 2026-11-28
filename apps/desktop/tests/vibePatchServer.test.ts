import assert from "node:assert/strict";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { z } from "zod";
import { patchSchema } from "../../tomverse-cli/src/tools";
import { nativePatchName, type NativePatchTool } from "../src/host/native-patches";
import { startNativeMcpServer } from "../src/host/native-mcp-server";

test("Vibe patch transport refuses a changed proposal and a repeated tool call ID", async () => {
  const args = { edits: [{ path: "note.txt", action: "create", content: "Approved content." }] };
  const invoked: string[] = [];
  const tool: NativePatchTool = {
    spec: { type: "function", name: nativePatchName, description: "Open the Desktop approval.", inputSchema: z.toJSONSchema(patchSchema) },
    invoke: async (id, input, signal, verify) => {
      assert.deepEqual(input, args);
      assert.equal(await verify?.({ approvalId: id, toolCallId: id, toolName: "apply_patch", input }, signal), true);
      invoked.push(id);
      return { success: true, text: "Completed." };
    },
  };
  const controller = new AbortController();
  const server = await startNativeMcpServer({ patch: tool }, controller.signal, async () => ({
    input: args, id: "effect-one", canApply: () => true,
  }));
  const client = new Client({ name: "desktop-test", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(server.descriptor.url), {
      requestInit: { headers: Object.fromEntries(server.descriptor.headers.map(({ name, value }) => [name, value])) },
    }));
    const call = (input: typeof args) => client.callTool({ name: nativePatchName, arguments: input });
    assert.equal((await call({ edits: [{ ...args.edits[0]!, content: "Changed after proposal." }] })).isError, true);
    assert.deepEqual(invoked, []);
    assert.equal((await call(args)).isError, false);
    assert.equal((await call(args)).isError, true);
    assert.deepEqual(invoked, ["effect-one"]);
  } finally {
    await client.close();
    controller.abort();
    await server.close();
  }
});
