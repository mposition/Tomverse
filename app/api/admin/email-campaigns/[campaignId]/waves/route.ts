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
import { WAVE_KINDS, type WaveKind } from "@/lib/emailCampaignCore";
import {
  campaignScheduleProblems,
  runCampaignWave,
  scheduleCampaignWave,
} from "@/lib/emailCampaignService";
import { prisma } from "@/lib/prisma";

type Context = { params: Promise<{ campaignId: string }> };

/**
 * Scheduling a wave, and starting one by hand.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2.
 *
 * Neither is approval-gated, and the reason is the same for both: what an
 * approval covers is the words, and both of these carry words that were already
 * approved. `runCampaignWave` re-asks `campaignSendRefusal` on every call, so a
 * wave started here goes out only if the approval still describes it.
 */

const waveSchema = z
  .object({
    kind: z.enum(WAVE_KINDS as unknown as [WaveKind, ...WaveKind[]]),
    sequence: z.number().int().min(1).max(99).optional(),
    action: z.enum(["schedule", "run"]),
    /** Ignored by `run`; null clears a time and returns the wave to hand. */
    scheduledAt: z.string().datetime().nullable().optional(),
    recipientCap: z.number().int().min(0).max(1_000_000).optional(),
    dryRun: z.boolean().optional(),
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
    await consumeApiRateLimit(req, session.user.id, "admin-email-campaigns-write", {
      minute: 20,
      day: 300,
    });

    const body = await readLimitedJson(req, 8 * 1024, waveSchema);

    const campaign = await prisma.emailCampaign.findUnique({
      where: { id: campaignId },
      select: { id: true },
    });
    if (!campaign) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    if (body.action === "schedule") {
      const wave = await scheduleCampaignWave({
        campaignId,
        kind: body.kind,
        ...(body.sequence === undefined ? {} : { sequence: body.sequence }),
        scheduledAt:
          body.scheduledAt === undefined || body.scheduledAt === null
            ? null
            : new Date(body.scheduledAt),
        ...(body.recipientCap === undefined
          ? {}
          : { recipientCap: body.recipientCap }),
        ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
      });

      await writeAdminAuditLog({
        session,
        request: req,
        action: "email_campaign.wave_scheduled",
        targetType: "EmailCampaign",
        targetId: campaignId,
        summary: `Scheduled the ${body.kind} wave.`,
        metadata: { kind: body.kind, scheduledAt: body.scheduledAt ?? null },
      });

      // Returned with the wave rather than left for a second request: an
      // out-of-order schedule is made one edit at a time, and this is the edit.
      return NextResponse.json({
        wave,
        scheduleProblems: await campaignScheduleProblems({ campaignId }),
      });
    }

    const run = await runCampaignWave({
      campaignId,
      kind: body.kind,
      ...(body.sequence === undefined ? {} : { sequence: body.sequence }),
      ...(body.recipientCap === undefined
        ? {}
        : { recipientCap: body.recipientCap }),
      ...(body.dryRun === undefined ? {} : { dryRun: body.dryRun }),
    });

    if ("refused" in run) {
      await writeAdminAuditLog({
        session,
        request: req,
        action: "email_campaign.wave_refused",
        targetType: "EmailCampaign",
        targetId: campaignId,
        summary: `The ${body.kind} wave was refused: ${run.refused.refusal}`,
        metadata: { kind: body.kind, refusal: run.refused.refusal },
      });
      return NextResponse.json(
        {
          error: run.refused.message,
          code: "CAMPAIGN_SEND_REFUSED",
          refusal: run.refused.refusal,
          languages: run.refused.languages ?? [],
        },
        { status: 409 }
      );
    }

    await writeAdminAuditLog({
      session,
      request: req,
      action: "email_campaign.wave_started",
      targetType: "EmailCampaign",
      targetId: campaignId,
      summary: `Started the ${body.kind} wave.`,
      metadata: {
        kind: body.kind,
        waveId: run.waveId,
        dryRun: Boolean(body.dryRun),
      },
    });

    return NextResponse.json({ waveId: run.waveId, expansion: run.expansion });
  } catch (error) {
    const response = apiSecurityResponse(error);
    if (response) return response;
    console.error("Failed to act on the wave.", error);
    return NextResponse.json({ error: "Failed to act on the wave." }, { status: 500 });
  }
}
