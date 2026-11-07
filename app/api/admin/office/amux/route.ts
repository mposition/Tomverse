export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getServerSession } from "next-auth/next";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { readAgentOfficeAmuxPulse } from "@/lib/agentOfficeLiveRead";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };

/**
 * The office's fifteen-second re-read of the AMUX room, for any administrator,
 * as the page reads it: the card a worker holds and its usage only for the
 * owner. Read only; there is no other method.
 */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "not_found" }, { status: 404, headers });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-office-amux-pulse", { minute: 12, day: 7_000 });
    const pulse = await readAgentOfficeAmuxPulse(new Date(), { owner: getAdminRole(session) === "owner" });
    return Response.json(pulse, { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", headers["Cache-Control"]);
      return security;
    }
    return Response.json({ error: "office_amux_unavailable" }, { status: 503, headers });
  }
}
