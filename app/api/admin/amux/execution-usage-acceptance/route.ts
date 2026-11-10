export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit,
  readLimitedJson } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { acceptAmuxV22AttemptUnknownUsage } from "@/lib/amux/v22AttemptUsageAcceptance";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

/**
 * Owner action (owner decision 2026-11-10): accept that one ended v22
 * attempt's CLI usage stays unknown, so the worker usage gate stops refusing
 * its worker. The attempt's reserved cap and cost are unchanged.
 */
const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9:_-]+$/);
const bodySchema = z.object({ taskId: id, attemptId: id,
  confirm: z.literal("accept_unknown_usage") }).strict();

export async function POST(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return Response.json({ error: "Not found." }, { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return Response.json({ error: "Forbidden." }, { status: 403, headers: noStore });
    }
    try { await assertRecentAdminAuthentication(session); }
    catch (error) {
      if (isAdminReauthenticationError(error)) return Response.json({ error:
        "Recent administrator authentication is required.",
        code: "ADMIN_REAUTHENTICATION_REQUIRED" }, { status: 428, headers: noStore });
      throw error;
    }
    if (!hasValidMutationOrigin(request)) {
      return Response.json({ error: "origin_refused" }, { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-execution-usage-acceptance", { minute: 10, day: 60 });
    const body = await readLimitedJson(request, 512, bodySchema);
    return Response.json(await acceptAmuxV22AttemptUnknownUsage({ session, request,
      taskId: body.taskId, attemptId: body.attemptId }), { headers: noStore });
  } catch (error) {
    if (error instanceof BoardImportError) return Response.json({ error: error.code },
      { status: error.httpStatus, headers: noStore });
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    throw error;
  }
}
