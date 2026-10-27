import "server-only";
import { z } from "zod";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";
import { McpConnectorError } from "@/lib/mcpConnectorPolicy";

export async function mcpApi(request: Request, run: (userId: string) => Promise<unknown>) {
  try {
    const auth = await resolveChatRouteSession(request);
    if (auth.response) return auth.response;
    if (!auth.session?.user?.id) return Response.json({ code: "sign_in_required" }, { status: 401 });
    await consumeApiRateLimit(request, auth.session.user.id, "mcp-connectors", { minute: 90, day: 1500 });
    return Response.json(await run(auth.session.user.id), { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    const response = apiSecurityResponse(error); if (response) return response;
    const code = error instanceof McpConnectorError ? error.code : error instanceof z.ZodError ? "invalid_request" : "connector_request_failed";
    return Response.json({ code }, { status: error instanceof McpConnectorError ? error.status : error instanceof z.ZodError ? 400 : 502,
      headers: { "Cache-Control": "no-store" } });
  }
}
