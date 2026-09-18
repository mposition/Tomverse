/**
 * The only module that writes the marketing automation tables.
 *
 * Contract: docs/policy/marketing-automation.md. `npm run
 * check:protected-table-writers` refuses a `marketingChannel`,
 * `marketingPost`, `marketingReport` or `aiVisibilityRun` write anywhere else,
 * for the same reason the audit log has one writer: these rows are read back
 * later as evidence of what was published and on whose authority, and a second
 * writer is a second set of rules about what may be in them.
 *
 * What this module adds on top of the database's own constraints:
 *
 * - every JSON column is parsed with its strict schema from
 *   lib/marketingAutomationSchema.ts before the write, so a column that the
 *   database only knows as `jsonb` cannot receive a shape nothing can read
 *   back;
 * - `retentionUntil` is computed from the policy table rather than accepted
 *   from the caller, using Postgres's own month arithmetic so the value and the
 *   CHECK constraint agree on the 31st of a month as well as the 1st;
 * - an account's internal slug is assigned here, from the channel and the next
 *   free number, so no caller can put a handle or a person's name in it.
 *
 * Reads are not restricted: any module may query these tables. It is writing
 * that goes through here.
 *
 * There is deliberately no purge, compaction or delete function in this slice.
 * Retention is S3, and docs/policy/marketing-automation.md §12.2 requires every
 * purge to write a system audit entry in the same transaction; shipping a purge
 * API before that entry exists would leave a way to remove content with nothing
 * recording that it happened.
 */

import "server-only";

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import {
  aiVisibilityRetentionUntil,
  aiVisibilityAccuracyFlagsSchema,
  marketingEnvelopeSchema,
  marketingFactSnapshotSchema,
  marketingGraduationSnapshotSchema,
  marketingHistoryEntrySchema,
  marketingReportRetentionUntil,
  parseMarketingReportPayload,
  type AiVisibilitySearchMode,
  type MarketingChannelStatus,
  type MarketingChannel as MarketingChannelName,
  type MarketingEnvelope,
  type MarketingFactSnapshot,
  type MarketingGraduationSnapshot,
  type MarketingGuardDecision,
  type MarketingHistoryEntry,
  type MarketingLocale,
  type MarketingPostKind,
  type MarketingPostMode,
  type MarketingPostStatus,
  type MarketingProvider,
  type MarketingReportKind,
} from "@/lib/marketingAutomationSchema";

/**
 * Every function takes the client explicitly. A marketing write is part of a
 * larger change -- an approval and its audit entry, a publish and its history
 * entry -- and a module-level client would make it possible to write one of
 * those outside the transaction that wrote the other.
 */
export type MarketingDatabase = PrismaClient | Prisma.TransactionClient;

/** A write refused before it reached the database. */
export class MarketingStoreRefusedError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "MarketingStoreRefusedError";
    this.code = code;
  }
}

const asJson = (value: unknown): Prisma.InputJsonValue =>
  value as Prisma.InputJsonValue;

// ---------------------------------------------------------------------------
// Channels
// ---------------------------------------------------------------------------

export type CreateMarketingChannelInput = {
  channel: MarketingChannelName;
  provider: MarketingProvider;
  externalAccountRef: string | null;
  defaultLocale: MarketingLocale;
  allowedLocales: readonly MarketingLocale[];
  scopesDigest: string;
  policyVersion: number;
};

/**
 * The internal account name: the channel, a hyphen and the next free number.
 *
 * It is assigned here rather than accepted because the alternative is an
 * operator typing something, and the thing nearest to hand is the account's
 * public handle -- which is a person's or a brand's identifier on a platform,
 * and is not what this table is for. The unique index settles a race; this only
 * has to pick a number that is usually free.
 */
async function nextAccountSlug(
  database: MarketingDatabase,
  channel: MarketingChannelName,
): Promise<string> {
  const existing = await database.marketingChannel.count({ where: { channel } });
  const candidate = existing + 1;
  if (candidate > 999) {
    throw new MarketingStoreRefusedError(
      "account_slug_exhausted",
      `No free account slug for ${channel}`,
    );
  }
  return `${channel}-${candidate}`;
}

export async function createMarketingChannel(
  database: MarketingDatabase,
  input: CreateMarketingChannelInput,
) {
  if (!input.allowedLocales.includes(input.defaultLocale)) {
    throw new MarketingStoreRefusedError(
      "default_locale_not_allowed",
      "A channel's default locale must be one of its allowed locales",
    );
  }

  return database.marketingChannel.create({
    data: {
      channel: input.channel,
      provider: input.provider,
      externalAccountRef: input.externalAccountRef,
      accountSlug: await nextAccountSlug(database, input.channel),
      defaultLocale: input.defaultLocale,
      allowedLocales: [...input.allowedLocales],
      scopesDigest: input.scopesDigest,
      policyVersion: input.policyVersion,
      status: "connect_pending",
    },
  });
}

export type MarketingChannelPatch = {
  status?: MarketingChannelStatus;
  approvalStartedAt?: Date | null;
  graduatedAt?: Date | null;
  graduationEpoch?: number;
  graduationSnapshot?: MarketingGraduationSnapshot | null;
  pausedAt?: Date | null;
  pausedFromMode?: "approval_mode" | "autonomous_mode" | null;
  pauseReasonCode?: string | null;
  connectionGeneration?: number;
  scopesDigest?: string;
  policyVersion?: number;
  dailyCapOverride?: number | null;
  weeklyCapOverride?: number | null;
};

/**
 * Which transitions are legal is the database's answer, not this module's: the
 * trigger sees every write however it arrived. What happens here is the JSON
 * parse, which the trigger cannot do.
 */
export async function updateMarketingChannel(
  database: MarketingDatabase,
  id: string,
  patch: MarketingChannelPatch,
) {
  const { graduationSnapshot, ...columns } = patch;
  const data: Prisma.MarketingChannelUpdateInput = { ...columns };

  if (graduationSnapshot !== undefined) {
    data.graduationSnapshot =
      graduationSnapshot === null
        ? Prisma.DbNull
        : asJson(marketingGraduationSnapshotSchema.parse(graduationSnapshot));
  }

  return database.marketingChannel.update({ where: { id }, data });
}

// ---------------------------------------------------------------------------
// Posts
// ---------------------------------------------------------------------------

export type CreateMarketingPostInput = {
  channelId: string;
  locale: MarketingLocale;
  kind: MarketingPostKind;
  logicalKey: string;
  envelope: MarketingEnvelope;
  envelopeDigest: string;
  rendererVersion: string;
  templateId: string | null;
  templateDigest: string | null;
  claimIds: readonly string[];
  assetIds: readonly string[];
  claimRegistryVersion: number;
  assetRegistryVersion: number;
  factSnapshot: MarketingFactSnapshot;
  guardDecision: MarketingGuardDecision;
  guardCodes: readonly string[];
  guardRuleIds: readonly string[];
  status: MarketingPostStatus;
  mode: MarketingPostMode;
  draftedAt: Date;
};

export async function createMarketingPost(
  database: MarketingDatabase,
  input: CreateMarketingPostInput,
) {
  const envelope = marketingEnvelopeSchema.parse(input.envelope);
  const factSnapshot = marketingFactSnapshotSchema.parse(input.factSnapshot);

  // The first history entry is written here, not by the caller: the insert
  // trigger requires exactly one entry of type `draft`, and a caller that could
  // supply the array could supply a history of events that never happened.
  const draftEntry = marketingHistoryEntrySchema.parse({
    at: input.draftedAt.toISOString(),
    type: "draft",
    envelopeDigest: input.envelopeDigest,
  });

  return database.marketingPost.create({
    data: {
      channelId: input.channelId,
      locale: input.locale,
      kind: input.kind,
      logicalKey: input.logicalKey,
      envelope: asJson(envelope),
      envelopeDigest: input.envelopeDigest,
      rendererVersion: input.rendererVersion,
      templateId: input.templateId,
      templateDigest: input.templateDigest,
      claimIds: [...input.claimIds],
      assetIds: [...input.assetIds],
      claimRegistryVersion: input.claimRegistryVersion,
      assetRegistryVersion: input.assetRegistryVersion,
      factSnapshot: asJson(factSnapshot),
      guardDecision: input.guardDecision,
      guardCodes: [...input.guardCodes],
      guardRuleIds: [...input.guardRuleIds],
      status: input.status,
      mode: input.mode,
      history: asJson([draftEntry]),
      historyVersion: 0,
    },
  });
}

export type MarketingPostPatch = {
  status?: MarketingPostStatus;
  mode?: MarketingPostMode;
  envelope?: MarketingEnvelope;
  envelopeDigest?: string;
  approvalAuditLogId?: string | null;
  approvedAt?: Date | null;
  approvedDigest?: string | null;
  approvalExpiresAt?: Date | null;
  reusableAsTemplate?: boolean;
  scheduledAt?: Date | null;
  slotDate?: Date | null;
  claimToken?: string | null;
  leaseUntil?: Date | null;
  publishAttempt?: number;
  providerRequestKey?: string | null;
  externalPostId?: string | null;
  externalUrl?: string | null;
  publishedAt?: Date | null;
  verifiedPublicAt?: Date | null;
  verificationMethod?: string | null;
  errorCode?: string | null;
  outcomeUnknownAt?: Date | null;
  deletedAt?: Date | null;
  deletionMethod?: string | null;
  legalHold?: boolean;
};

/**
 * Append one history entry and apply the change it describes, in one statement.
 *
 * `expectedVersion` is the compare-and-set: the update matches only while the
 * row still has the version the caller read, so two writers cannot each append
 * to the history they separately read and lose one of the entries. A mismatch
 * comes back as `null` rather than an exception -- a concurrent writer got
 * there first is an ordinary outcome for a publisher retrying a lease, not an
 * error.
 */
export async function appendMarketingPostHistory(
  database: MarketingDatabase,
  input: {
    id: string;
    expectedVersion: number;
    entry: MarketingHistoryEntry;
    patch?: MarketingPostPatch;
  },
): Promise<{ appended: boolean }> {
  const entry = marketingHistoryEntrySchema.parse(input.entry);
  if (entry.type === "retention_compaction") {
    throw new MarketingStoreRefusedError(
      "compaction_is_not_an_append",
      "A retention compaction is not an append; retention owns that write",
    );
  }

  const current = await database.marketingPost.findUnique({
    where: { id: input.id },
    select: { history: true, historyVersion: true },
  });
  if (!current || current.historyVersion !== input.expectedVersion) {
    return { appended: false };
  }

  const history = Array.isArray(current.history) ? current.history : [];
  const data: Prisma.MarketingPostUpdateInput = { ...input.patch };

  if (input.patch?.envelope !== undefined) {
    data.envelope = asJson(marketingEnvelopeSchema.parse(input.patch.envelope));
  }

  const updated = await database.marketingPost.updateMany({
    where: { id: input.id, historyVersion: input.expectedVersion },
    data: {
      ...(data as Prisma.MarketingPostUpdateManyMutationInput),
      history: asJson([...history, entry]),
      historyVersion: input.expectedVersion + 1,
    },
  });

  return { appended: updated.count === 1 };
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

export type InsertMarketingReportInput = {
  kind: MarketingReportKind;
  periodStart: Date;
  periodEnd: Date;
  payload: unknown;
  sourceVersion: string;
  createdAt: Date;
};

/**
 * `retentionUntil` is derived, never supplied: docs/policy/marketing-automation.md
 * §12.2 sets one period per kind, and a caller that could pass the column could
 * set its own row's life while the value still looked policy-shaped. The
 * constraint requires exact equality, so the arithmetic here has to be
 * Postgres's -- see `addMonthsLikePostgres`.
 */
export async function insertMarketingReport(
  database: MarketingDatabase,
  input: InsertMarketingReportInput,
) {
  const payload = parseMarketingReportPayload(input.kind, input.payload);

  if (input.periodStart.getTime() > input.periodEnd.getTime()) {
    throw new MarketingStoreRefusedError(
      "period_is_backwards",
      "A report period ends no earlier than it starts",
    );
  }

  return database.marketingReport.create({
    data: {
      kind: input.kind,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      payload: asJson(payload),
      sourceVersion: input.sourceVersion,
      createdAt: input.createdAt,
      retentionUntil: marketingReportRetentionUntil(input.kind, input.createdAt),
    },
  });
}

// ---------------------------------------------------------------------------
// AI visibility runs
// ---------------------------------------------------------------------------

export type InsertAiVisibilityRunInput = {
  promptSetVersion: string;
  promptId: string;
  locale: MarketingLocale;
  model: string;
  modelVersion: string;
  searchMode: AiVisibilitySearchMode;
  region: string;
  runAt: Date;
  mentioned: boolean;
  citedUrls: readonly string[];
  answerDigest: string;
  accuracyFlags: { flags: readonly string[] } | null;
};

export async function insertAiVisibilityRun(
  database: MarketingDatabase,
  input: InsertAiVisibilityRunInput,
) {
  const accuracyFlags =
    input.accuracyFlags === null
      ? null
      : aiVisibilityAccuracyFlagsSchema.parse(input.accuracyFlags);

  return database.aiVisibilityRun.create({
    data: {
      promptSetVersion: input.promptSetVersion,
      promptId: input.promptId,
      locale: input.locale,
      model: input.model,
      modelVersion: input.modelVersion,
      searchMode: input.searchMode,
      region: input.region,
      runAt: input.runAt,
      mentioned: input.mentioned,
      citedUrls: [...input.citedUrls],
      answerDigest: input.answerDigest,
      accuracyFlags: accuracyFlags === null ? Prisma.DbNull : asJson(accuracyFlags),
      retentionUntil: aiVisibilityRetentionUntil(input.runAt),
    },
  });
}
