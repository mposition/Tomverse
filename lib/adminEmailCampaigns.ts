import "server-only";

import { prisma } from "@/lib/prisma";
import type { WaveKind } from "@/lib/emailCampaignCore";
import { CAMPAIGN_EXCLUDED_REASONS } from "@/lib/emailCampaignRecipientCore";
import {
  ADDRESS_REVEAL_MAX_IDS,
  maskEmailAddress,
} from "@/lib/emailAddressMaskingCore";
import { AUDIENCE_COHORTS } from "@/lib/modelRetirementAudienceCore";
import { WAVE_ORDER } from "@/lib/emailCampaignScheduleCore";

/**
 * What the campaign console reads.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
 *
 * Held apart from `lib/emailCampaignService.ts` on purpose. That module decides
 * things -- what may send, what a schedule is missing, whether a promise can be
 * made -- and every function in it is called from a route that acts. This one
 * only reads, and it reads the shapes a screen needs rather than the shapes a
 * decision needs. Mixing them is how a list view ends up running the send
 * gate once per row.
 *
 * The per-campaign verdicts (`campaignSendRefusal`, `campaignScheduleProblems`,
 * `campaignTransitionClaim`) stay where they are and are asked once, on the
 * detail page, for the one campaign an operator opened.
 */

export type AdminCampaignRow = {
  id: string;
  category: string;
  templateKey: string;
  status: string;
  triggerMode: string;
  locales: string[];
  targetModelId: string | null;
  replacementModelId: string | null;
  claimsAutomaticTransition: boolean;
  estimatedRecipients: number | null;
  effectiveAt: Date | null;
  timezoneLabel: string | null;
  scheduledAt: Date | null;
  approvedAt: Date | null;
  createdByEmail: string;
  createdAt: Date;
  waveCount: number;
  /** Waves that came due and are still pending. */
  overdueWaves: number;
  /** The soonest pending wave, which is what "next" means on a list row. */
  nextWaveAt: Date | null;
};

const readLocales = (raw: unknown): string[] =>
  Array.isArray(raw)
    ? raw.filter((entry): entry is string => typeof entry === "string")
    : [];

/**
 * The newest campaigns, with just enough per-row state to choose one.
 *
 * Bounded at 100 and the panel says so. A campaign list is not a log: an
 * operator opens this to find the one they are working on, and the ones they
 * are working on are the recent ones.
 */
export const listAdminCampaigns = async (input?: {
  limit?: number;
  now?: Date;
}): Promise<AdminCampaignRow[]> => {
  const now = input?.now ?? new Date();
  const rows = await prisma.emailCampaign.findMany({
    orderBy: { createdAt: "desc" },
    take: input?.limit ?? 100,
    select: {
      id: true,
      category: true,
      templateKey: true,
      status: true,
      triggerMode: true,
      locales: true,
      targetModelId: true,
      replacementModelId: true,
      claimsAutomaticTransition: true,
      estimatedRecipients: true,
      effectiveAt: true,
      timezoneLabel: true,
      scheduledAt: true,
      approvedAt: true,
      createdByEmail: true,
      createdAt: true,
      waves: {
        select: { status: true, scheduledAt: true },
      },
    },
  });

  return rows.map((row) => {
    const pending = row.waves.filter(
      (wave) => wave.status === "pending" && wave.scheduledAt !== null
    );
    const upcoming = pending
      .map((wave) => wave.scheduledAt as Date)
      .sort((left, right) => left.getTime() - right.getTime());
    return {
      id: row.id,
      category: row.category,
      templateKey: row.templateKey,
      status: row.status,
      triggerMode: row.triggerMode,
      locales: readLocales(row.locales),
      targetModelId: row.targetModelId,
      replacementModelId: row.replacementModelId,
      claimsAutomaticTransition: row.claimsAutomaticTransition,
      estimatedRecipients: row.estimatedRecipients,
      effectiveAt: row.effectiveAt,
      timezoneLabel: row.timezoneLabel,
      scheduledAt: row.scheduledAt,
      approvedAt: row.approvedAt,
      createdByEmail: row.createdByEmail,
      createdAt: row.createdAt,
      waveCount: row.waves.length,
      overdueWaves: upcoming.filter((at) => at.getTime() <= now.getTime()).length,
      nextWaveAt: upcoming.find((at) => at.getTime() > now.getTime()) ?? null,
    };
  });
};

export type AdminCampaignWaveRow = {
  id: string;
  campaignId: string;
  campaignTemplateKey: string;
  campaignStatus: string;
  triggerMode: string;
  kind: string;
  sequence: number;
  status: string;
  scheduledAt: Date | null;
  dryRun: boolean;
  recipientCap: number | null;
  expandedCount: number;
  /** Due, still pending: the scheduler reached it and it did not go out. */
  overdue: boolean;
};

/**
 * Every wave that has a time, ordered by that time.
 *
 * Across campaigns rather than within one, because the question this section
 * answers -- what is about to send, and what should already have sent -- is not
 * a question about a campaign. Asked per campaign it takes as many page loads
 * as there are campaigns, which is why an overdue wave went unseen: nothing
 * listed waves anywhere.
 *
 * Waves with no scheduled time are omitted rather than sorted last. A wave held
 * for a person to start is not late and never will be, and putting it in a list
 * headed "due" makes the operator decide that for themselves on every visit.
 */
export const listCampaignSchedule = async (input?: {
  limit?: number;
  now?: Date;
}): Promise<AdminCampaignWaveRow[]> => {
  const now = input?.now ?? new Date();
  const rows = await prisma.emailCampaignWave.findMany({
    where: { scheduledAt: { not: null } },
    orderBy: { scheduledAt: "asc" },
    take: input?.limit ?? 100,
    select: {
      id: true,
      campaignId: true,
      kind: true,
      sequence: true,
      status: true,
      scheduledAt: true,
      dryRun: true,
      recipientCap: true,
      expandedCount: true,
      campaign: {
        select: { templateKey: true, status: true, triggerMode: true },
      },
    },
  });

  return rows.map((row) => ({
    id: row.id,
    campaignId: row.campaignId,
    campaignTemplateKey: row.campaign.templateKey,
    campaignStatus: row.campaign.status,
    triggerMode: row.campaign.triggerMode,
    kind: row.kind,
    sequence: row.sequence,
    status: row.status,
    scheduledAt: row.scheduledAt,
    dryRun: row.dryRun,
    recipientCap: row.recipientCap,
    expandedCount: row.expandedCount,
    overdue:
      row.status === "pending" &&
      row.scheduledAt !== null &&
      row.scheduledAt.getTime() <= now.getTime(),
  }));
};

/**
 * The sidebar's badge: approved sends that were due and have not happened.
 *
 * Scoped to `approved_schedule`, which is the only trigger mode the scheduler
 * acts on. A `manual` wave with a time in the past is a note about when
 * somebody meant to send it, not a job that failed, and counting it would put a
 * number on the sidebar that no action clears.
 */
export const overdueCampaignWaveCount = async (input?: {
  now?: Date;
}): Promise<number> =>
  prisma.emailCampaignWave.count({
    where: {
      status: "pending",
      scheduledAt: { not: null, lte: input?.now ?? new Date() },
      campaign: { triggerMode: "approved_schedule" },
    },
  });

/** Sort order for waves of one campaign, by meaning rather than by time. */
export const waveOrderIndex = (kind: string): number => {
  const index = (WAVE_ORDER as readonly string[]).indexOf(kind);
  return index === -1 ? WAVE_ORDER.length : index;
};

export type AdminCampaignDetail = NonNullable<
  Awaited<ReturnType<typeof readAdminCampaign>>
>;

/**
 * One campaign, with its waves in the order they are meant to happen.
 *
 * `WAVE_ORDER` rather than `scheduledAt`: a reminder scheduled before its
 * announcement is a mistake the detail page has to show as a mistake, and a
 * list sorted by time renders that mistake as a correct-looking sequence.
 */
export const readAdminCampaign = async (campaignId: string) => {
  const campaign = await prisma.emailCampaign.findUnique({
    where: { id: campaignId },
    select: {
      id: true,
      category: true,
      templateKey: true,
      status: true,
      triggerMode: true,
      locales: true,
      audienceSpec: true,
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
        select: {
          id: true,
          kind: true,
          sequence: true,
          status: true,
          scheduledAt: true,
          dryRun: true,
          recipientCap: true,
          expandedCount: true,
          eventId: true,
          updatedAt: true,
        },
      },
    },
  });
  if (!campaign) return null;

  const waves = [...campaign.waves].sort(
    (left, right) =>
      waveOrderIndex(left.kind) - waveOrderIndex(right.kind) ||
      left.sequence - right.sequence
  );

  return {
    ...campaign,
    locales: readLocales(campaign.locales),
    waves,
  };
};

export type WaveAudienceBreakdown = {
  waveId: string;
  kind: string;
  sequence: number;
  dryRun: boolean;
  /** Ledger rows for this wave, however they ended. */
  total: number;
  /**
   * Rows with no exclusion reason: a delivery row was written for them.
   *
   * Not "was sent to". On a dry-run wave every one of these deliveries was
   * written `skipped` with `skipReason = dry_run`, so a screen that called this
   * column "sent" would report a rehearsal as a send -- which is the one thing
   * a rehearsal must never be mistaken for.
   */
  written: number;
  /** Stored values the parser could not read. Reported, never rewritten. */
  malformed: number;
  excluded: Record<string, number>;
  cohorts: Record<string, number>;
};

/**
 * Who each wave reached, and who it did not reach and why.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.3, §13.1.
 *
 * `EmailCampaignRecipient` has been written since the third slice and read by
 * nothing an operator can open: the expander writes it, the expander reads it
 * back to resume, one count feeds the transition gate, and the account export
 * returns a person their own row. So the exclusion reasons that slice recorded
 * -- the whole point of recording them -- had nowhere to be looked at, and a
 * dry run, whose only job is to answer "who would this have reached", produced
 * an answer nobody could read.
 *
 * Counts, not people. Every row holds an address, and whether an operator may
 * see addresses on a campaign screen is the same open question as D10 for
 * `/admin/email-delivery` (section 21). Answering it by building the list would
 * be deciding it.
 */
export const waveAudienceBreakdown = async (
  campaignId: string
): Promise<WaveAudienceBreakdown[]> => {
  const waves = await prisma.emailCampaignWave.findMany({
    where: { campaignId },
    select: { id: true, kind: true, sequence: true, dryRun: true },
  });
  if (waves.length === 0) return [];

  // Three grouped reads rather than one pass over the rows: the ledger is one
  // row per person per wave, and a campaign that reached its audience has as
  // many as the audience is large.
  const [byExclusion, byCohort, malformed] = await Promise.all([
    prisma.emailCampaignRecipient.groupBy({
      by: ["waveId", "excludedReason"],
      where: { campaignId },
      _count: { _all: true },
    }),
    prisma.emailCampaignRecipient.groupBy({
      by: ["waveId", "eligibilityReason"],
      where: { campaignId },
      _count: { _all: true },
    }),
    prisma.emailCampaignRecipient.groupBy({
      by: ["waveId"],
      where: { campaignId, malformed: true },
      _count: { _all: true },
    }),
  ]);

  const malformedByWave = new Map(
    malformed.map((row) => [row.waveId, row._count._all])
  );

  return waves
    .sort(
      (left, right) =>
        waveOrderIndex(left.kind) - waveOrderIndex(right.kind) ||
        left.sequence - right.sequence
    )
    .map((wave) => {
      const exclusionRows = byExclusion.filter((row) => row.waveId === wave.id);
      const excluded: Record<string, number> = {};
      // Every reason is present, including the zeroes. A breakdown that omits
      // the reasons that did not fire reads as though they were not asked, and
      // "nobody was suppressed" is the answer an operator most wants to see
      // stated rather than inferred from an absence.
      for (const reason of CAMPAIGN_EXCLUDED_REASONS) excluded[reason] = 0;
      let written = 0;
      let total = 0;
      for (const row of exclusionRows) {
        total += row._count._all;
        if (row.excludedReason === null) written += row._count._all;
        else if (row.excludedReason in excluded) {
          excluded[row.excludedReason] += row._count._all;
        } else {
          // A reason the application no longer names. Kept rather than dropped:
          // a row written by an older deployment is still a person who was not
          // written to, and silently discarding it would make the columns stop
          // adding up to the total.
          excluded[row.excludedReason] = row._count._all;
        }
      }

      const cohorts: Record<string, number> = {};
      for (const cohort of AUDIENCE_COHORTS) cohorts[cohort] = 0;
      for (const row of byCohort.filter((entry) => entry.waveId === wave.id)) {
        if (row.eligibilityReason === null) continue;
        cohorts[row.eligibilityReason] =
          (cohorts[row.eligibilityReason] ?? 0) + row._count._all;
      }

      return {
        waveId: wave.id,
        kind: wave.kind,
        sequence: wave.sequence,
        dryRun: wave.dryRun,
        total,
        written,
        malformed: malformedByWave.get(wave.id) ?? 0,
        excluded,
        cohorts,
      };
    });
};

/**
 * One person in one wave's expansion ledger, as a screen may see them.
 *
 * Contract: .github/audits/model-lifecycle-email-2026-08-22.md §21 (D10),
 * decided 2026-08-24; the ledger itself is
 * .github/audits/model-lifecycle-email-2026-08-22.md §44.
 *
 * ## Why this exists now and not in the seventh slice
 *
 * `waveAudienceBreakdown()` reports counts, and it reports them because when it
 * was written the ledger held addresses and nobody had decided whether an
 * operator may see one. Building the list then would have been answering that
 * question by writing code. D10 answered it — masked by default, revealed by an
 * audited act — so the list can exist, under the same rule as
 * `/admin/email-delivery`.
 *
 * ## The address is masked here, not at the edge
 *
 * The raw value never leaves this function, so it is not in the API response
 * and not in the browser. An operator who does not press the reveal never had
 * it. `emailAddress` is *absent* from the type rather than optional, so a panel
 * cannot render it by forgetting a check: the field it would reach for does not
 * exist and the compiler says so.
 */
export type AdminWaveRecipientRow = {
  id: string;
  emailAddressMasked: string | null;
  language: string | null;
  jurisdictionCountry: string | null;
  /** Which cohort put them in the audience; NULL means they left it. */
  eligibilityReason: string | null;
  /** NULL means a delivery row was written for them. */
  excludedReason: string | null;
  /** Whether a delivery row exists, without saying which one. */
  hasDelivery: boolean;
  malformed: boolean;
  createdAt: Date;
};

export type AdminWaveRecipientPage = {
  rows: AdminWaveRecipientRow[];
  /** The `id` to pass as `cursor` for the next page, or null at the end. */
  nextCursor: string | null;
  /** What the caller asked for, so a screen can say what it is showing. */
  limit: number;
};

/**
 * The maximum page of ledger rows.
 *
 * The reveal cap, deliberately: D10 made the screen the unit, so a page that
 * could hold more rows than one reveal covers would offer a button that fails
 * on a page which looks like every other page.
 */
export const WAVE_RECIPIENT_PAGE_MAX = ADDRESS_REVEAL_MAX_IDS;
export const WAVE_RECIPIENT_PAGE_SIZE = 50;

/**
 * One page of a wave's ledger.
 *
 * Scoped by campaign *and* wave, both in the `where`. The route resolves the
 * campaign from the URL and takes the wave from a parameter, so a wave id
 * belonging to another campaign has to be absent rather than refused -- the
 * same reason `revealEmailAddresses` scopes by id alone and the route decides
 * who may call it. Ordered by `createdAt` then `id`, which is the order the
 * expansion wrote them and is total because `id` breaks the ties.
 */
export const listWaveRecipients = async (input: {
  campaignId: string;
  waveId: string;
  cursor?: string | null;
  limit?: number;
}): Promise<AdminWaveRecipientPage> => {
  const limit = Math.min(
    Math.max(Math.trunc(input.limit ?? WAVE_RECIPIENT_PAGE_SIZE), 1),
    WAVE_RECIPIENT_PAGE_MAX
  );

  const rows = await prisma.emailCampaignRecipient.findMany({
    where: { campaignId: input.campaignId, waveId: input.waveId },
    select: {
      id: true,
      emailAddress: true,
      language: true,
      jurisdictionCountry: true,
      eligibilityReason: true,
      excludedReason: true,
      deliveryId: true,
      malformed: true,
      createdAt: true,
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    // One more than asked for, to learn whether there is a next page without
    // counting the table. A count would be a second query whose answer is stale
    // by the time it is rendered.
    take: limit + 1,
    ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
  });

  const page = rows.slice(0, limit);
  return {
    rows: page.map(({ emailAddress, deliveryId, ...rest }) => ({
      ...rest,
      emailAddressMasked: maskEmailAddress(emailAddress),
      // Whether, not which. The delivery id is this row's link into the outbox
      // and a screen showing people has no use for it, while an id in a
      // response is an id somebody can ask another endpoint about.
      hasDelivery: deliveryId !== null,
    })),
    nextCursor: rows.length > limit ? page[page.length - 1].id : null,
    limit,
  };
};

export type { WaveKind };
