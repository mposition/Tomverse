export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { readAmuxOwnerQueue } from "@/lib/amux/adminOwnerQueueRead";
import { amuxOwnerQueueWithDmSettlements, amuxOwnerQueueWithDmStatus, amuxOwnerQueueWithEngineeringItems }
  from "@/lib/amux/ownerQueueCore";
import { readAmuxOwnerQueueDm } from "@/lib/amux/ownerQueueDmRead";
import { readAmuxOwnerQueueDmStatus } from "@/lib/amux/ownerQueueDmStatusRead";
import type { AmuxOwnerQueueDmSettlement } from "@/lib/amux/ownerQueueDmCore";
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
 *
 * Each card also carries the Decision Maker's settlement of it and where its
 * card stands (docs/policy/amux-decision-maker.md §0a-5). The settlement's
 * state is for any admin; the Decision Maker's proposal and rationale are
 * bodies, so they are read only for `ops:write`, as the request drawer's are
 * (others get `restricted`). "Confirm as proposed" is not a route here: it
 * posts to the existing judgment route (`ops:write`, recent step-up). A read of
 * either part that fails leaves the queue as it was: the cards say so one by
 * one.
 *
 * Each card also says which Decision Maker path holds it, where the Decision Maker stands on it, and the read says
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
    const settlements: Map<string, AmuxOwnerQueueDmSettlement> = await readAmuxOwnerQueueDm(
      read.items, hasAdminPermission(session, "ops:write")).catch((error) => {
      console.error("admin AMUX owner queue Decision Maker read failed", error);
      return new Map(read.items.flatMap((item): Array<[string, AmuxOwnerQueueDmSettlement]> =>
        item.escalationId === null ? [] : [[item.taskId, { status: "unread" }]]));
    });
    // Which Decision Maker path holds each card, and the relay's last call
    // (owner decision 2026-11-14). A failed read leaves the column out.
    const dmStatus = await readAmuxOwnerQueueDmStatus(read.items, new Date(read.generatedAt)).catch((error) => {
      console.error("admin AMUX owner queue Decision Maker status read failed", error);
      return null;
    });
    return NextResponse.json(amuxOwnerQueueWithDmStatus(
      amuxOwnerQueueWithDmSettlements(amuxOwnerQueueWithEngineeringItems(read, engineering), settlements), dmStatus), {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("admin AMUX owner queue read failed", error);
    return NextResponse.json({ error: "Server error." }, { status: 500 });
  }
}
