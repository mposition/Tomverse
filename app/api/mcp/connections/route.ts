import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { mcpApi } from "@/lib/mcpConnectorApi";
import { isCustomMcpServerId, mcpCustomServersEnabled, mcpPreviewEnabled, mcpServers, splitMcpScope } from "@/lib/mcpConnectorPolicy";
import { connectMcp, forgetUnusedCustomMcpServer, listMcpConnections, registerCustomMcpServer } from "@/lib/mcpConnectorStore";
import { customMcpServerInputSchema, listCustomMcpServers } from "@/lib/mcpCustomServers";
import { listMcpInvocations } from "@/lib/mcpConnectorExecution";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return mcpApi(request, async userId => {
    if (!mcpPreviewEnabled()) return { enabled: false, customEnabled: false, servers: [], connections: [], invocations: [] };
    const connections = await listMcpConnections(userId);
    const servers = [...mcpServers(), ...await listCustomMcpServers(userId)];
    return { enabled: true, customEnabled: mcpCustomServersEnabled(),
      servers: servers.map(({ id, name, auth, url, oauth }) => ({ id, name, auth, origin: new URL(url).origin, ...(isCustomMcpServerId(id) ? { custom: true } : {}),
        ...(oauth?.selectableScopes ? { scopes: oauth.selectableScopes, defaultScopes: splitMcpScope(oauth.scope) } : {}) })),
      connections, invocations: await listMcpInvocations(userId) };
  });
}
const connectSchema = z.union([
  z.object({ serverId: z.string().max(40), credential: z.string().max(4096).optional() }).strict(),
  z.object({ custom: customMcpServerInputSchema, credential: z.string().max(4096).optional() }).strict(),
]);
export function POST(request: Request) {
  return mcpApi(request, async userId => {
    const body = await readLimitedJson(request, 8000, connectSchema);
    if ("serverId" in body) return connectMcp(userId, body.serverId, body.credential, request.signal);
    const { server, created } = await registerCustomMcpServer(userId, body.custom, request.signal);
    try { return await connectMcp(userId, server.id, body.credential, request.signal); }
    catch (error) { if (created) await forgetUnusedCustomMcpServer(userId, server.id).catch(() => {}); throw error; }
  });
}
