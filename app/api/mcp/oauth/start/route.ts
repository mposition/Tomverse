import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { mcpApi } from "@/lib/mcpConnectorApi";
import { startMcpOAuth } from "@/lib/mcpConnectorOAuth";
import { getPublicAppOrigin } from "@/lib/publicUrl";
export const dynamic = "force-dynamic";
export function POST(request: Request) {
  return mcpApi(request, async userId => {
    const body = await readLimitedJson(request, 16_000, z.object({ serverId: z.string().max(40),
      scopes: z.array(z.string().min(1).max(200)).min(1).max(64).optional() }).strict());
    return startMcpOAuth(userId, body.serverId, `${getPublicAppOrigin(request)}/api/mcp/oauth/callback`, request.signal, body.scopes);
  });
}
