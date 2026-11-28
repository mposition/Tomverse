import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { resolveChatRouteSession } from "@/lib/chatRouteSession";
import { mcpProviderCatalogResponse } from "@/lib/mcpProviderCatalogResponse";

export const dynamic = "force-dynamic";

/**
 * The platform catalogue of the Plugins page, for a client that does not carry it. It holds no account data, but it is read
 * with a sign-in (a Desktop bearer or a browser session) and the same rate limit as other reads, and a Desktop bearer reaches it
 * only while the Desktop plugins switch is on (desktopReadApiRoute).
 */
export async function GET(request: Request) {
  try {
    const auth = await resolveChatRouteSession(request);
    if (auth.response) return auth.response;
    if (!auth.session?.user?.id) return Response.json({ code: "sign_in_required" }, { status: 401, headers: { "Cache-Control": "no-store" } });
    await consumeApiRateLimit(request, auth.session.user.id, "mcp-provider-catalog", { minute: 60, day: 1500 });
    return mcpProviderCatalogResponse(request.headers.get("if-none-match"));
  } catch (error) {
    return apiSecurityResponse(error) ?? Response.json({ code: "connector_request_failed" }, { status: 502, headers: { "Cache-Control": "no-store" } });
  }
}
