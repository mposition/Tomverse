import { z } from "zod";
import { mcpApi } from "@/lib/mcpConnectorApi";
import { completeMcpOAuth } from "@/lib/mcpConnectorOAuth";
import { getPublicAppOrigin } from "@/lib/publicUrl";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  const response = await mcpApi(request, async userId => {
    const params = new URL(request.url).searchParams;
    const state = z.string().regex(/^[A-Za-z0-9_-]{43}$/).parse(params.get("state"));
    const code = z.string().min(1).max(4096).parse(params.get("code"));
    const issuer = z.string().url().max(2048).optional().parse(params.get("iss") ?? undefined);
    await completeMcpOAuth(userId, state, code, issuer, request.signal);
    return { connected: true };
  });
  // Strip the authorization code/state from the address bar and referrer.
  return new Response(null, { status: 303, headers: {
    Location: `${getPublicAppOrigin(request)}/plugins?oauth=${response.ok ? "connected" : "failed"}`,
    "Cache-Control": "no-store", "Referrer-Policy": "no-referrer",
  } });
}
