export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { isAdminReauthenticationError,
  assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { AmuxV4TaskCatalogApprovalError,
  readAmuxV4TaskCatalogApproval } from
  "@/lib/amux/v4TaskCostCatalogApprovalService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** Exact-ID readback resolves lost responses but never authorizes a retry. */
export async function GET(request: Request, context: {
  params: Promise<{ approvalId: string }>;
}) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session) ||
        getAdminRole(session) !== "owner")
      return NextResponse.json({ error: "not_found" },
      { status: 404, headers: noStore });
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-task-catalog-readback", { minute: 10, day: 100 });
    const { approvalId } = await context.params;
    if (!/^[a-f0-9-]{36}$/.test(approvalId)) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    return NextResponse.json(await readAmuxV4TaskCatalogApproval(
      session, approvalId), { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxV4TaskCatalogApprovalError) {
      return NextResponse.json({ error: error.code },
        { status: error.code === "forbidden" ? 403 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "readback_unavailable" },
      { status: 503, headers: noStore });
  }
}
