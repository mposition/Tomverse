export const dynamic = "force-dynamic";

import { getServerSession } from "next-auth/next";
import { NextResponse } from "next/server";
import { z } from "zod";
import { authOptions } from "@/lib/auth";
import { adminApprovalErrorResponse } from "@/lib/adminApproval";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { getAdminRole, isAdminSession } from "@/lib/adminAuth";
import { assertRecentAdminAuthentication } from "@/lib/adminReauthentication";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import { approveAutoFixCase } from "@/lib/feedbackAutoFixPromotion";

const approveSchema = z
  .object({
    /** The develop PR head the console showed the owner. The approval binds
     * this head; if GitHub now reports another, nothing is approved. */
    headSha: z.string().regex(/^[0-9a-f]{40}$/i),
  })
  .strict();

type RouteContext = { params: Promise<{ caseId: string }> };

const REFUSAL_STATUS: Record<string, number> = {
  not_configured: 503,
  not_found: 404,
  wrong_state: 409,
  head_changed: 409,
  manifest_changed: 409,
  pull_request_not_open: 409,
  github_unavailable: 503,
};

/**
 * POST: an owner approves an auto-fix PR for promotion
 * (docs/policy/trace-feedback-automation.md §9.3).
 *
 * Owner only, and only with a recent sign-in: the approval is what lets a fix
 * travel toward production, so it gets the same step-up as the console's
 * other high-risk controls. It merges nothing. The response says so and
 * points at the PR, which a person merges in GitHub under branch protection.
 */
export async function POST(req: Request, context: RouteContext) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (getAdminRole(session) !== "owner") {
      return NextResponse.json(
        { error: "Only an owner can approve a fix for promotion.", code: "OWNER_REQUIRED" },
        { status: 403 }
      );
    }
    await assertRecentAdminAuthentication(session);
    await consumeApiRateLimit(req, session.user.id, "admin-autofix-approve", {
      minute: 5,
      day: 50,
    });
    const { caseId } = await context.params;
    const body = await readLimitedJson(req, 1024, approveSchema);

    const outcome = await approveAutoFixCase({
      caseId,
      headSha: body.headSha,
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: outcome.approved ? "feedback_autofix.approved" : "feedback_autofix.approval_refused",
      targetType: "FeedbackAutoFixCase",
      targetId: caseId,
      summary: outcome.approved
        ? "Approved an auto-fix PR for promotion."
        : `Auto-fix approval refused: ${outcome.code}.`,
      metadata: {
        headSha: body.headSha.toLowerCase(),
        ...(outcome.approved ? {} : { code: outcome.code }),
      },
    });

    if (!outcome.approved) {
      return NextResponse.json(
        { error: "The fix was not approved.", code: outcome.code },
        { status: REFUSAL_STATUS[outcome.code] ?? 409 }
      );
    }
    return NextResponse.json({
      success: true,
      nextStep: "merge_develop_pr_in_github",
      prUrl: outcome.prUrl,
    });
  } catch (error) {
    const approvalResponse = adminApprovalErrorResponse(error);
    if (approvalResponse) return approvalResponse;
    const securityResponse = apiSecurityResponse(error);
    if (securityResponse) return securityResponse;
    console.error(
      JSON.stringify({
        event: "admin_autofix_approve_failed",
        reason: error instanceof Error ? error.name : "unknown",
      })
    );
    return NextResponse.json({ error: "Failed to approve the fix." }, { status: 500 });
  }
}
