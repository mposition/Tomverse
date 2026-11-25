// A stdio MCP server for tests, built with the MCP SDK. Behaviour comes from environment variables:
//   FIXTURE_NAME   the server name (default "fixture")
//   FIXTURE_MODE   "hang" never answers the handshake; "crash" exits at once
//   FIXTURE_MARKER a file this process appends one line to when it starts (to see whether a server was launched)
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

if (process.env.FIXTURE_MARKER) appendFileSync(process.env.FIXTURE_MARKER, `started ${process.pid}\n`);
if (process.env.FIXTURE_MODE === "crash") process.exit(3);
if (process.env.FIXTURE_MODE === "hang") setInterval(() => undefined, 1000);
else {
    const server = new McpServer({ name: process.env.FIXTURE_NAME ?? "fixture", version: "1.0.0" });
    server.registerTool("echo", { description: "Returns its text.", inputSchema: { text: z.string() } }, async ({ text }) => ({ content: [{ type: "text", text }] }));
    server.registerTool("pid", { description: "Returns the process id." }, async () => ({ content: [{ type: "text", text: String(process.pid) }] }));
    server.registerTool("env", { description: "Returns the environment of this process." }, async () => ({
        content: [{ type: "text", text: JSON.stringify(process.env) }],
    }));
    server.registerTool("sleep", { description: "Waits.", inputSchema: { ms: z.number() } }, async ({ ms }) => {
        await new Promise((resolve) => setTimeout(resolve, ms));
        return { content: [{ type: "text", text: "slept" }] };
    });
    server.registerTool("fail", { description: "Reports an error result." }, async () => ({ isError: true, content: [{ type: "text", text: "it failed" }] }));
    await server.connect(new StdioServerTransport());
}
