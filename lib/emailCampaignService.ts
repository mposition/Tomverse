import "server-only";

import type { Prisma } from "@prisma/client";

import { emailTemplateDefinition } from "@/lib/emailTemplateDefinitions";
import { ensureTemplateVersion } from "@/lib/emailTemplateRegistry";
import {
  campaignContentHashes,
  renderCampaignContent,
  type CampaignEmailPreview,
} from "@/lib/emailCampaignContent";
import {
  localizedCampaignEventPayload,
} from "@/lib/emailCampaignContentCore";
import {
  expandEmailEvent,
  type ExpansionOutcome,
} from "@/lib/emailAudienceExpansion";
import { prisma } from "@/lib/prisma";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import {
  attestationStates,
  attestationsForClaim,
  campaignContentDigest,
  isContentBound,
  type AttestationKind,
  type StoredAttestation,
} from "@/lib/emailCampaignAttestationCore";
import { automaticTransitionClaim } from "@/lib/automaticTransitionClaim";
import { AUDIENCE_DEFINITION_VERSION } from "@/lib/modelRetirementAudienceCore";
import { isEmailCampaignsEnabled } from "@/lib/appSettings";
import { CAMPAIGNS_DISABLED_MESSAGE } from "@/lib/emailFeatureFlags";
import { readExpansionSpec } from "@/lib/emailAudienceExpansionCore";
import {
  summariseRetirementAudience,
  type AudienceSummary,
} from "@/lib/modelRetirementAudience";
import {
  scheduleProblems,
  scheduleRefusal,
  type ScheduleRefusalDetail,
  type WaveSchedule,
} from "@/lib/emailCampaignScheduleCore";
import {
  campaignRunRefusal,
  readLocales,
  readPinnedVersions,
  writePinnedVersions,
  type CampaignCategory,
  type CampaignRunRefusalDetail,
  type WaveKind,
} from "@/lib/emailCampaignCore";
import { isLanguage } from "@/lib/language";

/**
 * Campaigns: draft, approve, run a wave, cancel.
 *
 * Contract: docs/policy/email-notifications.md §12.3,
 * .github/audits/model-lifecycle-email-2026-08-22.md §12.2, EM-01, EM-06.
 *
 * The fan-out itself is `expandEmailEvent`. This decides *whether* to run one
 * and what it is allowed to say -- which is the part an approval is about.
 */

/**
 * Thrown by every campaign action while the feature is switched off.
 *
 * Contract: docs/policy/email-notifications.md §15.2 (EM-05).
 *
 * The flag gates *acts*, not reads. An operator can still open the console and
 * see what exists, which is the only place `EmailCampaignWave` is readable at
 * all -- hiding it would mean the feature being off also hid whatever it had
 * already done. Drafting, approving, scheduling, estimating and sending are
 * refused.
 *
 * Thrown rather than returned because these functions already have refusal
 * unions for their own reasons -- "this campaign is cancelled", "the copy
 * moved" -- and folding a feature-level switch into a per-campaign verdict
 * would make callers handle "the feature is off" once per campaign state.
 */
export class CampaignsDisabledError extends Error {
  readonly code = "CAMPAIGNS_DISABLED";
  constructor() {
    super(CAMPAIGNS_DISABLED_MESSAGE);
    this.name = "CampaignsDisabledError";
  }
}

const assertCampaignsEnabled = async () => {
  if (!(await isEmailCampaignsEnabled())) throw new CampaignsDisabledError();
};

export type CampaignDraft = {
  category: CampaignCategory;
  templateKey: string;
  locales: readonly string[];
  contentByLocale?: Prisma.InputJsonValue;
  audienceSpec: Prisma.InputJsonValue;
  createdByEmail: string;
  initialWaves?: readonly {
    kind: WaveKind;
    sequence: number;
  }[];
};

export const createCampaignDraft = async (input: CampaignDraft) => {
  await assertCampaignsEnabled();
  // Reject an unknown template here rather than at send: a draft naming a
  // template that does not exist cannot be approved into anything.
  const definition = emailTemplateDefinition(input.templateKey);
  if (input.locales.length === 0) {
    throw new Error("A campaign with no locales would send nothing.");
  }
  const locales = [...new Set(input.locales)];
  const unsupported = locales.filter((language) => !isLanguage(language));
  if (unsupported.length > 0) {
    throw new Error(`Unsupported campaign locales: ${unsupported.join(", ")}.`);
  }
  const submittedContent =
    input.contentByLocale ??
    Object.fromEntries(
      locales.map((language) => [language, definition.placeholderPayload])
    );
  const content = renderCampaignContent({
    templateKey: input.templateKey,
    locales,
    contentByLocale: submittedContent,
  }).contentByLocale;
  const expansion = readExpansionSpec(input.audienceSpec);
  if (
    expansion.cohort?.kind === "marketing_consent" &&
    definition.purpose !== expansion.cohort.purpose
  ) {
    throw new Error(
      `The ${definition.key} template is gated by ${definition.purpose ?? "no purpose"}, not ${expansion.cohort.purpose}.`
    );
  }
  if (input.initialWaves) {
    const waveKeys = input.initialWaves.map(
      (wave) => `${wave.kind}:${wave.sequence}`
    );
    if (new Set(waveKeys).size !== waveKeys.length) {
      throw new Error("A campaign cannot contain the same wave sequence twice.");
    }
  }

  return prisma.emailCampaign.create({
    data: {
      category: input.category,
      templateKey: input.templateKey,
      status: "draft",
      locales,
      contentByLocale: content as Prisma.InputJsonValue,
      audienceSpec: input.audienceSpec,
      createdByEmail: input.createdByEmail,
      ...(input.initialWaves && input.initialWaves.length > 0
        ? {
            waves: {
              create: input.initialWaves.map((wave) => ({
                kind: wave.kind,
                sequence: wave.sequence,
                status: "pending",
              })),
            },
          }
        : {}),
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
  await assertCampaignsEnabled();
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    select: {
      id: true,
      status: true,
      templateKey: true,
      locales: true,
      contentByLocale: true,
    },
  });
  if (campaign.status !== "draft" && campaign.status !== "pending_approval") {
    throw new Error(
      `Only a draft can be approved; this campaign is ${campaign.status}.`
    );
  }

  const locales = readLocales(campaign.locales);
  const current = campaignContentHashes({
    templateKey: campaign.templateKey,
    locales,
    contentByLocale: campaign.contentByLocale,
  });
  const pinned = [];
  for (const language of locales) {
    const version = await ensureTemplateVersion({
      templateKey: campaign.templateKey,
      language,
    });
    pinned.push({
      language,
      templateVersionId: version.templateVersionId,
      contentHash: current[language],
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
const currentHashes = (input: {
  templateKey: string;
  locales: readonly string[];
  contentByLocale: unknown;
}) => {
  try {
    return campaignContentHashes(input);
  } catch {
    // Missing or malformed content means no locale can match an approval. The
    // pure refusal then reports `content_changed`, which is the safe answer for
    // a legacy approved row whose original body was never stored.
    return {};
  }
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
      contentByLocale: true,
      templateVersionIds: true,
      claimsAutomaticTransition: true,
    },
  });
  const locales = readLocales(campaign.locales);
  // Read only when the campaign makes the promise. The twelve conditions cost
  // half a dozen queries, and a campaign that promises nothing owes none of
  // them.
  const transition = campaign.claimsAutomaticTransition
    ? (await campaignTransitionClaim(campaignId)).claim
    : null;
  return campaignRunRefusal({
    status: campaign.status,
    locales,
    pinned: readPinnedVersions(campaign.templateVersionIds),
    currentHashes: currentHashes({
      templateKey: campaign.templateKey,
      locales,
      contentByLocale: campaign.contentByLocale,
    }),
    transitionClaim: {
      claimed: campaign.claimsAutomaticTransition,
      unmet: transition?.unmet ?? [],
    },
  });
};

/**
 * Runs one wave: creates its event and expands it.
 *
 * The refusal is checked here rather than only at draft time because the thing
 * it guards against -- copy changing after approval -- happens between the two.
 */
/**
 * What starting or resuming a wave returns.
 *
 * Named for the same reason `ExpansionOutcome` is: an inferred union of object
 * literals carries the other member's keys as `?: undefined`, and a caller
 * asking `"refused" in run` then gets a refusal that might not be there.
 */
export type CampaignWaveRun =
  | { refused: CampaignRunRefusalDetail }
  | { waveId: string; expansion: ExpansionOutcome };

export const runCampaignWave = async (input: {
  campaignId: string;
  kind: WaveKind;
  sequence?: number;
  recipientCap?: number;
  dryRun?: boolean;
  batchSize?: number;
  timeBudgetMs?: number;
}): Promise<CampaignWaveRun> => {
  await assertCampaignsEnabled();
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
    select: {
      id: true,
      templateKey: true,
      audienceSpec: true,
      locales: true,
      contentByLocale: true,
    },
  });
  const sequence = input.sequence ?? 1;
  const locales = readLocales(campaign.locales);
  const content = renderCampaignContent({
    templateKey: campaign.templateKey,
    locales,
    contentByLocale: campaign.contentByLocale,
  }).contentByLocale;

  const template = await ensureTemplateVersion({
    templateKey: campaign.templateKey,
    language: locales[0] ?? "en",
  });
  const definition = emailTemplateDefinition(campaign.templateKey);

  // The wave and its event commit together. A wave row pointing at no event is
  // a fan-out nothing will ever resume; an event with no wave is a send nothing
  // will ever account for.
  const wave = await prisma.$transaction(async (tx) => {
    // The unique wave index prevents two wave rows, but without this lock two
    // concurrent starts can each create an event before their upserts meet.
    // The losing upsert would then replace eventId and both callers could fan
    // out their own event, producing two emails per recipient. Serialise the
    // decision before either caller creates an event.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`email-campaign-wave:${campaign.id}:${input.kind}:${sequence}`}))`;
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
        payload: localizedCampaignEventPayload({
          locales,
          contentByLocale: content,
        }) as unknown as Prisma.InputJsonValue,
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
 * Delivery rows already sent are left as they are -- they record what was done.
 * Rows not yet sent are marked skipped (`campaign_cancelled`) in the same
 * transaction, and the lane re-checks the campaign immediately before each
 * send, so a row claimed while this runs does not go out either. Before this a
 * message waiting for its retry, or for a night window to end, went out after
 * the campaign had been cancelled.
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
    const deliveries = await tx.emailDelivery.updateMany({
      where: {
        status: "pending",
        event: { referenceType: "EmailCampaign", referenceId: input.campaignId },
      },
      data: {
        status: "skipped",
        skipReason: "campaign_cancelled",
        nextAttemptAt: null,
        claimedAt: null,
        deferReason: null,
      },
    });
    return {
      campaign,
      wavesCancelled: waves.count,
      deliveriesSkipped: deliveries.count,
    };
  });
};


/**
 * Creates or moves a wave's scheduled time, without starting it.
 *
 * A wave row exists before it runs, which is what makes scheduling possible at
 * all: a scheduler can only find work somebody wrote down. The row is `pending`
 * with no event, which the wave CHECK already allows -- that state was in the
 * schema from the second slice and had no writer until now.
 */
export const scheduleCampaignWave = async (input: {
  campaignId: string;
  kind: WaveKind;
  sequence?: number;
  scheduledAt: Date | null;
  recipientCap?: number;
  dryRun?: boolean;
}) => {
  await assertCampaignsEnabled();
  const sequence = input.sequence ?? 1;
  return prisma.emailCampaignWave.upsert({
    where: {
      campaignId_kind_sequence: {
        campaignId: input.campaignId,
        kind: input.kind,
        sequence,
      },
    },
    create: {
      campaignId: input.campaignId,
      kind: input.kind,
      sequence,
      status: "pending",
      scheduledAt: input.scheduledAt,
      ...(input.recipientCap === undefined
        ? {}
        : { recipientCap: input.recipientCap }),
      dryRun: Boolean(input.dryRun),
    },
    // Only the time. Re-scheduling a wave is not an opportunity to quietly
    // change its cap or turn a dry run into a real one -- those are separate
    // edits with separate consequences.
    update: { scheduledAt: input.scheduledAt },
    select: { id: true, kind: true, sequence: true, scheduledAt: true, status: true },
  });
};

/**
 * Everything wrong with a campaign's schedule as it currently stands.
 *
 * Read from the rows rather than from a proposal, so an operator can ask the
 * question after editing one wave -- which is when an ordering mistake is
 * actually made.
 */
export const campaignScheduleProblems = async (input: {
  campaignId: string;
  now?: Date;
}) => {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: input.campaignId },
    select: { effectiveAt: true },
  });
  const waves = await prisma.emailCampaignWave.findMany({
    where: { campaignId: input.campaignId, status: { not: "cancelled" } },
    orderBy: [{ scheduledAt: "asc" }, { sequence: "asc" }],
    select: { kind: true, scheduledAt: true },
  });
  return scheduleProblems({
    waves: waves as WaveSchedule[],
    now: input.now ?? new Date(),
    effectiveAt: campaign.effectiveAt,
  });
};

export type DueWaveOutcome = {
  waveId: string;
  campaignId: string;
  kind: string;
  started: boolean;
  refusal: string | null;
};

/**
 * Starts every wave that is due, and says why it skipped the ones it did not.
 *
 * Two gates, asked in this order and never collapsed into one. `scheduleRefusal`
 * answers "was this automation asked for and is it time" -- a question about the
 * operator's intent. `campaignSendRefusal` answers "may these words go out" --
 * a question about approval, and the one EM-06 exists for. A wave passing the
 * first and failing the second is the important case: the schedule was set and
 * the copy changed underneath it, and nothing should send.
 */
export const runDueCampaignWaves = async (input?: {
  now?: Date;
  limit?: number;
}): Promise<DueWaveOutcome[]> => {
  // The scheduler asks rather than asserts. It runs on the fifteen-minute cron
  // beside unrelated work, and an exception here would take that whole pass
  // down over a switch being off -- which is a normal state, not a fault.
  if (!(await isEmailCampaignsEnabled())) return [];
  const now = input?.now ?? new Date();
  const due = await prisma.emailCampaignWave.findMany({
    where: {
      status: "pending",
      scheduledAt: { not: null, lte: now },
      campaign: { triggerMode: "approved_schedule" },
    },
    orderBy: { scheduledAt: "asc" },
    take: input?.limit ?? 25,
    select: {
      id: true,
      campaignId: true,
      kind: true,
      sequence: true,
      status: true,
      scheduledAt: true,
      eventId: true,
      campaign: { select: { triggerMode: true } },
    },
  });

  const outcomes: DueWaveOutcome[] = [];
  for (const wave of due) {
    const base = {
      waveId: wave.id,
      campaignId: wave.campaignId,
      kind: wave.kind,
    };

    const blocked: ScheduleRefusalDetail | null = scheduleRefusal(
      {
        kind: wave.kind,
        status: wave.status,
        scheduledAt: wave.scheduledAt,
        eventId: wave.eventId,
        triggerMode: wave.campaign.triggerMode,
      },
      now
    );
    if (blocked) {
      outcomes.push({ ...base, started: false, refusal: blocked.refusal });
      continue;
    }

    const run = await runCampaignWave({
      campaignId: wave.campaignId,
      kind: wave.kind as WaveKind,
      sequence: wave.sequence,
    });
    outcomes.push({
      ...base,
      started: !("refused" in run),
      refusal: "refused" in run ? run.refused.refusal : null,
    });
  }
  return outcomes;
};


/**
 * The digest the campaign's copy hashes to right now.
 *
 * The same numbers `campaignSendRefusal` compares against the pin, folded into
 * one value so an attestation about the body has something to be bound to.
 */
export const campaignDigest = async (campaignId: string) => {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { templateKey: true, locales: true, contentByLocale: true },
  });
  return campaignContentDigest(
    currentHashes({
      templateKey: campaign.templateKey,
      locales: readLocales(campaign.locales),
      contentByLocale: campaign.contentByLocale,
    })
  );
};

/** The exact campaign-authored body an administrator is asked to approve. */
export const campaignEmailPreviews = async (
  campaignId: string
): Promise<{ previews: CampaignEmailPreview[]; copyDigest: string | null }> => {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { templateKey: true, locales: true, contentByLocale: true },
  });
  const rendered = renderCampaignContent({
    templateKey: campaign.templateKey,
    locales: readLocales(campaign.locales),
    contentByLocale: campaign.contentByLocale,
  });
  return {
    previews: rendered.previews,
    copyDigest: campaignContentDigest(
      Object.fromEntries(
        rendered.previews.map((preview) => [
          preview.language,
          preview.contentHash,
        ])
      )
    ),
  };
};

/**
 * Records one attestation, replacing any standing one of the same kind.
 *
 * Replacing rather than stacking, so "who says this is true" has one answer.
 * The digest is captured here rather than passed in: an attestation bound to a
 * digest its author supplied would be bound to whatever they believed the copy
 * was, which is the belief being checked.
 */
export const recordCampaignAttestation = async (input: {
  campaignId: string;
  kind: AttestationKind;
  attestedByEmail: string;
  note?: string | null;
}) => {
  const contentDigest = isContentBound(input.kind)
    ? await campaignDigest(input.campaignId)
    : null;
  if (isContentBound(input.kind) && !contentDigest) {
    // Refused rather than stored with a null digest: an attestation about words
    // nobody can hash is one nothing can ever invalidate.
    throw new Error(
      `${input.kind} cannot be attested while the campaign's copy has no digest -- its template renders nothing for the languages it lists.`
    );
  }
  return prisma.emailCampaignAttestation.upsert({
    where: {
      campaignId_kind: { campaignId: input.campaignId, kind: input.kind },
    },
    create: {
      campaignId: input.campaignId,
      kind: input.kind,
      attestedByEmail: input.attestedByEmail,
      note: input.note ?? null,
      contentDigest,
    },
    update: {
      attestedByEmail: input.attestedByEmail,
      attestedAt: new Date(),
      note: input.note ?? null,
      contentDigest,
    },
    select: { id: true, kind: true, attestedByEmail: true, attestedAt: true },
  });
};

/** Withdraws one. Deleting is the whole operation: absent is unmet. */
export const withdrawCampaignAttestation = (input: {
  campaignId: string;
  kind: AttestationKind;
}) =>
  prisma.emailCampaignAttestation.deleteMany({
    where: { campaignId: input.campaignId, kind: input.kind },
  });

export const campaignAttestationStates = async (campaignId: string) => {
  const [stored, currentDigest] = await Promise.all([
    prisma.emailCampaignAttestation.findMany({
      where: { campaignId },
      select: {
        kind: true,
        attestedByEmail: true,
        attestedAt: true,
        contentDigest: true,
      },
    }),
    campaignDigest(campaignId),
  ]);
  return attestationStates({
    stored: stored as StoredAttestation[],
    currentDigest,
  });
};

/**
 * Whether this campaign may promise an automatic transition, and what is
 * missing if not.
 *
 * Every fact is read here and judged in `lib/automaticTransitionClaim.ts`. The
 * split is the point: the twelve conditions are worth reading in one place
 * without a database in the way.
 */
export const campaignTransitionClaim = async (campaignId: string) => {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: {
      workItemId: true,
      replacementModelId: true,
      effectiveAt: true,
      timezoneLabel: true,
      approvalId: true,
    },
  });

  const workItem = campaign.workItemId
    ? await prisma.modelLifecycleWorkItem.findUnique({
        where: { id: campaign.workItemId },
        select: {
          action: true,
          status: true,
          linkedIssueUrl: true,
          ownerEmail: true,
        },
      })
    : null;

  const replacement = campaign.replacementModelId
    ? await prisma.modelRegistryEntry.findUnique({
        where: { id: campaign.replacementModelId },
        select: { enabled: true, publiclyListed: true, catalogDeleted: true },
      })
    : null;

  // Only a consumed approval counts. One that was merely requested is a
  // question somebody asked, not an answer they got.
  const approvalConsumed = campaign.approvalId
    ? (
        await prisma.adminActionApproval.findUnique({
          where: { id: campaign.approvalId },
          select: { status: true },
        })
      )?.status === "consumed"
    : false;

  const [dryRunWave, completionWave, planIncompatibleCount] = await Promise.all([
    prisma.emailCampaignWave.findFirst({
      where: { campaignId, dryRun: true, expandedCount: { gt: 0 } },
      orderBy: { createdAt: "desc" },
      select: { expandedCount: true },
    }),
    prisma.emailCampaignWave.findFirst({
      where: { campaignId, kind: "completion", scheduledAt: { not: null } },
      select: { scheduledAt: true },
    }),
    prisma.emailCampaignRecipient.count({
      where: { campaignId, excludedReason: "plan_incompatible" },
    }),
  ]);

  const states = await campaignAttestationStates(campaignId);

  return {
    claim: automaticTransitionClaim({
      workItem: workItem
        ? {
            found: true,
            action: workItem.action,
            status: workItem.status,
            retirementTicketUrl: workItem.linkedIssueUrl,
            ownerEmail: workItem.ownerEmail,
          }
        : null,
      effectiveAt: campaign.effectiveAt,
      timezoneLabel: campaign.timezoneLabel,
      replacement: replacement
        ? { found: true, ...replacement }
        : campaign.replacementModelId
          ? { found: false, enabled: false, publiclyListed: false, catalogDeleted: false }
          : null,
      planIncompatibleCount,
      dryRunRecipientCount: dryRunWave?.expandedCount ?? null,
      communicationApprovalConsumed: approvalConsumed,
      completionWaveScheduledAt: completionWave?.scheduledAt ?? null,
      attestations: attestationsForClaim(states),
    }),
    attestations: states,
  };
};

/**
 * How many candidates one estimate will walk before it stops and says so.
 *
 * The scan visits every account that names the retiring model, which is the
 * number being asked about -- so it is most expensive on exactly the audience
 * an operator most wants sized. Bounded here because a person is waiting for
 * the answer; past the bound the summary reports `truncated` and every figure
 * in it is a floor, which the screen states rather than rounding away.
 */
export const AUDIENCE_ESTIMATE_MAX_CANDIDATES = 20_000;

export type EstimateRefusal =
  | "not_found"
  | "no_cohort"
  | "cancelled"
  | "already_approved";

export const ESTIMATE_REFUSAL_MESSAGE: Record<EstimateRefusal, string> = {
  not_found: "This campaign no longer exists.",
  no_cohort:
    "This campaign names its recipients explicitly rather than by cohort, so there is nothing to count: the audience is exactly the list it carries.",
  cancelled: "This campaign was cancelled.",
  already_approved:
    "This campaign is already approved. Its audience is measured again by each wave as it runs, and re-estimating now would overwrite the number the approver read.",
};

export type MarketingConsentAudienceSummary = {
  kind: "marketing_consent";
  purpose: "product_updates";
  /** Accounts with a current, timestamped opt-in, before account gates. */
  consented: number;
  active: number;
  /** The expansion candidates; send-time gates may reduce this further. */
  activeWithEmail: number;
  cohortRows: Record<string, number>;
  cohortUsers: Record<string, number>;
  distinctUsers: number;
  excluded: Record<string, number>;
  noticeAudience: number;
  autoMigratable: number;
  malformed: number;
  truncated: boolean;
};

export type CampaignAudienceSummary =
  | AudienceSummary
  | MarketingConsentAudienceSummary;

/**
 * Measures the audience and stores the result on the campaign.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11, §12.3.
 *
 * `estimatedRecipients` and `audienceVersion` have been on the row since the
 * fourth slice with nothing writing them from the audience: the number came
 * from an operator typing it, and the version answered "1" for estimates no
 * version of the rules had produced. `summariseRetirementAudience` has existed
 * since the third and was called only by its own test.
 *
 * The stored headline is `noticeAudience` -- who the notice actually goes to,
 * after exclusions -- and not `distinctUsers`. A campaign sized on everyone in
 * the cohort would be sized on people it is about to decide not to write to.
 *
 * Refused once approved. Re-measuring then would replace the number the
 * approver read with a different one under the same approval, and each wave
 * recomputes its own audience as it runs anyway.
 */
export const estimateCampaignAudience = async (input: {
  campaignId: string;
  byEmail: string;
  now?: Date;
  maxCandidates?: number;
}): Promise<
  | { refused: EstimateRefusal; message: string }
  | {
      estimatedRecipients: number;
      audienceVersion: number;
      estimatedAt: Date;
      summary: CampaignAudienceSummary;
    }
> => {
  await assertCampaignsEnabled();
  const campaign = await prisma.emailCampaign.findUnique({
    where: { id: input.campaignId },
    select: {
      status: true,
      templateKey: true,
      audienceSpec: true,
      replacementModelId: true,
    },
  });
  if (!campaign) {
    return { refused: "not_found", message: ESTIMATE_REFUSAL_MESSAGE.not_found };
  }
  if (campaign.status === "cancelled") {
    return { refused: "cancelled", message: ESTIMATE_REFUSAL_MESSAGE.cancelled };
  }
  if (campaign.status !== "draft" && campaign.status !== "pending_approval") {
    return {
      refused: "already_approved",
      message: ESTIMATE_REFUSAL_MESSAGE.already_approved,
    };
  }

  const spec = readExpansionSpec(campaign.audienceSpec);
  if (!spec.cohort) {
    return { refused: "no_cohort", message: ESTIMATE_REFUSAL_MESSAGE.no_cohort };
  }

  if (spec.cohort.kind === "marketing_consent") {
    const preference = {
      purpose: spec.cohort.purpose,
      enabled: true,
      grantedAt: { not: null },
    } as const;
    const [consented, active, activeWithEmail] = await Promise.all([
      prisma.user.count({
        where: { emailPreferences: { some: preference } },
      }),
      prisma.user.count({
        where: {
          accountStatus: "active",
          emailPreferences: { some: preference },
        },
      }),
      prisma.user.count({
        where: {
          accountStatus: "active",
          email: { not: null },
          emailPreferences: { some: preference },
        },
      }),
    ]);
    const summary: MarketingConsentAudienceSummary = {
      kind: "marketing_consent",
      purpose: spec.cohort.purpose,
      consented,
      active,
      activeWithEmail,
      cohortRows: { marketing_consent: consented },
      cohortUsers: { marketing_consent: consented },
      distinctUsers: consented,
      excluded: {
        no_email: active - activeWithEmail,
        account_inactive: consented - active,
        suppressed: 0,
        plan_incompatible: 0,
      },
      noticeAudience: activeWithEmail,
      autoMigratable: 0,
      malformed: 0,
      truncated: false,
    };
    const estimatedAt = input.now ?? new Date();
    await prisma.emailCampaign.update({
      where: { id: input.campaignId },
      data: {
        estimatedRecipients: activeWithEmail,
        audienceVersion: 1,
        estimatedAt,
        estimatedByEmail: input.byEmail,
        audienceEstimate: summary,
      },
    });
    return {
      estimatedRecipients: activeWithEmail,
      audienceVersion: 1,
      estimatedAt,
      summary,
    };
  }

  // The template's own classification and purpose, not a guess: suppression
  // answers differently for each, so asking under the wrong one produces an
  // exclusion count that is right about a send nobody is making.
  const definition = emailTemplateDefinition(campaign.templateKey);
  const summary = await summariseRetirementAudience({
    targetModelId: spec.cohort.targetModelId,
    // The spec's replacement, not the campaign column's: the count is about the
    // audience this campaign will actually expand, and the expander reads the
    // spec.
    replacementModelId: spec.cohort.replacementModelId,
    purpose: definition.purpose,
    classification: definition.classification,
    maxCandidates: input.maxCandidates ?? AUDIENCE_ESTIMATE_MAX_CANDIDATES,
  });

  const estimatedAt = input.now ?? new Date();
  await prisma.emailCampaign.update({
    where: { id: input.campaignId },
    data: {
      // One statement, so the headline and the summary it came from cannot
      // drift apart, and so the completeness CHECK is satisfied by every write.
      estimatedRecipients: summary.noticeAudience,
      audienceVersion: AUDIENCE_DEFINITION_VERSION,
      estimatedAt,
      estimatedByEmail: input.byEmail,
      audienceEstimate: summary as unknown as Prisma.InputJsonValue,
    },
  });

  return {
    estimatedRecipients: summary.noticeAudience,
    audienceVersion: AUDIENCE_DEFINITION_VERSION,
    estimatedAt,
    summary,
  };
};
