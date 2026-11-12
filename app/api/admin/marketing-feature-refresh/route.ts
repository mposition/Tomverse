export const dynamic = "force-dynamic";
export const maxDuration = 150;

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { MARKETING_AUTOMATION_KILL_SWITCH_ENV } from "@/lib/marketingAutomationAccess";
import { marketingFeatureRefreshFromEnv } from "@/lib/marketingFeatureFacts";
import { prisma } from "@/lib/prisma";

/**
 * POST: one model call reads the public FAQ, the help centre, the marketing
 * claims and the feature switches and proposes additions, changes and holds
 * to release (lib/marketingFeatureFacts.ts). It writes nothing: the proposals
 * come back to the screen, and only an operator's save (PATCH or POST on the
 * list) stores one, through the audit chain.
 *
 * Paid. On by default on the app's default model (owner decision in chat,
 * 2026-11-12); MARKETING_FEATURE_REFRESH_LLM_MODEL_ID=off turns it off. It
 * runs only on an operator's press and takes the same marketing:write and
 * recent sign-in as a save, with a small rate limit.
 */
export async function POST(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "marketing:write")) {
      return NextResponse.json(
        { error: "Marketing write access is required.", code: "MARKETING_WRITE_REQUIRED" },
        { status: 403 },
      );
    }
    await assertRecentAdminAuthentication(session);
    // The kill switch stops everything but reading the record
    // (docs/policy/marketing-automation.md §6.1); any non-empty value is on.
    if ((process.env[MARKETING_AUTOMATION_KILL_SWITCH_ENV] ?? "").trim().length > 0) {
      return NextResponse.json(
        { error: "Marketing automation is stopped by the kill switch.", code: "MARKETING_KILL_SWITCH" },
        { status: 409 },
      );
    }
    const refresh = await marketingFeatureRefreshFromEnv();
    if (!refresh) {
      return NextResponse.json(
        { error: "The refresh is off, or its model is not enabled.", code: "FEATURE_REFRESH_OFF" },
        { status: 409 },
      );
    }
    // Counted only for a press that will call the model.
    await consumeApiRateLimit(req, session.user.id, "admin-marketing-feature-facts-refresh", { minute: 2, day: 20 });
    const result = await refresh(prisma);
    // The call is paid, so who pressed it is on the chain even though nothing is stored.
    await writeAdminAuditLog({
      session,
      request: req,
      action: "marketing_feature_fact.refresh",
      targetType: "MarketingFeatureFact",
      summary: "Ran the ad facts refresh (a paid model call; proposals only, nothing stored).",
    });
    return NextResponse.json({ ok: true, result }, { headers: { "cache-control": "private, no-store" } });
  } catch (error) {
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    console.error("The marketing feature refresh failed:", error);
    return NextResponse.json({ error: "The refresh could not be completed.", code: "FEATURE_REFRESH_FAILED" }, { status: 502 });
  }
}
