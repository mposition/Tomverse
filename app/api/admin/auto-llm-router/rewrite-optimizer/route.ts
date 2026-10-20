export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  promoteAutoRewriteOptimizerCycle,
  readAutoRewriteOptimizerState,
  rollBackAutoRewriteGuidance,
  startAutoRewriteOptimizerCycle,
  updateRewriteOptimizerAutomation,
} from "@/lib/autoRewriteOptimizer";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";

/**
 * Admin › Routing: the Auto router rewrite guidance optimizer
 * (lib/autoRewriteOptimizer.ts). The optimizer model, its spend and caps are
 * the routing optimizer's (../optimizer/route.ts) and are set there. Reading
 * is any administrator; every change is ops:write with a recent sign-in, and
 * is audited.
 */

const actionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("run") }).strict(),
  z.object({ action: z.literal("set_automation"), daily: z.boolean(), autoPromote: z.boolean() }).strict(),
  z.object({ action: z.literal("promote"), cycleId: z.string().trim().min(1).max(64) }).strict(),
  z.object({ action: z.literal("roll_back") }).strict(),
]);

const stateResponse = async () => NextResponse.json(await readAutoRewriteOptimizerState());

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-auto-rewrite-optimizer-read", {
      minute: 30,
      day: 500,
    });
    return await stateResponse();
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to load the Auto router rewrite optimizer:", error);
    return NextResponse.json({ error: "Failed to load the rewrite optimizer." }, { status: 500 });
  }
}

export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(req, session.user.id, "admin-auto-rewrite-optimizer-write", {
      minute: 10,
      day: 100,
    });
    const body = await readLimitedJson(req, 1024, actionSchema);
    const actor = { session, request: req };

    if (body.action === "set_automation") {
      await updateRewriteOptimizerAutomation(actor, { daily: body.daily, autoPromote: body.autoPromote });
      return await stateResponse();
    }

    if (body.action === "run") {
      const started = await startAutoRewriteOptimizerCycle(actor);
      if ("refused" in started) {
        return NextResponse.json({ error: started.refused, code: started.refused }, { status: 409 });
      }
      return await stateResponse();
    }

    const outcome =
      body.action === "promote"
        ? await promoteAutoRewriteOptimizerCycle(body.cycleId, actor)
        : await rollBackAutoRewriteGuidance(actor);
    if ("refused" in outcome) {
      return NextResponse.json({ error: outcome.refused, code: outcome.refused }, { status: 409 });
    }
    return await stateResponse();
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error("Failed to update the Auto router rewrite optimizer:", error);
    return NextResponse.json({ error: "Failed to update the rewrite optimizer." }, { status: 500 });
  }
}
