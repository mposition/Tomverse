export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";

import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { requestAmuxOwnerQueueDm } from "@/lib/amux/ownerQueueDmRequestService";
import { authOptions } from "@/lib/auth";
import { hasValidMutationOrigin } from "@/lib/requestOrigin";

// The owner queue's "ask the Decision Maker" button (owner decision 2026-11-14,
// lib/amux/ownerQueueDmRequestService.ts):
//
//   { taskId, source: "result_review" | "settlement", action: "resend" | "request", sourceId }
//
// It files nothing with the Decision Maker itself: the relay files the card on
// its next tick, and the answer stays a proposal the owner confirms. `ops:write`,
// the same permission every escalation and proposal route checks.

const noStore = { "Cache-Control": "private, no-store, max-age=0" };
const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: noStore });

const id = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const body = z.object({
  taskId: id,
  source: z.enum(["result_review", "settlement"]),
  action: z.enum(["resend", "request"]),
  sourceId: id,
}).strict();

export async function POST(request: Request): Promise<Response> {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) return json({ error: "not_found" }, 404);
    if (!hasAdminPermission(session, "ops:write") || !hasValidMutationOrigin(request)) {
      return json({ error: "forbidden" }, 403);
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return json({ error: "content_type_refused" }, 415);
    }
    await consumeApiRateLimit(request, session.user.id, "admin-amux-owner-queue-dm-request",
      { minute: 10, day: 200 });
    const parsed = await readLimitedJson(request, 1_024, body);
    const result = await requestAmuxOwnerQueueDm({ session, request, ...parsed });
    if (result.outcome === "refused") return json({ error: "refused", reason: result.reason }, 409);
    return json({ status: "requested", settlementId: result.settlementId });
  } catch (error) {
    const security = apiSecurityResponse(error);
    if (security) {
      security.headers.set("Cache-Control", noStore["Cache-Control"]);
      return security;
    }
    console.error(JSON.stringify({ event: "amux_owner_queue_dm_request_failed" }));
    // Not known whether it was written: the screen reads the queue again.
    return json({ error: "outcome_unknown" }, 503);
  }
}
