export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";

import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
} from "@/lib/apiSecurity";
import { renderCampaignContent } from "@/lib/emailCampaignContent";
import {
  deliveryContentForLanguage,
  localizedCampaignEventPayload,
} from "@/lib/emailCampaignContentCore";
import { readLocales } from "@/lib/emailCampaignCore";
import {
  enqueueRefused,
  enqueueStandardEmail,
} from "@/lib/standardEmailLane";
import { prisma } from "@/lib/prisma";
import { isEmailCampaignsEnabled } from "@/lib/appSettings";
import { CAMPAIGNS_DISABLED_MESSAGE } from "@/lib/emailFeatureFlags";

type Context = { params: Promise<{ campaignId: string }> };

/** Queues the exact campaign copy to the current administrator only. */
export async function POST(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (
      !session?.user?.id ||
      !session.user.email ||
      !isAdminSession(session)
    ) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaign-test", {
      minute: 5,
      day: 50,
    });
    if (!(await isEmailCampaignsEnabled())) {
      return NextResponse.json(
        { error: CAMPAIGNS_DISABLED_MESSAGE, code: "CAMPAIGNS_DISABLED" },
        { status: 409 }
      );
    }

    const { campaignId } = await context.params;
    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        status: true,
        templateKey: true,
        locales: true,
        contentByLocale: true,
      },
    });
    if (!campaign) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (campaign.status !== "draft" && campaign.status !== "pending_approval") {
      return NextResponse.json(
        {
          error:
            "Test sends are limited to editable campaigns. Approved copy must be tested by drafting a new revision.",
          code: "CAMPAIGN_NOT_EDITABLE",
        },
        { status: 409 }
      );
    }

    const locales = readLocales(campaign.locales);
    const rendered = renderCampaignContent({
      templateKey: campaign.templateKey,
      locales,
      contentByLocale: campaign.contentByLocale,
    });
    const user = await prisma.user.findUnique({
      where: { id: session.user.id },
      select: { settings: { select: { language: true } } },
    });
    const localized = deliveryContentForLanguage(
      localizedCampaignEventPayload({
        locales,
        contentByLocale: rendered.contentByLocale,
      }),
      user?.settings?.language ?? "en"
    );
    const queued = await enqueueStandardEmail({
      templateKey: campaign.templateKey,
      emailAddress: session.user.email,
      userId: session.user.id,
      language: localized.language,
      payload: localized.payload,
      referenceType: "EmailCampaignTest",
      referenceId: campaign.id,
    });
    if (enqueueRefused(queued)) {
      return NextResponse.json(
        { error: queued.message, code: queued.refused },
        { status: 409 }
      );
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_campaign.test_queued",
      targetType: "EmailCampaign",
      targetId: campaign.id,
      summary: `Queued a ${localized.language} campaign test to the current administrator.`,
      metadata: {
        deliveryId: queued.deliveryId,
        language: localized.language,
      },
    });

    return NextResponse.json(
      {
        deliveryId: queued.deliveryId,
        language: localized.language,
        status: "queued",
      },
      { status: 202 }
    );
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to queue campaign test email.", error);
    return NextResponse.json(
      { error: "Failed to queue campaign test email." },
      { status: 500 }
    );
  }
}
