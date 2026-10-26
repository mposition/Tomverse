import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { mcpApi } from "@/lib/mcpConnectorApi";
import { confirmMcpOutcome, decideMcpInvocation } from "@/lib/mcpConnectorExecution";
export function POST(request: Request, context: { params: Promise<{ invocationId: string }> }) {
  return mcpApi(request, async userId => {
    const body = await readLimitedJson(request, 100, z.union([z.object({ approve: z.boolean() }).strict(),
      z.object({ verifiedOutcome: z.enum(["completed", "not_executed"]) }).strict()]));
    const id = (await context.params).invocationId;
    return "approve" in body ? decideMcpInvocation(userId, id, body.approve, request.signal) : confirmMcpOutcome(userId, id, body.verifiedOutcome);
  });
}
