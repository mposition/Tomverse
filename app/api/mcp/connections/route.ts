import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { mcpApi } from "@/lib/mcpConnectorApi";
import { mcpPreviewEnabled, mcpServers } from "@/lib/mcpConnectorPolicy";
import { connectMcp, listMcpConnections } from "@/lib/mcpConnectorStore";
import { listMcpInvocations } from "@/lib/mcpConnectorExecution";
export const dynamic = "force-dynamic";
export function GET(request: Request) {
  return mcpApi(request, async userId => {
    if (!mcpPreviewEnabled()) return { enabled: false, servers: [], connections: [], invocations: [] };
    const connections = await listMcpConnections(userId);
    return { enabled: true, servers: mcpServers().map(({ id, name, auth, url }) => ({ id, name, auth, origin: new URL(url).origin })),
      connections, invocations: await listMcpInvocations(userId) };
  });
}
export function POST(request: Request) {
  return mcpApi(request, async userId => {
    const body = await readLimitedJson(request, 5000, z.object({ serverId: z.string().max(40), credential: z.string().max(4096).optional() }).strict());
    return connectMcp(userId, body.serverId, body.credential, request.signal);
  });
}
