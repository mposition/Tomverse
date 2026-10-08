export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readAmuxV4UnitDecision } from "@/lib/amux/ideaUnitDecisionStore";

const noStore = { "Cache-Control": "private, no-store, max-age=0" };

/** Read-back remains available even while every v4 registration write latch
 * is closed. An absent decision is never proof that a lost POST did not commit. */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ state: "not_visible", retryWrite: false },
        { status: 404, headers: noStore });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json({ error: "forbidden", retryWrite: false },
        { status: 403, headers: noStore });
    }
    await consumeApiRateLimit(request, session.user.id,
      "admin-amux-v4-unit-decision-read", { minute: 10, day: 100 });
    const params = new URL(request.url).searchParams;
    const decisionId = params.get("decisionId");
    const prepareRequestId = params.get("prepareRequestId");
    if ((decisionId === null) === (prepareRequestId === null) ||
        (decisionId !== null && !/^[A-Za-z0-9_-]{8,80}$/.test(decisionId)) ||
        (prepareRequestId !== null && !/^[a-f0-9-]{36}$/.test(prepareRequestId))) {
      return NextResponse.json({ error: "schema_rejected", retryWrite: false },
        { status: 400, headers: noStore });
    }
    const result = await readAmuxV4UnitDecision(session,
      decisionId !== null ? { decisionId } : { prepareRequestId: prepareRequestId! });
    return NextResponse.json(result, { status: result.state === "not_visible" ? 404 :
      result.state === "integrity_unavailable" ? 503 : 200, headers: noStore });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) { security.headers.set("Cache-Control", noStore["Cache-Control"]); return security; }
    return NextResponse.json({ error: "read_unavailable", retryWrite: false },
      { status: 503, headers: noStore });
  }
}
