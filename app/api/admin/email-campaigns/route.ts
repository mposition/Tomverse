export const dynamic = "force-dynamic";

import { NextResponse } from "next/server";
import { getServerSession } from "next-auth/next";
import { z } from "zod";

import { authOptions } from "@/lib/auth";
import { hasAdminPermission, isAdminSession } from "@/lib/adminAuth";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  apiSecurityResponse,
  consumeApiRateLimit,
  readLimitedJson,
} from "@/lib/apiSecurity";
import {
  CAMPAIGN_CATEGORIES,
  type CampaignCategory,
} from "@/lib/emailCampaignCore";
import { createCampaignDraft } from "@/lib/emailCampaignService";
import { TRIGGER_MODES } from "@/lib/emailCampaignScheduleCore";
import { prisma } from "@/lib/prisma";

/**
 * The campaign workspace's list and its create.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
 *
 * Creating a draft is not approval-gated and deliberately so: a draft sends
 * nothing, and requiring two people to write one would mean the words are
 * composed somewhere this system cannot see. Approval gates the send, in
 * `approve/route.ts`.
 */

const createSchema = z
  .object({
    category: z.enum(CAMPAIGN_CATEGORIES as unknown as [CampaignCategory, ...CampaignCategory[]]),
    templateKey: z.string().trim().min(1).max(120),
    locales: z.array(z.string().trim().min(2).max(8)).min(1).max(7),
    // Passed through to each wave's EmailEvent unchanged. Not `.strict()`
    // inside, because the audience shapes are the expansion layer's to define
    // and re-declaring them here would be a second list to drift.
    audienceSpec: z.record(z.string(), z.unknown()),
    triggerMode: z.enum(TRIGGER_MODES as unknown as [string, ...string[]]).optional(),
    targetModelId: z.string().trim().max(120).optional(),
    replacementModelId: z.string().trim().max(120).optional(),
    workItemId: z.string().trim().max(64).optional(),
  })
  .strict();

export async function GET(req: Request) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-read", {
      minute: 60,
      day: 2_000,
    });

    const campaigns = await prisma.emailCampaign.findMany({
      orderBy: [{ scheduledAt: "asc" }, { createdAt: "desc" }],
      take: 100,
      select: {
        id: true,
        category: true,
        templateKey: true,
        status: true,
        triggerMode: true,
        scheduledAt: true,
        effectiveAt: true,
        timezoneLabel: true,
        targetModelId: true,
        replacementModelId: true,
        claimsAutomaticTransition: true,
        estimatedRecipients: true,
        createdByEmail: true,
        createdAt: true,
        _count: { select: { waves: true } },
      },
    });
    return NextResponse.json({ campaigns });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to load campaigns.", error);
    return NextResponse.json({ error: "Failed to load campaigns." }, { status: 500 });
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
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-write", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 24 * 1024, createSchema);

    const draft = await createCampaignDraft({
      category: body.category,
      templateKey: body.templateKey,
      locales: body.locales,
      audienceSpec: body.audienceSpec as Record<string, never>,
      createdByEmail: session.user.email || "unknown",
    });

    // Set on the row rather than taken by createCampaignDraft: these describe
    // what the campaign is *about*, and the draft service's job is the send
    // itself. Keeping them apart is what stops the audience spec and the model
    // identity being mistaken for each other.
    if (
      body.triggerMode ||
      body.targetModelId ||
      body.replacementModelId ||
      body.workItemId
    ) {
      await prisma.emailCampaign.update({
        where: { id: draft.id },
        data: {
          ...(body.triggerMode ? { triggerMode: body.triggerMode } : {}),
          ...(body.targetModelId ? { targetModelId: body.targetModelId } : {}),
          ...(body.replacementModelId
            ? { replacementModelId: body.replacementModelId }
            : {}),
          ...(body.workItemId ? { workItemId: body.workItemId } : {}),
        },
      });
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_campaign.created",
      targetType: "EmailCampaign",
      targetId: draft.id,
      summary: `Drafted a ${body.category} campaign on ${body.templateKey}.`,
      metadata: {
        category: body.category,
        templateKey: body.templateKey,
        locales: body.locales,
      },
    });

    return NextResponse.json({ campaign: draft }, { status: 201 });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to draft the campaign.", error);
    return NextResponse.json({ error: "Failed to draft the campaign." }, { status: 500 });
  }
}
