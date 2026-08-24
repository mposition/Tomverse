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
  campaignAttestationStates,
  campaignScheduleProblems,
  campaignSendRefusal,
  campaignTransitionClaim,
  cancelCampaign,
} from "@/lib/emailCampaignService";
import { TRIGGER_MODES } from "@/lib/emailCampaignScheduleCore";
import { waveAudienceBreakdown } from "@/lib/adminEmailCampaigns";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ campaignId: string }> };

/**
 * One campaign: everything an operator needs before deciding, and the edits
 * that are theirs to make before approval.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
 */

const patchSchema = z
  .object({
    triggerMode: z.enum(TRIGGER_MODES as unknown as [string, ...string[]]).optional(),
    scheduledAt: z.string().datetime().nullable().optional(),
    // Both or neither, enforced below *and* by a CHECK. Two places because the
    // API can say which half is missing and the database cannot.
    effectiveAt: z.string().datetime().nullable().optional(),
    timezoneLabel: z.string().trim().min(1).max(64).nullable().optional(),
    targetModelId: z.string().trim().max(120).nullable().optional(),
    replacementModelId: z.string().trim().max(120).nullable().optional(),
    workItemId: z.string().trim().max(64).nullable().optional(),
    claimsAutomaticTransition: z.boolean().optional(),
    estimatedRecipients: z.number().int().min(0).nullable().optional(),
    /** Cancelling is its own edit: it decides what happens next. */
    cancelReason: z.string().trim().min(1).max(500).optional(),
  })
  .strict();

export async function GET(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    const { campaignId } = await context.params;
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-read", {
      minute: 60,
      day: 2_000,
    });

    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: campaignId },
      select: {
        id: true,
        category: true,
        templateKey: true,
        status: true,
        locales: true,
        audienceSpec: true,
        triggerMode: true,
        scheduledAt: true,
        effectiveAt: true,
        timezoneLabel: true,
        workItemId: true,
        targetModelId: true,
        replacementModelId: true,
        audienceVersion: true,
        estimatedRecipients: true,
        claimsAutomaticTransition: true,
        approvalId: true,
        approvedAt: true,
        createdByEmail: true,
        cancelledAt: true,
        cancelReason: true,
        createdAt: true,
        waves: {
          orderBy: [{ scheduledAt: "asc" }, { sequence: "asc" }],
          select: {
            id: true,
            kind: true,
            sequence: true,
            status: true,
            scheduledAt: true,
            dryRun: true,
            recipientCap: true,
            expandedCount: true,
          },
        },
      },
    });
    if (!campaign) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    // Everything that decides whether this may send, answered together. Asked
    // one at a time an operator learns of the second problem only after fixing
    // the first.
    const [refusal, schedule, attestations, transition, audience] =
      await Promise.all([
        campaignSendRefusal(campaignId),
        campaignScheduleProblems({ campaignId }),
        campaignAttestationStates(campaignId),
        campaign.claimsAutomaticTransition
          ? campaignTransitionClaim(campaignId).then((result) => result.claim)
          : Promise.resolve(null),
        // Who each wave reached and who it did not. Counts only -- the ledger
        // holds addresses, and whether an operator may see them is D10.
        waveAudienceBreakdown(campaignId),
      ]);

    return NextResponse.json({
      campaign,
      sendRefusal: refusal,
      scheduleProblems: schedule,
      attestations,
      transitionClaim: transition,
      audience,
    });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to load the campaign.", error);
    return NextResponse.json({ error: "Failed to load the campaign." }, { status: 500 });
  }
}

export async function PATCH(req: Request, context: Context) {
  try {
    const session = await getServerSession(authOptions);
    if (!session?.user?.id || !isAdminSession(session)) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }
    if (!hasAdminPermission(session, "ops:write")) {
      return NextResponse.json({ error: "Forbidden." }, { status: 403 });
    }
    const { campaignId } = await context.params;
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-write", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 16 * 1024, patchSchema);

    const existing = await prisma.emailCampaign.findUnique({
      where: { id: campaignId },
      select: {
        status: true,
        effectiveAt: true,
        timezoneLabel: true,
        targetModelId: true,
        replacementModelId: true,
      },
    });
    if (!existing) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    if (body.cancelReason) {
      const result = await cancelCampaign({
        campaignId,
        reason: body.cancelReason,
      });
      await writeAdminAuditLog({
        session,
        request: req,
        action: "email_campaign.cancelled",
        targetType: "EmailCampaign",
        targetId: campaignId,
        summary: `Cancelled the campaign: ${body.cancelReason}`,
        metadata: { wavesCancelled: result.wavesCancelled },
      });
      return NextResponse.json({ campaign: result.campaign });
    }

    // An approved campaign's content and targets are what the approval covers.
    // Editing them afterwards is how an approval comes to describe something
    // nobody read -- the failure EM-06 exists for, one field further out.
    if (existing.status !== "draft" && existing.status !== "pending_approval") {
      return NextResponse.json(
        {
          error: `A ${existing.status} campaign cannot be edited. Cancel it and draft another, or withdraw the approval.`,
          code: "CAMPAIGN_NOT_EDITABLE",
        },
        { status: 409 }
      );
    }

    const effectiveAt =
      body.effectiveAt === undefined
        ? existing.effectiveAt
        : body.effectiveAt === null
          ? null
          : new Date(body.effectiveAt);
    const timezoneLabel =
      body.timezoneLabel === undefined
        ? existing.timezoneLabel
        : body.timezoneLabel;
    if (Boolean(effectiveAt) !== Boolean(timezoneLabel)) {
      return NextResponse.json(
        {
          error:
            "An effective date needs the timezone it will be read in, and a timezone needs a date. A UTC instant with no label reads as a different day to the person receiving the notice than to the person who set it.",
          code: "CAMPAIGN_EFFECTIVE_AT_INCOMPLETE",
        },
        { status: 400 }
      );
    }

    const targetModelId =
      body.targetModelId === undefined ? existing.targetModelId : body.targetModelId;
    const replacementModelId =
      body.replacementModelId === undefined
        ? existing.replacementModelId
        : body.replacementModelId;
    if (body.claimsAutomaticTransition && !(targetModelId && replacementModelId)) {
      return NextResponse.json(
        {
          error:
            "A campaign that promises an automatic transition has to name both the model going away and the one replacing it; the sentence cannot be written without them.",
          code: "CAMPAIGN_TRANSITION_MODELS_MISSING",
        },
        { status: 400 }
      );
    }

    const campaign = await prisma.emailCampaign.update({
      where: { id: campaignId },
      data: {
        ...(body.triggerMode ? { triggerMode: body.triggerMode } : {}),
        ...(body.scheduledAt === undefined
          ? {}
          : {
              scheduledAt:
                body.scheduledAt === null ? null : new Date(body.scheduledAt),
            }),
        ...(body.effectiveAt === undefined ? {} : { effectiveAt }),
        ...(body.timezoneLabel === undefined ? {} : { timezoneLabel }),
        ...(body.targetModelId === undefined ? {} : { targetModelId }),
        ...(body.replacementModelId === undefined ? {} : { replacementModelId }),
        ...(body.workItemId === undefined ? {} : { workItemId: body.workItemId }),
        ...(body.claimsAutomaticTransition === undefined
          ? {}
          : { claimsAutomaticTransition: body.claimsAutomaticTransition }),
        ...(body.estimatedRecipients === undefined
          ? {}
          : { estimatedRecipients: body.estimatedRecipients }),
      },
      select: {
        id: true,
        status: true,
        triggerMode: true,
        scheduledAt: true,
        effectiveAt: true,
        timezoneLabel: true,
        targetModelId: true,
        replacementModelId: true,
        claimsAutomaticTransition: true,
      },
    });

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_campaign.updated",
      targetType: "EmailCampaign",
      targetId: campaignId,
      summary: "Edited a campaign draft.",
      metadata: { fields: Object.keys(body) },
    });

    return NextResponse.json({ campaign });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to update the campaign.", error);
    return NextResponse.json({ error: "Failed to update the campaign." }, { status: 500 });
  }
}
