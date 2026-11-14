export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { isAdminSession } from "@/lib/adminAuth";
import { readAmuxOwnerQueue } from "@/lib/amux/adminOwnerQueueRead";
import { amuxOwnerQueueWithDm, amuxOwnerQueueWithEngineeringItems } from "@/lib/amux/ownerQueueCore";
import { readAmuxOwnerQueueDm } from "@/lib/amux/ownerQueueDmRead";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { authOptions } from "@/lib/auth";
import { readEngineeringAgentCardItems } from "@/lib/engineeringAgentConsoleRead";

/**
 * The cards that wait on the owner, read only. Same audience as the routing
 * report whose escalation list this replaces on the "Waiting on me" tab: any
 * admin role may read it. Deciding a card still takes `ops:write` in the review
 * routes, and answering a worker question takes the owner in its own route.
 * Each card carries its open engineering items (T2 drafts, state mismatches),
 * which Admin › Engineering › Decisions reads with the same admin
 * authentication; deciding them takes `engineering-agent:write` in those routes.
 * Each card also says where the Decision Maker stands on it, and the read says
 * when the host's DM relay last called; asking the DM takes `ops:write` in
 * ./dm-request.
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
    const read = await readAmuxOwnerQueue();
    const engineering = await readEngineeringAgentCardItems(read.items.map((item) => item.taskId)).catch((error) => {
      console.error("admin AMUX owner queue engineering items read failed", error);
      return null;
    });
    // Where the Decision Maker stands on each card, and the relay's last call
    // (owner decision 2026-11-14). A failed read leaves the column out.
    const dm = await readAmuxOwnerQueueDm(read.items, new Date(read.generatedAt)).catch((error) => {
      console.error("admin AMUX owner queue Decision Maker read failed", error);
      return null;
    });
    return NextResponse.json(amuxOwnerQueueWithDm(amuxOwnerQueueWithEngineeringItems(read, engineering), dm), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("admin AMUX owner queue read failed", error);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
