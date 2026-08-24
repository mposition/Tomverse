export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import {
  adminApprovalErrorResponse,
  runWithAdminApproval,
} from "@/lib/adminApproval";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  approveCampaign,
  campaignScheduleProblems,
  campaignTransitionClaim,
} from "@/lib/emailCampaignService";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ campaignId: string }> };

/**
 * Approving a campaign: the two-person action of this workspace.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3;
 * docs/policy/email-notifications.md §12.3.
 *
 * ## Why this one and not the others
 *
 * Drafting sends nothing. Scheduling a wave sends nothing -- a schedule under
 * an unapproved campaign is refused at the moment it comes due. Running a wave
 * of an already-approved campaign is the *execution* of a decision that was
 * approved here, and asking for a second approval to carry out the first would
 * make the send the reviewed act rather than the words.
 *
 * Approval is where a person reads the copy. That is the thing being approved,
 * and EM-06 pins it here so the approval cannot come to cover something else.
 *
 * ## Not the sole-approver path
 *
 * Whether the one-administrator exception applies to campaigns is D10's
 * sibling, §21's **D5** -- an organisational decision, not a code one. Adding
 * `email_campaign.approve` to `SOLE_APPROVER_ACTIONS` would be making that call
 * here. Until it is made, this is the ordinary two-person path.
 */

const approveSchema = z
  .object({
    reason: z.string().trim().min(1).max(500),
    /**
     * What the approver believes they are approving.
     *
     * Echoed into the approval payload, so a second administrator approving a
     * request approves the same languages -- and a campaign whose locales moved
     * between request and approval produces a different payload hash and needs
     * a fresh approval rather than inheriting the old one.
     */
    locales: z.array(z.string().trim().min(2).max(8)).min(1).max(7),
  })
  .strict();

export async function POST(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { campaignId } = await context.params;
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-approve", {
      minute: 10,
      day: 100,
    });

    const body = await readLimitedJson(req, 8 * 1024, approveSchema);

    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: campaignId },
      select: {
        status: true,
        locales: true,
        claimsAutomaticTransition: true,
      },
    });
    if (!campaign) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const stored = Array.isArray(campaign.locales)
      ? (campaign.locales as unknown[]).filter(
          (entry): entry is string => typeof entry === "string"
        )
      : [];
    // Refused before the approval is claimed, not after. An approval consumed
    // against the wrong language list is spent, and the operator's next attempt
    // starts from nothing.
    if (
      stored.length !== body.locales.length ||
      stored.some((language, index) => language !== body.locales[index])
    ) {
      return NextResponse.json(
        {
          error: `This campaign now sends in ${stored.join(", ") || "no languages"}, not ${body.locales.join(", ")}. Re-read it and approve what it actually says.`,
          code: "CAMPAIGN_LOCALES_CHANGED",
        },
        { status: 409 }
      );
    }

    const problems = await campaignScheduleProblems({ campaignId });
    if (problems.length > 0) {
      // Approving a schedule that cannot work would burn the approval on a
      // campaign somebody has to edit anyway -- and editing it after approval
      // is what this whole layer refuses.
      return NextResponse.json(
        {
          error: "Fix the schedule before approving it.",
          code: "CAMPAIGN_SCHEDULE_INVALID",
          problems,
        },
        { status: 409 }
      );
    }

    if (campaign.claimsAutomaticTransition) {
      const { claim } = await campaignTransitionClaim(campaignId);
      if (!claim.mayClaim) {
        // Said here as well as at send. At send it stops the message; here it
        // stops a person spending a second administrator's attention on a
        // promise that cannot be made yet.
        return NextResponse.json(
          {
            error:
              "This campaign promises an automatic transition and not every condition for that promise is met.",
            code: "CAMPAIGN_TRANSITION_UNPROVEN",
            unmet: claim.unmet,
            reasons: claim.reasons,
          },
          { status: 409 }
        );
      }
    }

    try {
      const approved = await runWithAdminApproval(
        {
          session,
          request: req,
          action: "email_campaign.approve",
          targetType: "EmailCampaign",
          targetId: campaignId,
          // The languages are in the payload, so the hash changes when they do
          // and a stale approval cannot be claimed for a different send.
          payload: { campaignId, locales: body.locales },
          reason: body.reason,
        },
        async () => {
          const approvalRow = await prisma.adminActionApproval.findFirst({
            where: {
              action: "email_campaign.approve",
              targetId: campaignId,
              status: "executing",
            },
            orderBy: { createdAt: "desc" },
            select: { id: true },
          });
          return approveCampaign({
            campaignId,
            // The approval this send is carried out under. Without it the
            // twelve-condition gate's "communication_approved" has nothing to
            // read, and the campaign row cannot say who let it out.
            approvalId: approvalRow?.id ?? `unrecorded-${campaignId}`,
          });
        }
      );

      await writeAdminAuditLog({
        session,
        request: req,
        action: "email_campaign.approved",
        targetType: "EmailCampaign",
        targetId: campaignId,
        summary: `Approved the campaign: ${body.reason}`,
        metadata: { locales: body.locales },
      });

      return NextResponse.json({ campaign: approved });
    } catch (error) {
      const response = adminApprovalErrorResponse(error);
      if (response) return response;
      throw error;
    }
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to approve the campaign.", error);
    return NextResponse.json({ error: "Failed to approve the campaign." }, { status: 500 });
  }
}
