import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { mcpApi } from "@/lib/mcpConnectorApi";
import { disconnectMcp, grantMcpTools } from "@/lib/mcpConnectorStore";
type Context = { params: Promise<{ connectionId: string }> };
export function PATCH(request: Request, context: Context) {
  return mcpApi(request, async userId => {
    const { connectionId } = await context.params;
    const body = await readLimitedJson(request, 5000, z.object({ tools: z.array(z.string().min(1).max(128)).max(32), version: z.number().int().positive() }).strict());
    await grantMcpTools(userId, connectionId, body.tools, body.version);
    return { status: "saved" };
  });
}
export function DELETE(request: Request, context: Context) {
  return mcpApi(request, async userId => {
    await disconnectMcp(userId, (await context.params).connectionId);
    return { status: "disconnected" };
  });
}
