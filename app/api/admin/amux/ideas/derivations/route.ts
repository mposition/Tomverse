export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication,
  isAdminReauthenticationError } from "@/lib/adminReauthentication";
import { authOptions } from "@/lib/auth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { AmuxIdeaDerivationError,
  readAmuxV4Derivation } from "@/lib/amux/ideaDerivationService";

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
      "admin-amux-v4-derivation-read", { minute: 10, day: 100 });
    const requestId = new URL(request.url).searchParams.get("requestId") ?? "";
    const result = await readAmuxV4Derivation(session, requestId);
    return NextResponse.json(result, { status: result.state === "not_found" ? 404 : 200,
      headers: noStore });
  } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    if (error instanceof AmuxIdeaDerivationError) {
      return NextResponse.json({ error: error.code },
        { status: error.code === "not_found" ? 404 : 503, headers: noStore });
    }
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "derivation_read_unavailable" },
      { status: 503, headers: noStore });
  }
}
