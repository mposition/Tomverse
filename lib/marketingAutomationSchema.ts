/**
 * The closed lists and strict payload shapes of the marketing automation
 * tables.
 *
 * Contract: docs/policy/marketing-automation.md. Four tables hold everything
 * the agents produce -- `MarketingChannel`, `MarketingPost`, `MarketingReport`
 * and `AiVisibilityRun` -- and every column whose values are closed has its
 * list here and a CHECK constraint that repeats it. `npm run
 * check:enum-constraints` compares the two on every run, so a value that
 * exists in one place and not the other is a failed build rather than a write
 * Postgres refuses at run time.
 *
 * The JSON columns are the reason this module is strict rather than
 * descriptive. A marketing row is evidence: what was claimed, which facts it
 * rested on, what the Guard decided, what the platform answered. Free text in
 * those columns would put model output, reader comments and platform prose
 * into a store the retention rules (docs/policy/marketing-automation.md §12.2)
 * describe as structured facts. So every schema is `.strict()`, every string
 * has a maximum length, and exactly one field in the whole module carries
 * rendered prose: `MarketingEnvelope.renderedText`, which the server rendered
 * from an approved template. Everything else is an identifier, a digest, an
 * enumerated token, a number or a timestamp.
 *
 * Pure: no server-only import, no Prisma. Static checks, unit tests and the
 * store module all read it.
 */

import { z } from "zod";

/** Where a post goes. Immutable per channel row: see the identity trigger. */
export const MARKETING_CHANNELS = [
  "linkedin",
  "x",
  "facebook",
  "instagram",
  "threads",
  "youtube",
  "tiktok",
  "rednote",
] as const;
export type MarketingChannel = (typeof MARKETING_CHANNELS)[number];

/**
 * Who carries the post to the platform. `manual` is an operator posting by
 * hand -- RedNote has no API route (docs/policy/marketing-automation.md O6) --
 * and it is the one provider with no external account reference, because there
 * is no connected account to reference.
 */
export const MARKETING_PROVIDERS = ["zernio", "manual"] as const;
export type MarketingProvider = (typeof MARKETING_PROVIDERS)[number];

/** Account lifecycle (docs/policy/marketing-automation.md §8.2). */
export const MARKETING_CHANNEL_STATUSES = [
  "connect_pending",
  "approval_mode",
  "autonomous_mode",
  "paused",
  "disconnected",
] as const;
export type MarketingChannelStatus = (typeof MARKETING_CHANNEL_STATUSES)[number];

/**
 * The two live modes an account can be paused out of. `pausedFromMode` records
 * where it was so a resume can put it back, and only these two are places to
 * come back to: an account paused while still connecting or already
 * disconnected has no earlier mode to restore.
 */
export const MARKETING_PAUSABLE_MODES = ["approval_mode", "autonomous_mode"] as const;
export type MarketingPausableMode = (typeof MARKETING_PAUSABLE_MODES)[number];

/** What a draft row is for. */
export const MARKETING_POST_KINDS = [
  "social",
  "rednote_package",
  "landing_variant",
  "seo_pr_ref",
] as const;
export type MarketingPostKind = (typeof MARKETING_POST_KINDS)[number];

/**
 * Every state a draft can reach, in no particular order -- the allowed
 * movements between them are the publisher's contract (S2), not this list.
 * `outcome_unknown` is separate from `failed` on purpose: a failure is a post
 * that did not happen, and an unknown outcome is a post that may have.
 */
export const MARKETING_POST_STATUSES = [
  "drafted",
  "guard_rejected",
  "pending_approval",
  "approved",
  "rejected",
  "approval_expired",
  "scheduled",
  "publishing",
  "published",
  "failed",
  "outcome_unknown",
  "verified",
  "removed_by_platform",
  "deleted",
] as const;
export type MarketingPostStatus = (typeof MARKETING_POST_STATUSES)[number];

/** Whether a human approved this particular post or a template did. */
export const MARKETING_POST_MODES = ["approval", "autonomous"] as const;
export type MarketingPostMode = (typeof MARKETING_POST_MODES)[number];

/** What the Guard decided about a draft (docs/policy/marketing-automation.md §7). */
export const MARKETING_GUARD_DECISIONS = [
  "reject",
  "approval_required",
  "autonomous_eligible",
] as const;
export type MarketingGuardDecision = (typeof MARKETING_GUARD_DECISIONS)[number];

/**
 * The kinds of aggregate a report row can be.
 *
 * The marketing policy v3 draft adds a tenth kind for execution service
 * heartbeats. v2 is the approved policy, so it is not in this list and not in
 * the CHECK; adding it is a migration and a registry entry once v3 is
 * approved.
 */
export const MARKETING_REPORT_KINDS = [
  "weekly_kpi",
  "brief",
  "market_intel",
  "experiment_result",
  "measurement_120d",
  "comment_alerts",
  "mainland_block_check",
  "retention_run",
  "webhook_shadow",
] as const;
export type MarketingReportKind = (typeof MARKETING_REPORT_KINDS)[number];

/** How the app established that a post is publicly visible. */
export const MARKETING_VERIFICATION_METHODS = [
  "status_query",
  "webhook",
  "operator_sample",
] as const;
export type MarketingVerificationMethod =
  (typeof MARKETING_VERIFICATION_METHODS)[number];

/** How a published post stopped being public. */
export const MARKETING_DELETION_METHODS = [
  "api_unpublish",
  "operator_manual",
  "platform_removed",
] as const;
export type MarketingDeletionMethod = (typeof MARKETING_DELETION_METHODS)[number];

/**
 * The languages this programme posts in (docs/policy/marketing-automation.md
 * O7): Traditional Chinese for Taiwan, Simplified only on RedNote, which is
 * aimed at Chinese speakers outside the mainland. Mainland China is out of
 * scope.
 */
export const MARKETING_LOCALES = ["en", "ko", "zh-Hant", "zh-Hans"] as const;
export type MarketingLocale = (typeof MARKETING_LOCALES)[number];

/**
 * Posts per account per day and per week
 * (docs/policy/marketing-automation.md §7.6). These are code constants and an
 * operator override may only lower them; the database repeats the table and a
 * trigger refuses an override above it.
 *
 * RedNote is `null` rather than a number because it has no API posting route
 * at all. A cap of zero would read as "throttled to nothing", and any positive
 * number would be a rate for something that never happens; `null` says the
 * publisher does not post here, and the trigger refuses an override outright.
 */
export const MARKETING_CHANNEL_CAPS: Readonly<
  Record<
    MarketingChannel,
    { readonly daily: number; readonly weekly: number } | null
  >
> = {
  linkedin: { daily: 1, weekly: 3 },
  x: { daily: 2, weekly: 10 },
  facebook: { daily: 1, weekly: 5 },
  instagram: { daily: 1, weekly: 4 },
  threads: { daily: 2, weekly: 7 },
  youtube: { daily: 1, weekly: 2 },
  tiktok: { daily: 1, weekly: 5 },
  rednote: null,
};

/**
 * Channels that may never reach autonomous mode
 * (docs/policy/marketing-automation.md O15): neither platform lets the API
 * retract a post, so an autonomous mistake there cannot be undone by the same
 * route that made it. The database repeats this as a CHECK and a trigger.
 */
export const MARKETING_NO_AUTONOMY_CHANNELS = ["instagram", "tiktok"] as const;

/**
 * How long each report kind is kept (docs/policy/marketing-automation.md
 * §12.2). `retentionUntil` must *equal* `createdAt` plus this interval -- not
 * be at most it -- so a writer cannot quietly shorten or extend one row's life
 * while the column still looks policy-shaped.
 */
export const MARKETING_REPORT_RETENTION: Readonly<
  Record<
    MarketingReportKind,
    { readonly unit: "month" | "day"; readonly amount: number }
  >
> = {
  weekly_kpi: { unit: "month", amount: 24 },
  brief: { unit: "month", amount: 24 },
  market_intel: { unit: "month", amount: 24 },
  experiment_result: { unit: "month", amount: 36 },
  measurement_120d: { unit: "month", amount: 36 },
  comment_alerts: { unit: "day", amount: 90 },
  webhook_shadow: { unit: "day", amount: 90 },
  mainland_block_check: { unit: "month", amount: 12 },
  retention_run: { unit: "month", amount: 12 },
};

/** AI visibility runs are kept for two years (docs/policy/marketing-automation.md §12.2). */
export const AI_VISIBILITY_RETENTION_MONTHS = 24;

/**
 * Add whole months the way Postgres does, because the constraint compares
 * against exactly that.
 *
 * `timestamp + interval '1 month'` keeps the day of the month and clamps to the
 * last day when the target month is shorter: 31 January plus one month is 28
 * February. JavaScript's `setMonth` overflows into the next month instead (3
 * March), so a row created on the 31st would be computed one way here and
 * checked another way in the database, and the insert would be refused for
 * three days out of every month. Nothing would have been wrong with the data.
 */
export function addMonthsLikePostgres(from: Date, months: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const day = from.getUTCDate();
  const lastDayOfTargetMonth = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  const result = new Date(from.getTime());
  result.setUTCFullYear(year, month, Math.min(day, lastDayOfTargetMonth));
  return result;
}

/** When a report of this kind stops being kept (docs/policy/marketing-automation.md §12.2). */
export function marketingReportRetentionUntil(
  kind: MarketingReportKind,
  createdAt: Date,
): Date {
  const retention = MARKETING_REPORT_RETENTION[kind];
  if (!retention) {
    throw new Error(`No marketing report retention for kind ${kind}`);
  }
  if (retention.unit === "month") {
    return addMonthsLikePostgres(createdAt, retention.amount);
  }
  return new Date(createdAt.getTime() + retention.amount * 24 * 60 * 60 * 1000);
}

/** When an AI visibility run stops being kept. */
export function aiVisibilityRetentionUntil(runAt: Date): Date {
  return addMonthsLikePostgres(runAt, AI_VISIBILITY_RETENTION_MONTHS);
}

/**
 * The transaction-local setting that lets the retention job past the
 * append-only history trigger and the envelope purge refusal.
 *
 * The application uses one database role, so this is not a privilege boundary
 * and the migration says so. What it does is make a purge impossible to write
 * by accident: an ordinary update never sets it, and the protected-table
 * writer check refuses the name outside the modules on its allowlist.
 */
export const MARKETING_RETENTION_SETTING =
  "tomverse.marketing_retention_compaction";

// ---------------------------------------------------------------------------
// Shared field shapes
// ---------------------------------------------------------------------------

/** Every free-standing identifier column: opaque, short, no whitespace. */
const identifier = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const isoInstant = z.iso.datetime({ offset: true });
const httpsUrl = z.string().url().max(2048).startsWith("https://");

const channelEnum = z.enum(MARKETING_CHANNELS);
const localeEnum = z.enum(MARKETING_LOCALES);

/**
 * The internal account name. System-generated from the channel and a small
 * number (`instagram-2`), never an operator's free text, a handle, a display
 * name or an address -- those are personal data on a platform's side and this
 * store holds none of them.
 */
export const MARKETING_ACCOUNT_SLUG_PATTERN = /^[a-z]+-[0-9]{1,3}$/;
const accountSlug = z.string().max(40).regex(MARKETING_ACCOUNT_SLUG_PATTERN);

/**
 * The one field in this module that carries prose, and it is prose this server
 * rendered from an approved template. A longer render is a bug in the
 * renderer, not a row to store.
 */
const RENDERED_TEXT_MAX = 3000;

// ---------------------------------------------------------------------------
// MarketingPost.envelope
// ---------------------------------------------------------------------------

/** Which disclosures this post carries (Australian ad law, §13). */
export const MARKETING_DISCLOSURE_FLAGS = [
  "advertising",
  "ai_generated_asset",
  "paid_partnership",
] as const;

export const marketingEnvelopeSchema = z
  .object({
    channel: channelEnum,
    accountSlug,
    locale: localeEnum,
    renderedText: z.string().min(1).max(RENDERED_TEXT_MAX),
    claimIds: z.array(identifier).max(50),
    assets: z
      .array(
        z
          .object({
            assetId: identifier,
            alt: z.string().min(1).max(400),
          })
          .strict(),
      )
      .max(20),
    finalUrl: httpsUrl.nullable(),
    scheduledAt: isoInstant.nullable(),
    disclosureFlags: z.array(z.enum(MARKETING_DISCLOSURE_FLAGS)).max(3),
  })
  .strict();
export type MarketingEnvelope = z.infer<typeof marketingEnvelopeSchema>;

// ---------------------------------------------------------------------------
// MarketingPost.factSnapshot
// ---------------------------------------------------------------------------

const rowReference = z
  .object({ rowId: identifier, updatedAt: isoInstant })
  .strict();

/**
 * Which stored rows a claim rested on, at the moment the Guard read them.
 *
 * Row ids and their `updatedAt`, never the values: a price that moves
 * invalidates the claim, and comparing timestamps says that without this table
 * keeping a second copy of the price. Evidence outside the database is a
 * digest of the document that was read.
 */
export const marketingFactSnapshotSchema = z
  .object({
    priceRows: z.array(rowReference).max(60),
    catalogue: z
      .object({
        source: z.enum(["stored_row", "compiled_default"]),
        updatedAt: isoInstant,
      })
      .strict()
      .nullable(),
    modelRegistryRows: z.array(rowReference).max(200),
    evidenceDigests: z.array(digest).max(50),
  })
  .strict();
export type MarketingFactSnapshot = z.infer<typeof marketingFactSnapshotSchema>;

// ---------------------------------------------------------------------------
// MarketingChannel.graduationSnapshot
// ---------------------------------------------------------------------------

/**
 * What was true when an account graduated to autonomous mode
 * (docs/policy/marketing-automation.md O3). Counts and rates only: the
 * decision has to be re-checkable later without keeping the posts it counted.
 */
export const marketingGraduationSnapshotSchema = z
  .object({
    graduationEpoch: z.number().int().min(0),
    approvedPostCount: z.number().int().min(0),
    guardRejectionRate: z.number().min(0).max(1),
    operatorEditRate: z.number().min(0).max(1),
    observedFromAt: isoInstant,
    observedUntilAt: isoInstant,
    approvalAuditLogId: identifier,
    policyVersion: z.number().int().min(1),
  })
  .strict();
export type MarketingGraduationSnapshot = z.infer<
  typeof marketingGraduationSnapshotSchema
>;

// ---------------------------------------------------------------------------
// MarketingPost.history
// ---------------------------------------------------------------------------

/**
 * The append-only record of what happened to one draft.
 *
 * Digests, codes and identifiers: a revision records that the text changed and
 * what it changed to by digest, not the text. The only entry that is not an
 * addition to the end is `retention_compaction`, and the database refuses even
 * that without the retention setting (docs/policy/marketing-automation.md
 * §12.2).
 */
export const marketingHistoryEntrySchema = z.discriminatedUnion("type", [
  z
    .object({ at: isoInstant, type: z.literal("draft"), envelopeDigest: digest })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("edit_revision"),
      envelopeDigest: digest,
      previousEnvelopeDigest: digest,
      byAuditLogId: identifier.nullable(),
    })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("guard_result"),
      decision: z.enum(MARKETING_GUARD_DECISIONS),
      codes: z.array(identifier).max(40),
      ruleIds: z.array(identifier).max(40),
    })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("attempt"),
      attempt: z.number().int().min(1),
      outcome: z.enum(["published", "failed", "outcome_unknown"]),
      errorCode: identifier.nullable(),
    })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("webhook_event"),
      eventIdDigest: digest,
      eventType: identifier,
    })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("retention_compaction"),
      removedEntryCount: z.number().int().min(1),
    })
    .strict(),
]);
export type MarketingHistoryEntry = z.infer<typeof marketingHistoryEntrySchema>;

export const marketingHistorySchema = z.array(marketingHistoryEntrySchema).max(500);

// ---------------------------------------------------------------------------
// MarketingReport.payload, one schema per kind
// ---------------------------------------------------------------------------

/**
 * A competitor fact is a value with a source and a date, and the value is not
 * a paragraph: a number, a date, an enumerated token, or a short string with
 * no newline. Prose about a competitor is an opinion this table has no way to
 * attribute.
 */
const marketIntelValue = z.union([
  z.number(),
  z.iso.date(),
  z
    .string()
    .max(80)
    .regex(/^[^\n\r]*$/),
]);

const countByCode = z.array(
  z.object({ code: identifier, count: z.number().int().min(0) }).strict(),
);

export const MARKETING_REPORT_PAYLOAD_SCHEMAS: Readonly<
  Record<MarketingReportKind, z.ZodType>
> = {
  weekly_kpi: z
    .object({
      postsPublished: z.number().int().min(0),
      postsRejected: z.number().int().min(0),
      guardRejectionsByCode: countByCode,
      channelTotals: z
        .array(
          z
            .object({
              accountSlug,
              published: z.number().int().min(0),
              failed: z.number().int().min(0),
            })
            .strict(),
        )
        .max(20),
    })
    .strict(),
  brief: z
    .object({
      topicIds: z.array(identifier).max(50),
      claimIds: z.array(identifier).max(50),
      sourceDigests: z.array(digest).max(50),
    })
    .strict(),
  market_intel: z
    .object({
      facts: z
        .array(
          z
            .object({
              competitorId: identifier,
              factType: identifier,
              value: marketIntelValue,
              sourceUrl: httpsUrl,
              checkedAt: isoInstant,
            })
            .strict(),
        )
        .max(200),
    })
    .strict(),
  experiment_result: z
    .object({
      experimentId: identifier,
      variantId: identifier,
      exposures: z.number().int().min(0),
      conversions: z.number().int().min(0),
      startedAt: isoInstant,
      endedAt: isoInstant,
    })
    .strict(),
  measurement_120d: z
    .object({
      metricId: identifier,
      value: z.number(),
      sampleSize: z.number().int().min(0),
      observedFromAt: isoInstant,
      observedUntilAt: isoInstant,
    })
    .strict(),
  comment_alerts: z
    .object({
      postId: identifier,
      alertCount: z.number().int().min(0),
      riskCodes: z.array(identifier).max(20),
      firstDetectedAt: isoInstant,
      externalUrlHost: z
        .string()
        .max(253)
        .regex(/^[a-z0-9.-]+$/),
    })
    .strict(),
  mainland_block_check: z
    .object({
      checkedAt: isoInstant,
      blocked: z.boolean(),
      probe: z.enum(["dns", "http_status", "operator_report"]),
    })
    .strict(),
  retention_run: z
    .object({
      startedAt: isoInstant,
      table: z.enum(["MarketingPost", "MarketingReport", "AiVisibilityRun"]),
      purgedRowCount: z.number().int().min(0),
      compactedRowCount: z.number().int().min(0),
    })
    .strict(),
  webhook_shadow: z
    .object({
      eventIdDigest: digest,
      eventType: identifier,
      channelId: identifier,
      derivedStatus: z.enum(MARKETING_POST_STATUSES),
      statusQueryMatch: z.boolean(),
    })
    .strict(),
};

/**
 * Parse one report payload against the schema its kind names. There is no
 * fallback schema: a kind with no entry is a programming error, not a row to
 * store loosely.
 */
export function parseMarketingReportPayload(
  kind: MarketingReportKind,
  payload: unknown,
): unknown {
  const schema = MARKETING_REPORT_PAYLOAD_SCHEMAS[kind];
  if (!schema) {
    throw new Error(`No marketing report payload schema for kind ${kind}`);
  }
  return schema.parse(payload);
}

// ---------------------------------------------------------------------------
// AiVisibilityRun.accuracyFlags
// ---------------------------------------------------------------------------

/**
 * Whether the assistant was allowed to search the web for that answer. The two
 * are measured separately because they answer different questions: one is what
 * a model has learned about us, the other is what it can find.
 */
export const AI_VISIBILITY_SEARCH_MODES = ["with_search", "without_search"] as const;
export type AiVisibilitySearchMode = (typeof AI_VISIBILITY_SEARCH_MODES)[number];

/** What was wrong with an AI answer that mentioned us. Enumerated, never prose. */
export const AI_VISIBILITY_ACCURACY_FLAGS = [
  "wrong_price",
  "wrong_model_list",
  "wrong_plan_limits",
  "outdated_feature",
  "confused_with_competitor",
  "superlative_claim",
] as const;

export const aiVisibilityAccuracyFlagsSchema = z
  .object({
    flags: z.array(z.enum(AI_VISIBILITY_ACCURACY_FLAGS)).max(6),
  })
  .strict();
export type AiVisibilityAccuracyFlags = z.infer<
  typeof aiVisibilityAccuracyFlagsSchema
>;
