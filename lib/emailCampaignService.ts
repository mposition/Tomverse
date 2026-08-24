import "server-only";

import type { Prisma } from "@prisma/client";

import { emailTemplateDefinition } from "@/lib/emailTemplateDefinitions";
import { ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import { expandEmailEvent } from "@/lib/emailAudienceExpansion";
import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  campaignRunRefusal,
  readLocales,
  readPinnedVersions,
  writePinnedVersions,
  type CampaignCategory,
  type CampaignRunRefusalDetail,
  type WaveKind,
} from "@/lib/emailCampaignCore";

/**
 * Campaigns: draft, approve, run a wave, cancel.
 *
 * Contract: docs/policy/email-notifications.md §12.3,
 * .github/audits/model-lifecycle-email-2026-08-22.md §12.2, EM-01, EM-06.
 *
 * The fan-out itself is `expandEmailEvent`. This decides *whether* to run one
 * and what it is allowed to say -- which is the part an approval is about.
 */

export type CampaignDraft = {
  category: CampaignCategory;
  templateKey: string;
  locales: readonly string[];
  audienceSpec: Prisma.InputJsonValue;
  createdByEmail: string;
};

export const createCampaignDraft = async (input: CampaignDraft) => {
  // Reject an unknown template here rather than at send: a draft naming a
  // template that does not exist cannot be approved into anything.
  emailTemplateDefinition(input.templateKey);
  if (input.locales.length === 0) {
    throw new Error("A campaign with no locales would send nothing.");
  }

  return prisma.emailCampaign.create({
    data: {
      category: input.category,
      templateKey: input.templateKey,
      status: "draft",
      locales: [...input.locales],
      audienceSpec: input.audienceSpec,
      createdByEmail: input.createdByEmail,
    },
    select: { id: true, status: true },
  });
};

/**
 * Pins the copy that was approved, per language (EM-06).
 *
 * The pin is taken *now*, from what the template renders now, and stored with
 * its content hash. That hash is what the send compares against, so a later
 * copy change is visible as a difference rather than as a silently newer
 * version.
 *
 * `approvalId` comes from the caller's `AdminActionApproval`: this function does
 * not decide who may approve, only what approving fixes in place.
 */
export const approveCampaign = async (input: {
  campaignId: string;
  approvalId: string;
  now?: Date;
}) => {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    select: { id: true, status: true, templateKey: true, locales: true },
  });
  if (campaign.status !== "draft" && campaign.status !== "pending_approval") {
    throw new Error(
      `Only a draft can be approved; this campaign is ${campaign.status}.`
    );
  }

  const locales = readLocales(campaign.locales);
  const pinned = [];
  for (const language of locales) {
    const version = await ensureTemplateVersion({
      templateKey: campaign.templateKey,
      language,
    });
    const row = await prisma.templateVersion.findUniqueOrThrow({
      where: { id: version.templateVersionId },
      select: { id: true, contentHash: true },
    });
    pinned.push({
      language,
      templateVersionId: row.id,
      contentHash: row.contentHash,
    });
  }

  return prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: {
      status: "approved",
      approvalId: input.approvalId,
      approvedAt: input.now ?? new Date(),
      templateVersionIds: writePinnedVersions(pinned),
    },
    select: { id: true, status: true, approvedAt: true },
  });
};

/** What the template would render to right now, per language. */
const currentHashes = async (templateKey: string, locales: readonly string[]) => {
  const out: Record<string, string> = {};
  for (const language of locales) {
    const version = await ensureTemplateVersion({ templateKey, language });
    const row = await prisma.templateVersion.findUnique({
      where: { id: version.templateVersionId },
      select: { contentHash: true },
    });
    if (row) out[language] = row.contentHash;
  }
  return out;
};

/**
 * Whether this campaign may send, and why not when it may not.
 *
 * Exported on its own because a preview screen has to be able to ask without
 * starting anything.
 */
export const campaignSendRefusal = async (
  campaignId: string
): Promise<CampaignRunRefusalDetail | null> => {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: {
      status: true,
      templateKey: true,
      locales: true,
      templateVersionIds: true,
    },
  });
  const locales = readLocales(campaign.locales);
  return campaignRunRefusal({
    status: campaign.status,
    locales,
    pinned: readPinnedVersions(campaign.templateVersionIds),
    currentHashes: await currentHashes(campaign.templateKey, locales),
  });
};

/**
 * Runs one wave: creates its event and expands it.
 *
 * The refusal is checked here rather than only at draft time because the thing
 * it guards against -- copy changing after approval -- happens between the two.
 */
export const runCampaignWave = async (input: {
  campaignId: string;
  kind: WaveKind;
  sequence?: number;
  recipientCap?: number;
  dryRun?: boolean;
  batchSize?: number;
  timeBudgetMs?: number;
}) => {
  const refusal = await campaignSendRefusal(input.campaignId);
  if (refusal) {
    if (refusal.refusal === "content_changed") {
      // Worth an incident rather than only a return value: somebody approved
      // one thing and the deployment now holds another, and nobody finds that
      // out unless it is said.
      await reportOperationalIncident({
        code: "EMAIL_CAMPAIGN_CONTENT_CHANGED",
        title: "A campaign's approved copy no longer matches the template",
        error: refusal.message,
        severity: "error",
        context: {
          component: "email-campaign",
          campaignId: input.campaignId,
          languages: (refusal.languages ?? []).join(","),
        },
      });
    }
    return { refused: refusal };
  }

  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    select: { id: true, templateKey: true, audienceSpec: true, locales: true },
  });
  const sequence = input.sequence ?? 1;

  const template = await ensureTemplateVersion({
    templateKey: campaign.templateKey,
    language: readLocales(campaign.locales)[0] ?? "en",
  });
  const definition = emailTemplateDefinition(campaign.templateKey);

  // The wave and its event commit together. A wave row pointing at no event is
  // a fan-out nothing will ever resume; an event with no wave is a send nothing
  // will ever account for.
  const wave = await prisma.$transaction(async (tx) => {
    const existing = await tx.emailCampaignWave.findUnique({
      where: {
        campaignId_kind_sequence: {
          campaignId: campaign.id,
          kind: input.kind,
          sequence,
        },
      },
      select: { id: true, eventId: true, status: true },
    });
    // A wave that already exists is resumed, not repeated. The unique index
    // makes a second "reminder 1" impossible; this makes asking for one
    // harmless.
    if (existing?.eventId) return existing;

    const spec = {
      ...(typeof campaign.audienceSpec === "object" &&
      campaign.audienceSpec !== null &&
      !Array.isArray(campaign.audienceSpec)
        ? (campaign.audienceSpec as Record<string, unknown>)
        : {}),
      ...(input.recipientCap === undefined
        ? {}
        : { recipientCap: input.recipientCap }),
      ...(input.dryRun ? { dryRun: true } : {}),
    };

    const event = await tx.emailEvent.create({
      data: {
        kind: `email.${definition.key}`,
        templateId: template.templateId,
        referenceType: "EmailCampaign",
        referenceId: campaign.id,
        payload: { campaignId: campaign.id },
        audienceKind: "user_segment",
        audienceSpec: spec as Prisma.InputJsonValue,
        status: "pending",
      },
      select: { id: true },
    });

    return tx.emailCampaignWave.upsert({
      where: {
        campaignId_kind_sequence: {
          campaignId: campaign.id,
          kind: input.kind,
          sequence,
        },
      },
      create: {
        campaignId: campaign.id,
        kind: input.kind,
        sequence,
        eventId: event.id,
        status: "expanding",
        ...(input.recipientCap === undefined
          ? {}
          : { recipientCap: input.recipientCap }),
        dryRun: Boolean(input.dryRun),
      },
      update: { eventId: event.id, status: "expanding" },
      select: { id: true, eventId: true, status: true },
    });
  });

  await prisma.emailCampaign.updateMany({
    where: { id: campaign.id, status: "approved" },
    data: { status: "running" },
  });

  const expansion = await expandEmailEvent({
    eventId: wave.eventId!,
    ...(input.batchSize === undefined ? {} : { batchSize: input.batchSize }),
    ...(input.timeBudgetMs === undefined
      ? {}
      : { timeBudgetMs: input.timeBudgetMs }),
  });

  if ("refused" in expansion) {
    return { waveId: wave.id, expansion };
  }

  await prisma.emailCampaignWave.update({
    where: { id: wave.id },
    data: {
      status: expansion.status === "expanded" ? "expanded" : "expanding",
      // Counted from the event rather than from this pass, so a resumed wave
      // reports the campaign's reach and not the last run's.
      expandedCount: await prisma.emailDelivery.count({
        where: { eventId: wave.eventId! },
      }),
    },
  });

  return { waveId: wave.id, expansion };
};

/**
 * Stops a campaign and every wave that has not finished.
 *
 * Delivery rows already written are left to the lane, which will skip the ones
 * it should: a cancelled campaign is a decision about what happens next, and
 * rewriting rows behind it would lose what had already been done.
 */
export const cancelCampaign = async (input: {
  campaignId: string;
  reason: string;
  now?: Date;
}) => {
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.emailCampaign.update({
      where: { id: input.campaignId },
      data: { status: "cancelled", cancelledAt: now, cancelReason: input.reason },
      select: { id: true, status: true },
    });
    const waves = await tx.emailCampaignWave.updateMany({
      where: {
        campaignId: input.campaignId,
        status: { in: ["pending", "expanding", "expanded", "sending"] },
      },
      data: { status: "cancelled" },
    });
    return { campaign, wavesCancelled: waves.count };
  });
};
