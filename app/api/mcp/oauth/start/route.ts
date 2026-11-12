import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { mcpApi } from "@/lib/mcpConnectorApi";
import { startMcpOAuth } from "@/lib/mcpConnectorOAuth";
import { McpConnectorError } from "@/lib/mcpConnectorPolicy";
import { forgetUnusedCustomMcpServer, registerCustomMcpServer } from "@/lib/mcpConnectorStore";
import { customMcpServerInputSchema } from "@/lib/mcpCustomServers";
import { getPublicAppOrigin } from "@/lib/publicUrl";
export const dynamic = "force-dynamic";
const startSchema = z.union([z.object({ serverId: z.string().max(40) }).strict(), z.object({ custom: customMcpServerInputSchema }).strict()]);
export function POST(request: Request) {
  return mcpApi(request, async userId => {
    const body = await readLimitedJson(request, 4000, startSchema);
    const redirectUri = `${getPublicAppOrigin(request)}/api/mcp/oauth/callback`;
    if ("serverId" in body) return startMcpOAuth(userId, body.serverId, redirectUri, request.signal);
    if (body.custom.auth !== "oauth") throw new McpConnectorError("invalid_request");
    // An abandoned authorization leaves the row unused; registration prunes it later.
    const { server, created } = await registerCustomMcpServer(userId, body.custom, request.signal);
    try { return await startMcpOAuth(userId, server.id, redirectUri, request.signal); }
    catch (error) { if (created) await forgetUnusedCustomMcpServer(userId, server.id).catch(() => {}); throw error; }
  });
}
