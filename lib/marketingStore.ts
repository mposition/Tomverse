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
 *   lib/marketingAutomationSchema.ts before the write -- including a history
 *   array it is only rewriting, because an entry that reached the column some
 *   other way would otherwise be carried forward by the next append;
 * - a patch is copied field by field rather than spread, so a caller that got
 *   past TypeScript cannot reach a column this module does not name;
 * - the two movements that are an operator's decision -- resuming an account
 *   into autonomous mode, and re-queueing a failed post -- have their audit
 *   entry read and checked here (lib/marketingAuditEvidence.ts). The trigger can
 *   see that the column changed; only this can see what the entry says.
 *
 * What it deliberately does not do:
 *
 * - it does not compute `createdAt` or `retentionUntil`. Those are set by
 *   BEFORE INSERT triggers from the server clock, so no caller can date a row
 *   into the past and delete it, and the equality constraint cannot be argued
 *   with. The periods still live in MARKETING_REPORT_RETENTION for the
 *   application to read and for the unit test to compare the trigger against.
 * - it ships no purge, compaction or delete. Retention is a later slice, and
 *   docs/policy/marketing-automation.md §12.2 requires every purge to write a
 *   system audit entry in the same transaction; shipping a purge API before
 *   that entry exists would leave a way to remove content with nothing
 *   recording that it happened.
 *
 * Reads are not restricted: any module may query these tables. It is writing
 * that goes through here.
 */

import "server-only";

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import {
  aiVisibilityAccuracyFlagsSchema,
  aiVisibilityCitedUrlsSchema,
  marketingEnvelopeSchema,
  marketingFactSnapshotSchema,
  marketingGraduationSnapshotSchema,
  marketingHistoryEntrySchema,
  marketingHistorySchema,
  parseMarketingReportPayload,
  MARKETING_APPENDABLE_HISTORY_TYPES,
  type AiVisibilitySearchMode,
  type MarketingChannelStatus,
  type MarketingChannel as MarketingChannelName,
  type MarketingDeletionMethod,
  type MarketingEnvelope,
  type MarketingFactSnapshot,
  type MarketingGraduationSnapshot,
  type MarketingGuardDecision,
  type MarketingHistoryEntry,
  type MarketingLocale,
  type MarketingPausableMode,
  type MarketingPostKind,
  type MarketingPostMode,
  type MarketingPostStatus,
  type MarketingProvider,
  type MarketingReportKind,
  type MarketingResumeReasonCode,
  type MarketingVerificationMethod,
} from "@/lib/marketingAutomationSchema";
import { verifyMarketingAuditEvidence } from "@/lib/marketingAuditEvidence";

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

/** The audit actions that authorise the two operator-only movements. */
export const MARKETING_RESUME_AUTONOMOUS_ACTION = "marketing_account.resume_autonomous";
export const MARKETING_REQUEUE_ACTION = "marketing_post.requeue_after_failure";

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

/**
 * The columns an update may set, and the whole of it.
 *
 * `pausedAt`, `pausedFromMode`, `approvalStartedAt` and `createdAt` are not
 * here: the trigger writes them from the transition and the server clock, and a
 * field a caller could set is a field a caller could set wrongly.
 */
export type MarketingChannelPatch = {
  status?: MarketingChannelStatus;
  graduatedAt?: Date | null;
  graduationEpoch?: number;
  graduationSnapshot?: MarketingGraduationSnapshot | null;
  pauseReasonCode?: string | null;
  connectionGeneration?: number;
  scopesDigest?: string;
  policyVersion?: number;
  dailyCapOverride?: number | null;
  weeklyCapOverride?: number | null;
};

/** What an operator supplies when returning an account to autonomous mode. */
export type MarketingResumeEvidence = {
  auditLogId: string;
  reasonCode: MarketingResumeReasonCode;
};

/**
 * Which transitions are legal is the database's answer, not this module's: the
 * trigger sees every write however it arrived. What happens here is the JSON
 * parse and the audit check, neither of which the trigger can do.
 */
export async function updateMarketingChannel(
  database: MarketingDatabase,
  id: string,
  patch: MarketingChannelPatch,
  resume?: MarketingResumeEvidence,
) {
  const data: Prisma.MarketingChannelUpdateInput = {};

  if (patch.status !== undefined) data.status = patch.status;
  if (patch.graduatedAt !== undefined) data.graduatedAt = patch.graduatedAt;
  if (patch.graduationEpoch !== undefined) {
    data.graduationEpoch = patch.graduationEpoch;
  }
  if (patch.pauseReasonCode !== undefined) {
    data.pauseReasonCode = patch.pauseReasonCode;
  }
  if (patch.connectionGeneration !== undefined) {
    data.connectionGeneration = patch.connectionGeneration;
  }
  if (patch.scopesDigest !== undefined) data.scopesDigest = patch.scopesDigest;
  if (patch.policyVersion !== undefined) data.policyVersion = patch.policyVersion;
  if (patch.dailyCapOverride !== undefined) {
    data.dailyCapOverride = patch.dailyCapOverride;
  }
  if (patch.weeklyCapOverride !== undefined) {
    data.weeklyCapOverride = patch.weeklyCapOverride;
  }
  if (patch.graduationSnapshot !== undefined) {
    data.graduationSnapshot =
      patch.graduationSnapshot === null
        ? Prisma.DbNull
        : asJson(marketingGraduationSnapshotSchema.parse(patch.graduationSnapshot));
  }

  if (patch.status === "autonomous_mode") {
    const current = await database.marketingChannel.findUnique({
      where: { id },
      select: { status: true },
    });
    if (current?.status === "paused") {
      if (!resume) {
        throw new MarketingStoreRefusedError(
          "resume_evidence_missing",
          "Returning an account to autonomous mode needs the operator's reason and audit entry",
        );
      }
      const verdict = await verifyMarketingAuditEvidence(database, {
        auditLogId: resume.auditLogId,
        action: MARKETING_RESUME_AUTONOMOUS_ACTION,
        targetId: id,
        metadata: { reasonCode: resume.reasonCode },
      });
      if (!verdict.ok) {
        throw new MarketingStoreRefusedError(
          `resume_evidence_${verdict.problem}`,
          `The audit entry for this resume is not evidence of it: ${verdict.problem}`,
        );
      }
      data.lastResumeAuditLogId = resume.auditLogId;
      data.lastResumeReasonCode = resume.reasonCode;
    }
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
  status: Extract<MarketingPostStatus, "drafted" | "guard_rejected">;
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

/**
 * The columns an append may set alongside the history entry, and the whole of
 * it. `createdAt`, `logicalKey`, `history` and `historyVersion` are not here:
 * the first two never move and the last two are this function's own business.
 */
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
  verificationMethod?: MarketingVerificationMethod | null;
  errorCode?: string | null;
  outcomeUnknownAt?: Date | null;
  deletedAt?: Date | null;
  deletionMethod?: MarketingDeletionMethod | null;
  legalHold?: boolean;
};

const postPatchData = (
  patch: MarketingPostPatch,
): Prisma.MarketingPostUpdateManyMutationInput => {
  const data: Prisma.MarketingPostUpdateManyMutationInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.mode !== undefined) data.mode = patch.mode;
  if (patch.envelope !== undefined) {
    data.envelope = asJson(marketingEnvelopeSchema.parse(patch.envelope));
  }
  if (patch.envelopeDigest !== undefined) data.envelopeDigest = patch.envelopeDigest;
  if (patch.approvalAuditLogId !== undefined) {
    data.approvalAuditLogId = patch.approvalAuditLogId;
  }
  if (patch.approvedAt !== undefined) data.approvedAt = patch.approvedAt;
  if (patch.approvedDigest !== undefined) data.approvedDigest = patch.approvedDigest;
  if (patch.approvalExpiresAt !== undefined) {
    data.approvalExpiresAt = patch.approvalExpiresAt;
  }
  if (patch.reusableAsTemplate !== undefined) {
    data.reusableAsTemplate = patch.reusableAsTemplate;
  }
  if (patch.scheduledAt !== undefined) data.scheduledAt = patch.scheduledAt;
  if (patch.slotDate !== undefined) data.slotDate = patch.slotDate;
  if (patch.claimToken !== undefined) data.claimToken = patch.claimToken;
  if (patch.leaseUntil !== undefined) data.leaseUntil = patch.leaseUntil;
  if (patch.publishAttempt !== undefined) data.publishAttempt = patch.publishAttempt;
  if (patch.providerRequestKey !== undefined) {
    data.providerRequestKey = patch.providerRequestKey;
  }
  if (patch.externalPostId !== undefined) data.externalPostId = patch.externalPostId;
  if (patch.externalUrl !== undefined) data.externalUrl = patch.externalUrl;
  if (patch.publishedAt !== undefined) data.publishedAt = patch.publishedAt;
  if (patch.verifiedPublicAt !== undefined) {
    data.verifiedPublicAt = patch.verifiedPublicAt;
  }
  if (patch.verificationMethod !== undefined) {
    data.verificationMethod = patch.verificationMethod;
  }
  if (patch.errorCode !== undefined) data.errorCode = patch.errorCode;
  if (patch.outcomeUnknownAt !== undefined) {
    data.outcomeUnknownAt = patch.outcomeUnknownAt;
  }
  if (patch.deletedAt !== undefined) data.deletedAt = patch.deletedAt;
  if (patch.deletionMethod !== undefined) data.deletionMethod = patch.deletionMethod;
  if (patch.legalHold !== undefined) data.legalHold = patch.legalHold;
  return data;
};

/** What an operator supplies when re-queueing a post whose publication failed. */
export type MarketingRequeueEvidence = { auditLogId: string };

/**
 * Append one history entry and apply the change it describes, in one statement.
 *
 * `expectedVersion` is the compare-and-set: the UPDATE matches only while the
 * row still has the version the caller read, so two writers cannot each append
 * to the history they separately read and lose one of the entries. A mismatch
 * comes back as `{ appended: false }` rather than an exception -- a concurrent
 * writer got there first is an ordinary outcome for a publisher retrying a
 * lease, not an error.
 *
 * The existing history is parsed before it is written back. It has just been
 * read from a `jsonb` column, and a column is not a guarantee: an entry that
 * arrived some other way would otherwise be carried forward by every later
 * append, with this module's name on the write.
 */
export async function appendMarketingPostHistory(
  database: MarketingDatabase,
  input: {
    id: string;
    expectedVersion: number;
    entry: MarketingHistoryEntry;
    patch?: MarketingPostPatch;
    requeue?: MarketingRequeueEvidence;
  },
): Promise<{ appended: boolean }> {
  const entry = marketingHistoryEntrySchema.parse(input.entry);
  if (
    !(MARKETING_APPENDABLE_HISTORY_TYPES as readonly string[]).includes(entry.type)
  ) {
    throw new MarketingStoreRefusedError(
      "entry_belongs_to_retention",
      `A ${entry.type} entry is written by retention, not appended`,
    );
  }

  const current = await database.marketingPost.findUnique({
    where: { id: input.id },
    select: { history: true, historyVersion: true, status: true },
  });
  if (!current || current.historyVersion !== input.expectedVersion) {
    return { appended: false };
  }

  const history = marketingHistorySchema.parse(current.history);
  const data = postPatchData(input.patch ?? {});

  // docs/policy/marketing-automation.md §2: a confirmed failure is re-queued by
  // a person. The trigger requires a new approval entry; this is what makes it
  // an entry that says so.
  if (current.status === "failed" && input.patch?.status === "scheduled") {
    if (!input.requeue) {
      throw new MarketingStoreRefusedError(
        "requeue_evidence_missing",
        "Re-queueing a failed post needs the operator's audit entry",
      );
    }
    const verdict = await verifyMarketingAuditEvidence(database, {
      auditLogId: input.requeue.auditLogId,
      action: MARKETING_REQUEUE_ACTION,
      targetId: input.id,
    });
    if (!verdict.ok) {
      throw new MarketingStoreRefusedError(
        `requeue_evidence_${verdict.problem}`,
        `The audit entry for this re-queue is not evidence of it: ${verdict.problem}`,
      );
    }
    data.approvalAuditLogId = input.requeue.auditLogId;
    data.approvedAt = verdict.createdAt;
  }

  const updated = await database.marketingPost.updateMany({
    where: { id: input.id, historyVersion: input.expectedVersion },
    data: {
      ...data,
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
};

/**
 * `createdAt` and `retentionUntil` are not inputs: a BEFORE INSERT trigger sets
 * both from the server clock and the period the kind carries
 * (docs/policy/marketing-automation.md §12.2). A caller that could pass either
 * could set its own row's life while the columns still looked policy-shaped, or
 * date a report into the past and delete it in the same transaction.
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
  const citedUrls = aiVisibilityCitedUrlsSchema.parse([...input.citedUrls]);

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
      citedUrls,
      answerDigest: input.answerDigest,
      accuracyFlags: accuracyFlags === null ? Prisma.DbNull : asJson(accuracyFlags),
    },
  });
}

/** Unused by this module, exported so a caller can narrow a paused mode. */
export type { MarketingPausableMode };
