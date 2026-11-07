export const dynamic = "force-dynamic";
export const runtime = "nodejs";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { readAgentOfficeBriefingStatus, requestAgentOfficeBriefing } from "@/lib/agentOfficeBriefing";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const headers = { "Cache-Control": "private, no-store, max-age=0", "X-Content-Type-Options": "nosniff" };
const schema = z.object({ locale: z.enum(["en", "ko"]) }).strict();

/**
 * The office's AI briefing, for the owner only (lib/agentOfficeBriefing.ts).
 * GET reads the switch, today's count and the last briefing; POST asks for a
 * new one, which may be a paid model call within the day's limit.
 */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
      return Response.json({ error: "not_found" }, { status: 404, headers });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-office-briefing-read", { minute: 20, day: 2_000 });
    return Response.json(await readAgentOfficeBriefingStatus(), { headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    return Response.json({ error: "briefing_unavailable" }, { status: 503, headers });
  }
}

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session) || getAdminRole(session) !== "owner") {
      return Response.json({ error: "not_found" }, { status: 404, headers });
    }
    if (!hasValidMutationOrigin(request)) return Response.json({ error: "forbidden" }, { status: 403, headers });
    try {
      await assertRecentAdminAuthentication(session);
    } catch (error) {
      if (isAdminReauthenticationError(error)) {
        return Response.json({ code: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers });
      }
      throw error;
    }
    const body = await readLimitedJson(request, 256, schema);
    await consumeApiRateLimit(request, session.user.id, "admin-office-briefing", { minute: 4, day: 100 });
    const result = await requestAgentOfficeBriefing({ session, request, locale: body.locale });
    const status =
      result.kind === "done" || result.kind === "reused"
        ? 200
        : result.kind === "failed"
          ? 502
          : result.kind === "off" || result.kind === "model_unavailable"
            ? 503
            : 409;
    return Response.json(result, { status, headers });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) return security;
    return Response.json({ error: "briefing_unavailable" }, { status: 503, headers });
  }
}
