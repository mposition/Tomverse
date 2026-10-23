export const dynamic = "force-dynamic";

import type { Session } from "next-auth";
import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication, isAdminReauthenticationError } from
  "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readAmuxSessionReviewForOwner } from "@/lib/amux/ideaSessionReviewRead";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function owner(): Promise<Session | NextResponse> {
  const session = await getServerSession(authOptions);
  if (!session?.user?.id || !isAdminSession(session)) {
    return NextResponse.json({ error: "Not found." }, { status: 404, headers: noStore });
  }
  if (getAdminRole(session) !== "owner") {
    return NextResponse.json({ error: "Forbidden." }, { status: 403, headers: noStore });
  }
  try { await assertRecentAdminAuthentication(session); } catch (error) {
    if (isAdminReauthenticationError(error)) {
      return NextResponse.json({ error: "ADMIN_REAUTHENTICATION_REQUIRED" },
        { status: 428, headers: noStore });
    }
    throw error;
  }
  return session;
}

/** Why a session idea's analysis answer made no plan: read only for its
 * owner, on demand, while the answer is inside its seven-day retention. */
export async function GET(request: Request): Promise<Response> {
  try {
    const session = await owner();
    if (session instanceof NextResponse) return session;
    await consumeApiRateLimit(request, session.user!.id!,
      "admin-amux-v19-session-review", { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const ideaId = params.get("ideaId");
    if (params.size !== 1 || params.getAll("ideaId").length !== 1 ||
        !ideaId || !UUID.test(ideaId)) {
      return NextResponse.json({ error: "schema_rejected" },
        { status: 400, headers: noStore });
    }
    const review = await readAmuxSessionReviewForOwner(session.user!.id!, ideaId);
    if (!review) return NextResponse.json({ error: "not_found" },
      { status: 404, headers: noStore });
    return NextResponse.json({ review }, { headers: noStore });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    console.error("AMUX v19 session review unavailable");
    return NextResponse.json({ error: "session_review_unavailable" },
      { status: 503, headers: noStore });
  }
}
