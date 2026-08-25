export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { apiSecurityResponse, consumeApiRateLimit } from "@/lib/apiSecurity";
import { estimateCampaignAudience } from "@/lib/emailCampaignService";

type Context = { params: Promise<{ campaignId: string }> };

/**
 * Counting the audience.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11, §12.3.
 *
 * Not approval-gated: counting sends nothing, and requiring a second
 * administrator before an operator may find out how large a send would be is
 * the surest way to have them size it by guessing instead.
 *
 * It does not add a thirteenth condition to section 13.3's twelve. Nothing here
 * gates a send; an estimate makes the size knowable before anybody commits to
 * it, and the twelve conditions are unchanged.
 *
 * Takes no body. Everything the count needs -- the cohort, the replacement, the
 * template's classification -- is on the campaign, and letting a caller pass
 * any of it would let them measure an audience other than the one this campaign
 * will expand.
 */
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
    // Its own bucket, and a tight one: each call walks the audience.
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-estimate", {
      minute: 5,
      day: 100,
    });

    const result = await estimateCampaignAudience({
      campaignId,
      byEmail: session.user.email || "unknown",
    });

    if ("refused" in result) {
      return NextResponse.json(
        {
          error: result.message,
          code: "CAMPAIGN_ESTIMATE_REFUSED",
          refusal: result.refused,
        },
        { status: result.refused === "not_found" ? 404 : 409 }
      );
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_campaign.audience_estimated",
      targetType: "EmailCampaign",
      targetId: campaignId,
      summary: `Measured the audience: ${result.estimatedRecipients} recipients.`,
      metadata: {
        estimatedRecipients: result.estimatedRecipients,
        audienceVersion: result.audienceVersion,
        truncated: result.summary.truncated,
      },
    });

    return NextResponse.json({ estimate: result });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to estimate the audience.", error);
    return NextResponse.json(
      { error: "Failed to estimate the audience." },
      { status: 500 }
    );
  }
}
