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
import { configureV22AutoPromotion,
  readV22AutoPromotionControl } from "@/lib/amux/v22AutoPromotionService";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const bodySchema = z.object({ policyVersion: z.literal(22),
  active: z.boolean(), expectedAuditLogId: z.string().min(1).max(128).nullable(),
}).strict();

async function requireOwner(stepUp: boolean) {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return { response: Response.json({ error: "Not found." },
      { status: 404, headers: noStore }) } as const;
  }
  if (getAdminRole(session) !== "owner") {
    return { response: Response.json({ error: "Forbidden." },
      { status: 403, headers: noStore }) } as const;
  }
  if (stepUp) {
    try { await assertRecentAdminAuthentication(session); }
    catch (error) {
      if (isAdminReauthenticationError(error)) return {
        response: Response.json({ error:
          "Recent administrator authentication is required.",
          code: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore }),
      } as const;
      throw error;
    }
  }
  return { session } as const;
}

export async function GET() {
  const auth = await requireOwner(false);
  if ("response" in auth) return auth.response;
  return Response.json(await readV22AutoPromotionControl(),
    { headers: noStore });
}

export async function POST(request: Request) {
  try {
    const auth = await requireOwner(true);
    if ("response" in auth) return auth.response;
    if (!hasValidMutationOrigin(request)) {
      return Response.json({ error: "origin_refused" },
        { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, auth.session.user.id,
      "admin-amux-v22-auto-promotion", { minute: 5, day: 20 });
    const body = await readLimitedJson(request, 1024, bodySchema);
    const result = await configureV22AutoPromotion({ session: auth.session,
      request, active: body.active,
      expectedAuditLogId: body.expectedAuditLogId });
    return Response.json(result, { headers: noStore });
  } catch (error) {
    if (error instanceof BoardImportError) {
      return Response.json({ error: error.code },
        { status: error.httpStatus, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    throw error;
  }
}
