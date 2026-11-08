export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { isAdminSession } from "@/lib/adminAuth";
import { readAmuxOwnerQueue } from "@/lib/amux/adminOwnerQueueRead";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";

/**
 * The cards that wait on the owner, read only. Same audience as the routing
 * report whose escalation list this replaces on the "Waiting on me" tab: any
 * admin role may read it. Deciding a card still takes `ops:write` in the review
 * routes, and answering a worker question takes the owner in its own route.
 */
export async function GET(request: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-owner-queue", {
      minute: 40,
      day: 2_000,
    });
    return NextResponse.json(await readAmuxOwnerQueue(), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("admin AMUX owner queue read failed", error);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
