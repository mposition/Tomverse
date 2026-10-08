export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { consumeApiRateLimit, apiSecurityResponse } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readAmuxV4DerivedUnitPage } from
  "@/lib/amux/ideaDerivedUnitReadService";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "not_found" },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden" },
        { status: 403, headers: noStore });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-derived-units", { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const chunkText = params.get("chunkIndex") ?? "";
    if (params.getAll("ideaId").length !== 1 ||
        params.getAll("chunkIndex").length !== 1 ||
        params.getAll("afterId").length > 1 ||
        params.size > 3 || !/^(0|[1-9][0-9]*)$/.test(chunkText)) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const result = await readAmuxV4DerivedUnitPage(session, {
      ideaId: params.get("ideaId") ?? "", chunkIndex: Number(chunkText),
      afterId: params.get("afterId"),
    });
    return NextResponse.json(result, { headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "derived_units_unavailable" },
      { status: 503, headers: noStore });
  }
}
