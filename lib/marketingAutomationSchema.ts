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
 * describe as structured facts.
 *
 * So there is exactly one free-text field in this module -- the server-rendered
 * `MarketingEnvelope.renderedText` -- and every other string carries a type: an
 * https URL with a host rule, a sha256 digest, a registry id, a locale, an ISO
 * timestamp, or a member of a closed list. `tests/marketingAutomationSchema.test.mjs`
 * fails the build if a bare `z.string()` appears outside the typed helpers
 * below, because "a string with a maximum length" is not a type -- it is prose
 * with a ceiling.
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
 * The two live modes an account can be paused out of, and the only values
 * `pausedFromMode` takes.
 *
 * A pause is only ever entered from one of these, and the trigger sets the
 * column itself from the previous status rather than accepting a caller's
 * value: an account that could declare where it came from could declare it had
 * been autonomous and resume there.
 */
export const MARKETING_PAUSABLE_MODES = ["approval_mode", "autonomous_mode"] as const;
export type MarketingPausableMode = (typeof MARKETING_PAUSABLE_MODES)[number];

/**
 * Why an operator resumed an account into autonomous mode
 * (docs/policy/marketing-automation.md §8.2). A closed list because it is read
 * as a count later -- how often a pause turned out to be a false positive is a
 * question about the halt rules, and free text cannot be counted. The operator's
 * sentence goes in the audit row, not here.
 */
export const MARKETING_RESUME_REASON_CODES = [
  "incident_resolved",
  "false_positive_pause",
  "operator_review_complete",
] as const;
export type MarketingResumeReasonCode =
  (typeof MARKETING_RESUME_REASON_CODES)[number];

/** What a draft row is for. */
export const MARKETING_POST_KINDS = [
  "social",
  "rednote_package",
  "landing_variant",
  "seo_pr_ref",
] as const;
export type MarketingPostKind = (typeof MARKETING_POST_KINDS)[number];

/**
 * Every state a draft can reach. Which movements between them are allowed is
 * the transition trigger's whitelist, not this list.
 *
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

/**
 * The only movements between post statuses
 * (marketing S1 plan r5: the ledger is a whitelist).
 *
 * Read as "from → the states it may become". Anything not listed is refused by
 * the trigger, which matters most for the states a dispatch has already
 * reached: nothing that was sent to a platform may go back to `rejected`,
 * `guard_rejected` or `approval_expired`, because those say the post never
 * left.
 *
 * `failed → scheduled` is the one re-entry, and it is not a retry: it needs a
 * fresh human approval, because a confirmed failure is re-queued by a person
 * (docs/policy/marketing-automation.md §2). `outcome_unknown` resolves to what
 * the platform turns out to have done, and never to a re-send.
 */
export const MARKETING_POST_STATUS_TRANSITIONS: Readonly<
  Partial<Record<MarketingPostStatus, readonly MarketingPostStatus[]>>
> = {
  drafted: ["guard_rejected", "pending_approval"],
  pending_approval: ["approved", "rejected", "approval_expired"],
  approved: ["scheduled", "approval_expired"],
  scheduled: ["publishing", "approval_expired"],
  publishing: ["published", "failed", "outcome_unknown"],
  published: ["verified", "removed_by_platform", "deleted"],
  verified: ["removed_by_platform", "deleted"],
  outcome_unknown: ["published", "failed"],
  failed: ["scheduled"],
};

/**
 * The statuses a post can only be in because a request was sent to a platform.
 *
 * They carry two consequences: the provider's idempotency key must be set (so a
 * retry cannot become a second post), and the row can never be deleted, because
 * something may exist on a platform that this row is the only record of.
 */
export const MARKETING_DISPATCHED_STATUSES = [
  "publishing",
  "published",
  "verified",
  "outcome_unknown",
  "failed",
  "removed_by_platform",
  "deleted",
] as const;

/** Whether a human approved this particular post or an approved template did. */
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
 * §12.2).
 *
 * The values are duplicated in the migration's BEFORE INSERT trigger, which is
 * what actually sets `retentionUntil` from the database clock; this copy is
 * what the unit test compares the trigger against, and what a reader of the
 * application sees. Neither the store nor any caller computes the column.
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

/** Published content is purged after two years (docs/policy/marketing-automation.md §12.2). */
export const MARKETING_CONTENT_RETENTION_MONTHS = 24;

/** Attempts and webhook ids are compacted after ninety days (docs/policy/marketing-automation.md §12.2). */
export const MARKETING_HISTORY_DETAIL_RETENTION_DAYS = 90;

/** Refused and expired drafts are deleted after ninety days (docs/policy/marketing-automation.md §12.2). */
export const MARKETING_DRAFT_RETENTION_DAYS = 90;

/**
 * The transaction-local setting that lets the retention job past the
 * append-only history trigger and the content purge refusal.
 *
 * The application uses one database role, so this is not a privilege boundary:
 * any code in the application could set it. What it is is a second, deliberate
 * action that ordinary code never performs, so a purge cannot happen by
 * accident. It is not on its own an authorisation, and the triggers that read
 * it still apply the age, legal-hold and shape rules to every row.
 */
export const MARKETING_RETENTION_SETTING =
  "tomverse.marketing_retention_compaction";

// ---------------------------------------------------------------------------
// TYPED FIELDS BEGIN
//
// Every string in every schema below is built from one of these. A bare
// `z.string()` anywhere outside this block fails the meta-test, and the one
// free-text exception is named explicitly at the end of it.
// ---------------------------------------------------------------------------

/** A registry identifier: opaque, short, no whitespace, no prose. */
const registryId = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[A-Za-z0-9._:-]+$/);

/** Lower-case hexadecimal sha256. */
const sha256 = z.string().regex(/^[a-f0-9]{64}$/);

/**
 * An instant with an offset, as the database round-trips it.
 *
 * Narrower than `z.iso.datetime({ offset: true })` in two places, and both are
 * about the database rather than about taste. Zod accepts year `0000`, which
 * Postgres has no such year for, and offsets out to `+23:00`, which Postgres
 * refuses past `+15:59`. A value the schema accepted and the database could not
 * cast would be stored and then fail every later read of the row -- so the two
 * are held to one range, and it is the smaller one.
 *
 * `MARKETING_INSTANT_PATTERN` is the same rule as a pattern, because the
 * marketing triggers have to apply it too and a trigger cannot import this.
 */
export const MARKETING_INSTANT_PATTERN =
  /^(?!0000)[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]+)?(Z|[+-](0[0-9]|1[0-4]):[0-5][0-9])$/;

const isoInstant = z
  .iso
  .datetime({ offset: true })
  .refine((value) => MARKETING_INSTANT_PATTERN.test(value), {
    message:
      "must be an ISO instant with a year from 0001 and an offset within 14 hours",
  });

/** A calendar date with no time of day. */
const isoDate = z.iso.date();

/** An ISO 4217 code, upper case. */
const currencyCode = z.string().regex(/^[A-Z]{3}$/);

/** A host name, for the one field that keeps a host instead of a URL. */
const hostName = z
  .string()
  .max(253)
  .regex(/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/);

/**
 * An https URL, optionally restricted to one host.
 *
 * The host rule is the difference between "a link we published" and "a link
 * somebody sent us": `finalUrl` is where a post sends a reader and must be our
 * own site, while a source or a citation is by definition somewhere else.
 */
const httpsUrl = (host?: string) => {
  const base = z
    .string()
    .max(2048)
    .refine(
      (value) => {
        let url: URL;
        try {
          url = new URL(value);
        } catch {
          return false;
        }
        if (url.protocol !== "https:") return false;
        return host === undefined || url.host === host;
      },
      host === undefined
        ? { message: "must be an https URL" }
        : { message: `must be an https URL on ${host}` },
    );
  return base;
};

/** Where a post sends a reader. Our own site, by the same rule the Guard applies. */
export const MARKETING_PUBLIC_HOST = "tomverse.app";

/**
 * The internal account name. System-generated from the channel and a small
 * number (`instagram-2`), never an operator's free text, a handle, a display
 * name or an address -- those are personal data on a platform's side and this
 * store holds none of them. The database also checks that the prefix is the
 * row's own channel.
 */
export const MARKETING_ACCOUNT_SLUG_PATTERN = /^[a-z]+-[0-9]{1,3}$/;
const accountSlug = z.string().max(40).regex(MARKETING_ACCOUNT_SLUG_PATTERN);

/**
 * THE ONE FREE-TEXT FIELD. Prose this server rendered from an approved
 * template, and the only place in these tables where a sentence is stored. A
 * longer render is a bug in the renderer, not a row to store.
 */
const RENDERED_TEXT_MAX = 3000;
const renderedText = z.string().min(1).max(RENDERED_TEXT_MAX);

// ---------------------------------------------------------------------------
// TYPED FIELDS END
// ---------------------------------------------------------------------------

const channelEnum = z.enum(MARKETING_CHANNELS);
const localeEnum = z.enum(MARKETING_LOCALES);

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
    renderedText,
    claimIds: z.array(registryId).max(50),
    // The alt text itself lives in the asset registry beside the asset, keyed
    // per locale; a free sentence here would be a second, unreviewed place for
    // customer-visible words.
    assets: z
      .array(z.object({ assetId: registryId, altKey: registryId }).strict())
      .max(20),
    finalUrl: httpsUrl(MARKETING_PUBLIC_HOST).nullable(),
    scheduledAt: isoInstant.nullable(),
    disclosureFlags: z.array(z.enum(MARKETING_DISCLOSURE_FLAGS)).max(3),
  })
  .strict();
export type MarketingEnvelope = z.infer<typeof marketingEnvelopeSchema>;

// ---------------------------------------------------------------------------
// MarketingPost.factSnapshot
// ---------------------------------------------------------------------------

const rowReference = z
  .object({ rowId: registryId, updatedAt: isoInstant })
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
    evidenceDigests: z.array(sha256).max(50),
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
    approvalAuditLogId: registryId,
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
 * what it changed to by digest, not the text. No entry type carries prose, so
 * the only thing retention can do to this array is remove old attempts and
 * webhook ids and leave a summary in their place -- which is what the
 * compaction trigger allows and nothing else.
 */
export const marketingHistoryEntrySchema = z.discriminatedUnion("type", [
  z
    .object({ at: isoInstant, type: z.literal("draft"), envelopeDigest: sha256 })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("edit_revision"),
      envelopeDigest: sha256,
      previousEnvelopeDigest: sha256,
      byAuditLogId: registryId.nullable(),
    })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("guard_result"),
      decision: z.enum(MARKETING_GUARD_DECISIONS),
      codes: z.array(registryId).max(40),
      ruleIds: z.array(registryId).max(40),
    })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("attempt"),
      attempt: z.number().int().min(1),
      outcome: z.enum(["published", "failed", "outcome_unknown"]),
      errorCode: registryId.nullable(),
    })
    .strict(),
  z
    .object({
      at: isoInstant,
      type: z.literal("webhook_event"),
      eventIdDigest: sha256,
      eventType: registryId,
    })
    .strict(),
  // Written only by retention, and only in place of the entries it removed.
  z
    .object({
      at: isoInstant,
      type: z.literal("retention_summary"),
      summarises: z.enum(["attempt", "webhook_event"]),
      count: z.number().int().min(1),
      firstAt: isoInstant,
      lastAt: isoInstant,
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

/** The entry types a caller may append. Retention writes the other two. */
export const MARKETING_APPENDABLE_HISTORY_TYPES = [
  "draft",
  "edit_revision",
  "guard_result",
  "attempt",
  "webhook_event",
] as const;

export const MARKETING_HISTORY_MAX_ENTRIES = 500;

export const marketingHistorySchema = z
  .array(marketingHistoryEntrySchema)
  .max(MARKETING_HISTORY_MAX_ENTRIES);

// ---------------------------------------------------------------------------
// Market intelligence facts
// ---------------------------------------------------------------------------

/**
 * What a competitor fact may say, by kind.
 *
 * There is no free-string case. A sentence about a competitor is an opinion
 * this table cannot attribute, cannot compare across two readings, and cannot
 * check against the source it names -- and it would arrive from a model reading
 * somebody else's marketing page, which is the least trustworthy text in the
 * system. A fact that does not fit one of these shapes is not stored, and the
 * report counts it as unrepresentable.
 */
export const marketIntelValueSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("number"),
      value: z.number(),
      unit: registryId.nullable(),
    })
    .strict(),
  z.object({ kind: z.literal("date"), value: isoDate }).strict(),
  z
    .object({
      kind: z.literal("money"),
      amountMinor: z.number().int(),
      currency: currencyCode,
    })
    .strict(),
  z.object({ kind: z.literal("token"), value: registryId }).strict(),
]);
export type MarketIntelValue = z.infer<typeof marketIntelValueSchema>;

/**
 * The tokens each fact type may use.
 *
 * A token is only meaningful against a vocabulary: `"unlimited"` for a message
 * quota and `"unlimited"` for a support tier are different claims, and a shared
 * pool of strings would let one be counted as the other. A fact type with no
 * entry accepts no tokens at all.
 */
export const MARKET_INTEL_FACT_TOKENS: Readonly<
  Record<string, readonly string[]>
> = {
  plan_tier: ["free", "pro", "max", "team", "enterprise"],
  availability: ["available", "waitlist", "announced", "withdrawn"],
  billing_interval: ["monthly", "annual", "one_off"],
  model_access: ["included", "add_on", "unavailable"],
};

/** Whether a fact's value is usable for its fact type. */
export function marketIntelFactProblem(
  factType: string,
  value: MarketIntelValue,
): string | null {
  if (value.kind !== "token") return null;
  const vocabulary = MARKET_INTEL_FACT_TOKENS[factType];
  if (!vocabulary) return `fact type ${factType} has no token vocabulary`;
  if (!vocabulary.includes(value.value)) {
    return `${value.value} is not a token of ${factType}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// MarketingReport.payload, one schema per kind
// ---------------------------------------------------------------------------

const countByCode = z.array(
  z.object({ code: registryId, count: z.number().int().min(0) }).strict(),
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
      topicIds: z.array(registryId).max(50),
      claimIds: z.array(registryId).max(50),
      sourceDigests: z.array(sha256).max(50),
    })
    .strict(),
  market_intel: z
    .object({
      facts: z
        .array(
          z
            .object({
              competitorId: registryId,
              factType: registryId,
              value: marketIntelValueSchema,
              sourceUrl: httpsUrl(),
              checkedAt: isoInstant,
            })
            .strict()
            .superRefine((fact, context) => {
              const problem = marketIntelFactProblem(fact.factType, fact.value);
              if (problem) {
                context.addIssue({ code: "custom", message: problem });
              }
            }),
        )
        .max(200),
      // Facts the reader could not turn into one of the shapes above. A count,
      // so that "we found nothing" and "we could not store what we found" are
      // different answers.
      unrepresentableFactCount: z.number().int().min(0),
    })
    .strict(),
  experiment_result: z
    .object({
      experimentId: registryId,
      variantId: registryId,
      exposures: z.number().int().min(0),
      conversions: z.number().int().min(0),
      startedAt: isoInstant,
      endedAt: isoInstant,
    })
    .strict(),
  measurement_120d: z
    .object({
      metricId: registryId,
      value: z.number(),
      sampleSize: z.number().int().min(0),
      observedFromAt: isoInstant,
      observedUntilAt: isoInstant,
    })
    .strict(),
  comment_alerts: z
    .object({
      postId: registryId,
      alertCount: z.number().int().min(0),
      riskCodes: z.array(registryId).max(20),
      firstDetectedAt: isoInstant,
      externalUrlHost: hostName,
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
      eventIdDigest: sha256,
      eventType: registryId,
      channelId: registryId,
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

/** Every cited URL is https; the host is not restricted, because a citation is elsewhere. */
export const aiVisibilityCitedUrlsSchema = z.array(httpsUrl()).max(50);
