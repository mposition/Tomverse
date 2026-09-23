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

import { createHash } from "node:crypto";

import { Prisma } from "@prisma/client";
import type { PrismaClient } from "@prisma/client";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { databaseErrorMetadata } from "@/lib/databaseError";
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
  type MarketingHistoryEntry,
  type MarketingLocale,
  type MarketingPausableMode,
  type MarketingPauseReasonCode,
  type MarketingPostKind,
  type MarketingPostMode,
  type MarketingPostStatus,
  type MarketingProvider,
  type MarketingReportKind,
  type MarketingResumeReasonCode,
  type MarketingVerificationMethod,
  MARKETING_CHANNEL_CAPS,
  MARKETING_PAUSE_REASON_CODES,
  MARKETING_NO_AUTONOMY_CHANNELS,
  MARKETING_RESUME_REASON_CODES,
} from "@/lib/marketingAutomationSchema";
import {
  MARKETING_AUDIT_PROBLEMS,
  verifyMarketingAuditEvidence,
} from "@/lib/marketingAuditEvidence";
import {
  marketingFactsDigest,
  marketingFactsScopeDigest,
  type MarketingGuardFacts,
} from "@/lib/marketingFacts";
import {
  marketingGuardDecisionIsSealed,
  marketingGuardDraftDigest,
  marketingTemplateWriteConditions,
  type MarketingGuardDecision as GuardDecision,
  type MarketingTemplateBinding,
} from "@/lib/marketingGuardCore";

/**
 * Every function takes the client explicitly. A marketing write is part of a
 * larger change -- an approval and its audit entry, a publish and its history
 * entry -- and a module-level client would make it possible to write one of
 * those outside the transaction that wrote the other.
 */
export type MarketingDatabase = PrismaClient | Prisma.TransactionClient;

declare const MARKETING_TRANSACTION_BRAND: unique symbol;

/**
 * A client that is provably inside a transaction.
 *
 * `Prisma.TransactionClient` does not prove it: it is `Omit<PrismaClient, …>`,
 * and a whole `PrismaClient` is assignable to it, so annotating a parameter
 * with it refuses nothing. `resumeMarketingChannelToAutonomous(prisma, …)`
 * typechecked, and each of its four writes -- the row locks, the post
 * expiries, their audit entries, the channel CAS -- went out on its own
 * autocommit, so a failing CAS at the end left the expiries and their audit
 * behind.
 *
 * The brand is a property no client has, so the only value of this type is one
 * `runMarketingTransaction()` produced, and that function's argument is a
 * `$transaction` callback parameter. The single cast below is the whole
 * surface, and `tests/marketingS2b1Store.test.mjs` fails if a second one
 * appears anywhere in `lib/`.
 */
export type MarketingTransaction = Prisma.TransactionClient & {
  readonly [MARKETING_TRANSACTION_BRAND]: "marketing";
};

/** The one place a `MarketingTransaction` comes from. */
export async function runMarketingTransaction<T>(
  client: PrismaClient,
  run: (tx: MarketingTransaction) => Promise<T>,
  options?: {
    maxWait?: number;
    timeout?: number;
    /**
     * The isolation the work needs, when the default is not enough.
     *
     * Stated narrowly, because it is easy to claim more than it gives. The
     * autonomous admission asks four questions in four statements -- the
     * switches, the channel, the template, the prior use -- and under read
     * committed each is answered as of the moment it runs. A decision could be
     * admitted against switches read before an operator turned publishing off
     * and prior use read after, which is an answer that was never true at any
     * single instant.
     *
     * `SERIALIZABLE` makes the four one instant, or the transaction does not
     * commit. It does not make a concurrent unpublish impossible: this
     * transaction committing before that one is a legal order, and the post is
     * then scheduled on evidence that was true at its serialization point,
     * which is the right answer. What it removes is the mixture.
     */
    isolationLevel?: Prisma.TransactionIsolationLevel;
  },
): Promise<T> {
  return client.$transaction(
    (tx) => run(tx as unknown as MarketingTransaction),
    options,
  );
}

/**
 * Whether a failure is PostgreSQL saying "try again", rather than "no".
 *
 * A serialization failure is not a refusal: nothing was wrong with the write,
 * two transactions simply could not both be true. The caller may retry it --
 * but only before anything has left the database, which for the autonomous
 * insert means before any vendor call exists at all (that is S2d2). Retrying
 * after an external effect would repeat the effect.
 *
 * Read through `databaseErrorMetadata()` rather than off `error.code`,
 * because a caller never sees SQLSTATE 40001 here: Prisma turns a serialization
 * conflict in an interactive transaction into `P2034` with a
 * `TransactionWriteConflict` driver cause, and the raw code survives only as
 * the cause's `originalCode`. A predicate that compared `error.code` to
 * "40001" was false for every conflict that actually happens, so the bounded
 * retry the plan requires would never have run once.
 *
 * A deadlock (40P01) counts too, and for the same reason: it is the other way
 * two transactions taking the same locks can fail to both be true, nothing
 * was wrong with either, and neither has made an external call.
 */
export const marketingSerializationFailure = (error: unknown): boolean => {
  const metadata = databaseErrorMetadata(error);
  return (
    metadata.errorCode === "P2034" ||
    metadata.driverKind === "TransactionWriteConflict" ||
    metadata.driverCode === "40001" ||
    metadata.driverCode === "40P01"
  );
};

/** How many times a serialization failure may be retried before it is an answer. */
export const MARKETING_SERIALIZATION_RETRIES = 3;

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
/**
 * The one action S2b2 writes.
 *
 * Its own constant, not a thirtieth entry in `MARKETING_S2B1_ACTIONS`: that
 * table is the approved S2b1 inventory and a test compares it whole, so adding
 * to it would say S2b1 grew an action it was never approved for.
 */
/**
 * The statuses that mean this account has already put a claim in front of
 * people.
 *
 * "Used before" is a question about publication, not about intent, so a
 * `scheduled` post does not answer it yes -- nothing has left yet, and two
 * posts may legitimately be queued for the same claim before either goes. The
 * boundary is the moment a request leaves for the platform, which is why
 * `publishing` and `outcome_unknown` count: for the first we do not yet know
 * the answer and for the second we never will, and in both cases claiming the
 * account has never published it would be asserting something we cannot see.
 * `failed` does not count -- the adapter confirmed nothing was published.
 *
 * The facts resolver that fills `usedBefore` must ask over this same list.
 * Two lists would let a decision be made against one meaning of "published"
 * and written against another.
 */
/**
 * What the admission resolver has to report back, not just decide.
 *
 * `autonomousPublish` is the answer. The other three are what the answer was
 * computed against, and they are here because the store cannot read them for
 * itself without importing the composition that gathers them -- which would
 * put the store downstream of its own caller. Reporting them instead keeps one
 * rule: the caller says what the decision was made under, the resolver says
 * what is true now, and this module refuses the difference.
 */
/** The locked channel row, as the admission resolver is given it. */
export type MarketingAdmissionChannel = {
  readonly id: string;
  readonly channel: MarketingChannelName;
  readonly status: MarketingChannelStatus;
  readonly connectionGeneration: number;
};

export type MarketingAutonomousAdmission = {
  readonly autonomousPublish: boolean;
  /** The digest of the code that decided, over the admission manifest. */
  readonly admissionCodeDigest: string;
  /** `marketingAutomation.configGeneration`, read inside this transaction. */
  readonly configGeneration: number;
  /** The Railway deployment this process belongs to. */
  readonly deploymentId: string;
};

/**
 * How recently a health observation must have been made to count.
 *
 * Sixty seconds, and positive by construction. Health is the one admission
 * input that is about the outside world rather than about a row, so an old
 * observation is not a weaker answer -- it is an answer about a different
 * moment.
 *
 * Here rather than beside the composition that reads it, because it decides an
 * admission and therefore belongs to the bytes `admissionCodeDigest` covers.
 * This module is a manifest root; the composition cannot be one, since it
 * carries the digest itself. It is also not in the Prompt Refiner's runtime
 * source closure, which `lib/marketingAutomationAccess.ts` -- the other
 * obvious home -- is, and a sealed snapshot there is repinned by a person.
 */
export const MARKETING_HEALTH_FRESHNESS_SECONDS = 60;

export type MarketingHealthObservation = {
  readonly channelId: string;
  readonly connectionGeneration: number;
  readonly healthy: boolean;
  readonly observedAt: Date;
};

/**
 * Whether an observation may be used as this channel's health, at this clock.
 *
 * Missing, stale, future-dated or about another channel or connection
 * generation is false -- each for the same reason, that it is not an
 * observation of the thing being asked about now. A future-dated row is not
 * "very fresh": it is a clock disagreement, and treating it as the freshest
 * answer would make a broken clock look like a healthy adapter.
 */
export const marketingHealthIsFresh = (
  observation: MarketingHealthObservation | null,
  now: Date,
  expect: { readonly channelId: string; readonly connectionGeneration: number },
  thresholdSeconds: number = MARKETING_HEALTH_FRESHNESS_SECONDS,
): boolean => {
  if (observation === null) return false;
  if (!(thresholdSeconds > 0)) return false;
  if (observation.channelId !== expect.channelId) return false;
  if (observation.connectionGeneration !== expect.connectionGeneration) {
    return false;
  }
  const age = now.getTime() - observation.observedAt.getTime();
  if (!Number.isFinite(age)) return false;
  if (age < 0) return false;
  if (age > thresholdSeconds * 1000) return false;
  return observation.healthy;
};

export const MARKETING_PRIOR_USE_STATUSES = [
  "publishing",
  "published",
  "outcome_unknown",
  "verified",
  "removed_by_platform",
] as const;

export const MARKETING_S2B2_ACTIONS = Object.freeze({
  postAutonomousScheduled: "marketing_post.autonomous_scheduled",
} as const);

/**
 * The two actions S2c writes.
 *
 * Both are the publisher's, and both are about a slot rather than about a
 * publication. A claim says this worker intends to publish this post in this
 * day's slot and nobody else should; a release says it no longer does. Neither
 * touches `status`, `history`, `publishAttempt` or `providerRequestKey`,
 * because none of those is true yet -- the post is still `scheduled` and
 * nothing has left for the platform.
 */
export const MARKETING_S2C_ACTIONS = Object.freeze({
  postClaimed: "marketing_post.claimed",
  postClaimReleased: "marketing_post.claim_released",
} as const);

/**
 * How long a claim is good for before a sweep may take it back.
 *
 * A lease, not a lock: the process holding it can die, and something has to be
 * able to say so without asking it. Fifteen minutes is longer than any publish
 * this system will make and shorter than the gap between two of them, and the
 * reconciliation that reclaims an expired one is S2d1's.
 */
/**
 * Why a claim was not taken.
 *
 * Every one of these is an ordinary answer rather than a failure. A publisher
 * that finds nothing due, or an account at its cap, has done its job; returning
 * a reason rather than throwing is what lets the caller log it once and go
 * round again without a handler that has to tell errors from non-events apart.
 *
 * A refusal that *is* wrong -- an empty token, a lease in the past -- is thrown
 * instead, because it says the caller is broken rather than that the world is
 * busy.
 */
export type MarketingClaimRefusal =
  | "channel_not_publishing"
  | "channel_posts_by_hand"
  | "not_admitted"
  | "nothing_due"
  | "daily_cap_reached"
  | "weekly_cap_reached"
  | "claim_conflict";

/**
 * Why a slot was given back.
 *
 * Closed, and recorded in the audit entry, because "a claim was released" on
 * its own does not say whether the worker was shutting down tidily or the
 * account was paused underneath it -- and those read very differently in a
 * week's worth of entries.
 */
export const MARKETING_CLAIM_RELEASE_REASONS = [
  /** The lease would expire before the publish could finish. */
  "lease_too_short",
  /** The admission resolver answered no on the re-check before the call. */
  "no_longer_admitted",
  /** The worker is stopping, and is giving back what it has not used. */
  "worker_shutdown",
  /** The adapter this account needs does not exist in this build. */
  "adapter_unavailable",
] as const;

export type MarketingClaimReleaseReason =
  (typeof MARKETING_CLAIM_RELEASE_REASONS)[number];

export const MARKETING_CLAIM_LEASE_MS = 15 * 60 * 1000;

/**
 * What makes a slot spent.
 *
 * `slotDate` and nothing else. A claim writes it, a release clears it, and
 * nothing in between hands it back -- so the column *is* the record of the
 * account's allowance being used, and counting anything else on top of it is
 * a second opinion that can disagree.
 *
 * The first version of this counted a list of statuses and excluded
 * `deletedAt IS NOT NULL`, which made an unpublish give the day back: a post
 * that had gone out, been seen, and then been retracted stopped counting, and
 * the account could spend the same day again. That is exactly the case the
 * caps exist for. A post whose slot was taken and never used gives it back by
 * being released, which is a decision somebody made, not a side effect of a
 * column somewhere else.
 */

/** The caps in force for an account: the policy's, unless an operator lowered them. */
export const marketingChannelCaps = (channel: {
  readonly channel: string;
  readonly dailyCapOverride: number | null;
  readonly weeklyCapOverride: number | null;
}): { readonly daily: number; readonly weekly: number } | null => {
  const policy =
    MARKETING_CHANNEL_CAPS[channel.channel as MarketingChannelName] ?? null;
  // A channel with no policy cap is one that is posted by hand. An override
  // cannot create a cap where the policy has none, because there is no
  // automated posting to cap.
  if (policy === null) return null;
  const lower = (cap: number, override: number | null) =>
    override === null ? cap : Math.min(cap, override);
  return {
    daily: lower(policy.daily, channel.dailyCapOverride),
    weekly: lower(policy.weekly, channel.weeklyCapOverride),
  };
};

export const MARKETING_REQUEUE_ACTION = "marketing_post.requeue_after_failure";

/** Exact S2b1 action names. These strings are audit/store contracts. */
/**
 * What each refusal means to an HTTP caller.
 *
 * Here rather than in the route layer because the route layer had a copy and
 * three of its keys were misspellings of codes this module throws -- the
 * conflicts they described went out as 422 instead of 409. A caller that has
 * to transcribe another module's strings will eventually transcribe one wrong,
 * so the strings and their meaning live together and a test fails when a new
 * refusal has no entry.
 *
 * A conflict is the default: almost every refusal here is the row not being in
 * the state the caller decided against, which is exactly what 409 is for.
 */
/**
 * The evidence refusals, which are built from a closed list rather than typed.
 *
 * Three call sites raise `${prefix}_${problem}` from
 * `MARKETING_AUDIT_PROBLEMS`, so thirty codes exist that no quoted string in
 * this file contains. The completeness test read quoted strings, so all thirty
 * were missing from the table and went out as 422 instead of 409 -- a
 * structural test with a hole exactly where the codes were not literals.
 */
const evidenceRefusalStatuses = (): Record<string, number> => {
  const statuses: Record<string, number> = {};
  for (const prefix of ["resume_evidence", "requeue_evidence", "audit_evidence"]) {
    for (const problem of MARKETING_AUDIT_PROBLEMS) {
      statuses[`${prefix}_${problem}`] = 409;
    }
  }
  return statuses;
};

export const MARKETING_REFUSAL_STATUS: Readonly<Record<string, number>> =
  Object.freeze({
    ...evidenceRefusalStatuses(),
    channel_not_found: 404,
    post_not_found: 404,
    approval_expiry_invalid: 400,
    cap_change_is_noop: 400,
    cap_override_invalid: 400,
    default_locale_not_allowed: 400,
    failure_code_invalid: 400,
    pause_reason_invalid: 400,
    period_is_backwards: 400,
    policy_version_invalid: 400,
    resume_reason_invalid: 400,
    scopes_digest_unchanged: 400,
    account_slug_exhausted: 503,
    database_clock_unavailable: 503,
    autonomous_creation_not_available: 501,
    account_already_disconnected: 409,
    approval_conflict: 409,
    approval_expiry_conflict: 409,
    autonomous_mode_not_settable_here: 409,
    cap_change_conflict: 409,
    cap_change_raises_limit: 409,
    channel_changed_under_us: 409,
    connection_confirmation_conflict: 409,
    disconnect_conflict: 409,
    edit_audit_reused: 409,
    edit_changes_immutable_scope: 409,
    edit_conflict: 409,
    edit_guard_binding_mismatch: 409,
    edited_content_guard_rejected: 409,
    entry_belongs_to_retention: 409,
    envelope_account_not_this_channel: 409,
    envelope_digest_not_of_this_envelope: 409,
    envelope_digest_without_envelope: 409,
    envelope_disagrees_with_columns: 409,
    envelope_schedule_disagrees: 409,
    envelope_scheduled_at_create: 409,
    guard_decision_not_about_these_facts: 409,
    guard_decision_not_about_this_post: 409,
    guard_decision_not_sealed: 409,
    legal_hold_conflict: 409,
    manual_channel_has_no_caps: 409,
    mark_reusable_conflict: 409,
    outcome_evidence_invalid: 409,
    outcome_resolution_conflict: 409,
    pause_conflict: 409,
    policy_change_conflict: 409,
    published_evidence_invalid: 409,
    reconnect_conflict: 409,
    rejection_conflict: 409,
    requeue_conflict: 409,
    requeue_evidence_missing: 409,
    requeue_without_failure: 409,
    resume_approval_conflict: 409,
  resume_drain_required: 409,
  drain_not_stopped: 409,
  identity_change_needs_connection: 409,
  autonomous_insert_not_eligible: 409,
  autonomous_insert_has_codes: 409,
  autonomous_insert_not_scheduled: 409,
  autonomous_insert_without_template: 409,
  autonomous_insert_template_mismatch: 409,
  autonomous_insert_template_digest_mismatch: 409,
  autonomous_insert_channel_not_autonomous: 409,
  autonomous_insert_channel_has_no_autonomy: 409,
  autonomous_insert_slot_not_future: 409,
  autonomous_insert_slot_unreadable: 409,
  autonomous_insert_facts_mismatch: 422,
  autonomous_insert_claim_no_longer_used: 409,
  autonomous_insert_asset_no_longer_used: 409,
  autonomous_insert_code_digest_changed: 409,
  autonomous_insert_config_generation_changed: 409,
  autonomous_insert_deployment_changed: 409,
  autonomous_insert_deployment_unknown: 503,
  // The three the claim path throws rather than answers. A publisher asking
  // for a slot with an empty token or a lease that has already expired is not
  // describing a busy world, it is describing itself being wrong -- and a
  // request nobody can fix by changing it is a 500. They are here because no
  // HTTP route raises them today and one might, and a refusal with no meaning
  // is how the last two slices found their own gaps.
  claim_token_empty: 500,
  claim_lease_not_positive: 500,
  claim_release_reason_unknown: 500,
  claim_release_lease_unreadable: 500,
  transaction_not_serializable: 500,
  autonomous_insert_binding_expired: 409,
  autonomous_insert_binding_not_sealed: 409,
  autonomous_insert_template_gone: 409,
  autonomous_insert_template_changed: 409,
  autonomous_insert_not_admitted: 409,
    resume_autonomous_conflict: 409,
    resume_autonomous_not_allowed: 409,
    resume_evidence_missing: 409,
    resume_evidence_reused: 409,
    schedule_conflict: 409,
    scopes_change_conflict: 409,
    unpublish_conflict: 409,
    unpublish_not_confirmed: 409,
  });

export const MARKETING_S2B1_ACTIONS = Object.freeze({
  accountCreate: "marketing_account.create",
  accountConnectionConfirmed: "marketing_account.connection_confirmed",
  accountDisconnect: "marketing_account.disconnect",
  accountReconnect: "marketing_account.reconnect",
  accountScopesChanged: "marketing_account.scopes_changed",
  accountPolicyVersionChanged: "marketing_account.policy_version_changed",
  accountPause: "marketing_account.pause",
  accountResumeApproval: "marketing_account.resume_approval",
  postApprovalExpiredOnResume: "marketing_post.approval_expired_on_resume",
  accountResumeAutonomous: MARKETING_RESUME_AUTONOMOUS_ACTION,
  accountDrainDueApprovals: "marketing_account.drain_due_approvals",
  accountLowerCaps: "marketing_account.lower_caps",
  postApprove: "marketing_post.approve",
  postReject: "marketing_post.reject",
  postEdit: "marketing_post.edit",
  postMarkReusable: "marketing_post.mark_reusable",
  postSchedule: "marketing_post.schedule",
  postRequeueAfterFailure: MARKETING_REQUEUE_ACTION,
  postLegalHoldSet: "marketing_post.legal_hold_set",
  postLegalHoldReleased: "marketing_post.legal_hold_released",
  postResolveOutcomeUnknown: "marketing_post.resolve_outcome_unknown",
  postUnpublish: "marketing_post.unpublish",
  settingDraftsChanged: "marketing_setting.drafts_changed",
  settingPublishChanged: "marketing_setting.publish_changed",
  settingAutonomousChanged: "marketing_setting.autonomous_changed",
} as const);

// Defined in the pure schema module, beside the resume codes, because the
// console offers both and cannot import this one: this file is server-only.
// Re-exported under its own name so nothing that reads it has to know that.
export {
  MARKETING_PAUSE_REASON_CODES,
  type MarketingPauseReasonCode,
} from "@/lib/marketingAutomationSchema";

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
  const existing = await database.marketingChannel.findMany({
    where: { channel },
    select: { accountSlug: true },
  });
  const used = new Set(existing.map((row) => row.accountSlug));
  for (let candidate = 1; candidate <= 999; candidate += 1) {
    const slug = `${channel}-${candidate}`;
    if (!used.has(slug)) return slug;
  }
  throw new MarketingStoreRefusedError(
    "account_slug_exhausted",
    `No free account slug for ${channel}`,
  );
}

export async function createMarketingChannel(
  database: MarketingDatabase,
  rawInput: CreateMarketingChannelInput,
) {
  // Materialise before the slug lookup awaits. A caller-owned object must not
  // answer validation with one account and the insert with another.
  const rawExternalAccountRef = rawInput.externalAccountRef;
  const input: CreateMarketingChannelInput = {
    channel: rawInput.channel,
    provider: rawInput.provider,
    externalAccountRef:
      rawExternalAccountRef === null ? null : String(rawExternalAccountRef),
    defaultLocale: rawInput.defaultLocale,
    allowedLocales: [...rawInput.allowedLocales],
    scopesDigest: String(rawInput.scopesDigest),
    policyVersion: Number(rawInput.policyVersion),
  };
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
  rawId: string,
  rawPatch: MarketingChannelPatch,
  rawResume?: MarketingResumeEvidence,
) {
  // Read once. The audit check below is an `await`, and the object it verified
  // was read again afterwards: a `resume` whose fields answered one pair to
  // the verification and another to the write had the second pair recorded as
  // the evidence for the first.
  const id = String(rawId);
  const patch: MarketingChannelPatch = { ...rawPatch };
  const resume =
    rawResume === undefined
      ? undefined
      : {
          auditLogId: String(rawResume.auditLogId),
          reasonCode: rawResume.reasonCode,
        };

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

  let current: {
    status: string;
    pausedAt: Date | null;
    pauseReasonCode: string | null;
    lastResumeAuditLogId: string | null;
  } | null = null;

  if (patch.status === "autonomous_mode") {
    current = await database.marketingChannel.findUnique({
      where: { id },
      select: {
        status: true,
        pausedAt: true,
        pauseReasonCode: true,
        lastResumeAuditLogId: true,
      },
    });
    if (current?.status === "paused") {
      if (!resume) {
        throw new MarketingStoreRefusedError(
          "resume_evidence_missing",
          "Returning an account to autonomous mode needs the operator's reason and audit entry",
        );
      }
      if (resume.auditLogId === current.lastResumeAuditLogId) {
        throw new MarketingStoreRefusedError(
          "resume_evidence_reused",
          "That audit entry already resumed this account once",
        );
      }
      const verdict = await verifyMarketingAuditEvidence(database, {
        auditLogId: resume.auditLogId,
        action: MARKETING_RESUME_AUTONOMOUS_ACTION,
        targetId: id,
        metadata: { reasonCode: resume.reasonCode },
        // The decision has to be later than the pause it answers. Without this
        // two entries from earlier resumes could be used alternately to bring
        // the account back for ever, and the trigger -- which only sees that
        // the column changed -- would agree every time.
        notBefore: current.pausedAt ?? undefined,
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

  // **Compare and set, not just set.** The audit check above is an `await`,
  // and what it verified was the row as it was before: another writer could
  // resume the account with a newer entry and pause it again in between, and
  // this update would then record the older entry as the evidence for the
  // pause that is there now. The state the checks were made against is part
  // of the condition, and nought rows is a refusal rather than a silent
  // success.
  const updated = await database.marketingChannel.updateMany({
    where: {
      id,
      ...(current
        ? {
            status: current.status,
            pausedAt: current.pausedAt,
            pauseReasonCode: current.pauseReasonCode,
            lastResumeAuditLogId: current.lastResumeAuditLogId,
          }
        : {}),
    },
    data,
  });
  if (updated.count !== 1) {
    throw new MarketingStoreRefusedError(
      "channel_changed_under_us",
      "The account moved between the checks and the write",
    );
  }
  return database.marketingChannel.findUniqueOrThrow({ where: { id } });
}

type LockedMarketingChannel = {
  id: string;
  channel: MarketingChannelName;
  status: MarketingChannelStatus;
  connectionGeneration: number;
  scopesDigest: string;
  policyVersion: number;
  graduationEpoch: number;
  graduatedAt: Date | null;
  graduationSnapshot: Prisma.JsonValue | null;
  pausedAt: Date | null;
  pausedFromMode: MarketingPausableMode | null;
  pauseReasonCode: string | null;
  lastResumeAuditLogId: string | null;
  dailyCapOverride: number | null;
  weeklyCapOverride: number | null;
};

/** S2b1 lifecycle writers always take the row lock before deciding. */
async function lockMarketingChannel(
  database: MarketingDatabase,
  id: string,
): Promise<LockedMarketingChannel> {
  const rows = await database.$queryRaw<LockedMarketingChannel[]>(Prisma.sql`
    SELECT
      "id", "channel", "status", "connectionGeneration", "scopesDigest",
      "policyVersion", "graduationEpoch", "graduatedAt", "graduationSnapshot",
      "pausedAt", "pausedFromMode", "pauseReasonCode", "lastResumeAuditLogId",
      "dailyCapOverride", "weeklyCapOverride"
    FROM "MarketingChannel"
    WHERE "id" = ${id}
    FOR UPDATE
  `);
  const row = rows[0];
  if (!row) {
    throw new MarketingStoreRefusedError(
      "channel_not_found",
      "The marketing account does not exist",
    );
  }
  return row;
}

const requireOne = (count: number, code: string, message: string): void => {
  if (count !== 1) throw new MarketingStoreRefusedError(code, message);
};

export async function confirmMarketingChannelConnection(
  database: MarketingTransaction,
  rawInput: { id: string; expectedConnectionGeneration: number },
) {
  const input = {
    id: String(rawInput.id),
    expectedConnectionGeneration: Number(rawInput.expectedConnectionGeneration),
  };
  const row = await lockMarketingChannel(database, input.id);
  if (
    row.status !== "connect_pending" ||
    row.connectionGeneration !== input.expectedConnectionGeneration
  ) {
    throw new MarketingStoreRefusedError(
      "connection_confirmation_conflict",
      "The account is no longer the connection that was confirmed",
    );
  }
  // The last edge out of a stopped state that did not pay for it.
  // `connect_pending` is in the stopped set and is drainable, so a post can be
  // sitting there due -- nothing in the post writers checks the channel's
  // status -- and this walks the account straight into `approval_mode`, where
  // the publisher can take it. The rule is the edge, not the name of the
  // state it starts in.
  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  await expireDueApprovals(database, input.id, now, {
    refuseIfMore: true,
    // Its own edge, not an identity change. Nothing identifying moves here --
    // the connection generation, the scopes digest and the policy version all
    // stay, and the channel trigger's own `identity_changed` condition does
    // not include this transition. Recording it as one would have the
    // hash-chained record name a door that was not used.
    trigger: "connection_confirmed",
  });

  const updated = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      status: "connect_pending",
      connectionGeneration: input.expectedConnectionGeneration,
    },
    data: { status: "approval_mode" },
  });
  requireOne(
    updated.count,
    "connection_confirmation_conflict",
    "The account changed before connection confirmation committed",
  );
}

export async function disconnectMarketingChannel(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedStatus: MarketingChannelStatus;
    expectedConnectionGeneration: number;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedStatus: rawInput.expectedStatus,
    expectedConnectionGeneration: Number(rawInput.expectedConnectionGeneration),
  };
  if (input.expectedStatus === "disconnected") {
    throw new MarketingStoreRefusedError(
      "account_already_disconnected",
      "A disconnected account cannot be disconnected again",
    );
  }
  const row = await lockMarketingChannel(database, input.id);
  if (
    row.status !== input.expectedStatus ||
    row.connectionGeneration !== input.expectedConnectionGeneration
  ) {
    throw new MarketingStoreRefusedError(
      "disconnect_conflict",
      "The account is no longer in the expected connection state",
    );
  }
  const updated = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      status: input.expectedStatus,
      connectionGeneration: input.expectedConnectionGeneration,
    },
    data: { status: "disconnected", pauseReasonCode: null },
  });
  requireOne(updated.count, "disconnect_conflict", "The account changed before disconnect");
}

export async function reconnectMarketingChannel(
  database: MarketingTransaction,
  rawInput: { id: string; expectedConnectionGeneration: number },
) {
  const input = {
    id: String(rawInput.id),
    expectedConnectionGeneration: Number(rawInput.expectedConnectionGeneration),
  };
  const row = await lockMarketingChannel(database, input.id);
  if (
    row.status !== "disconnected" ||
    row.connectionGeneration !== input.expectedConnectionGeneration
  ) {
    throw new MarketingStoreRefusedError(
      "reconnect_conflict",
      "The account is no longer the disconnected connection being resumed",
    );
  }
  // An identity change forces the account back to `approval_mode`, which from
  // `paused` is a resume however it is spelled -- so it owes what a resume
  // owes. Without this a scope change on a paused account put a post whose
  // slot had passed back in front of the publisher, which is the thing policy
  // section 8.2 exists to stop, reached by a door nobody thought of as a
  // resume.
  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  if (marketingChannelWasStopped(row.status)) {
    // Only from a stopped state. Returning a *running* account to approval
    // mode is not a resume, and expiring its live schedules would be a
    // decision policy section 8.2 does not make and nobody has taken.
    await expireDueApprovals(database, input.id, now, {
      refuseIfMore: true,
      trigger: "identity_change",
    });
  }

  const updated = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      status: "disconnected",
      connectionGeneration: input.expectedConnectionGeneration,
      graduationEpoch: row.graduationEpoch,
    },
    data: {
      status: "approval_mode",
      connectionGeneration: input.expectedConnectionGeneration + 1,
      graduationEpoch: row.graduationEpoch + 1,
      graduatedAt: null,
      graduationSnapshot: Prisma.DbNull,
      pauseReasonCode: null,
    },
  });
  requireOne(updated.count, "reconnect_conflict", "The account changed before reconnect");
}

export async function changeMarketingChannelScopes(
  database: MarketingTransaction,
  rawInput: {
    id: string;
    expectedScopesDigest: string;
    expectedPolicyVersion: number;
    expectedGraduationEpoch: number;
    scopesDigest: string;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedScopesDigest: String(rawInput.expectedScopesDigest),
    expectedPolicyVersion: Number(rawInput.expectedPolicyVersion),
    expectedGraduationEpoch: Number(rawInput.expectedGraduationEpoch),
    scopesDigest: String(rawInput.scopesDigest),
  };
  if (input.scopesDigest === input.expectedScopesDigest) {
    throw new MarketingStoreRefusedError(
      "scopes_digest_unchanged",
      "A scope change needs a different digest",
    );
  }
  const row = await lockMarketingChannel(database, input.id);
  if (
    row.scopesDigest !== input.expectedScopesDigest ||
    row.policyVersion !== input.expectedPolicyVersion ||
    row.graduationEpoch !== input.expectedGraduationEpoch
  ) {
    throw new MarketingStoreRefusedError(
      "scopes_change_conflict",
      "The account identity changed before its scopes were saved",
    );
  }
  if (row.status === "disconnected") {
    // Leaving `disconnected` takes a new connection generation (the channel
    // trigger requires it), and these writers do not issue one -- so this
    // reached the database as a raw exception and came back a 500. Bumping
    // the generation here would make a scope change a way to reconnect an
    // account, and reconnecting is a person confirming a connection. Refused
    // instead, naming the control that does it.
    throw new MarketingStoreRefusedError(
      "identity_change_needs_connection",
      "Reconnect the account before changing its identity",
    );
  }
  // An identity change forces the account back to `approval_mode`, which from
  // `paused` is a resume however it is spelled -- so it owes what a resume
  // owes. Without this a scope change on a paused account put a post whose
  // slot had passed back in front of the publisher, which is the thing policy
  // section 8.2 exists to stop, reached by a door nobody thought of as a
  // resume.
  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  if (marketingChannelWasStopped(row.status)) {
    // Only from a stopped state. Returning a *running* account to approval
    // mode is not a resume, and expiring its live schedules would be a
    // decision policy section 8.2 does not make and nobody has taken.
    await expireDueApprovals(database, input.id, now, {
      refuseIfMore: true,
      trigger: "identity_change",
    });
  }

  const updated = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      scopesDigest: input.expectedScopesDigest,
      policyVersion: input.expectedPolicyVersion,
      graduationEpoch: input.expectedGraduationEpoch,
    },
    data: {
      scopesDigest: input.scopesDigest,
      status: "approval_mode",
      graduationEpoch: input.expectedGraduationEpoch + 1,
      graduatedAt: null,
      graduationSnapshot: Prisma.DbNull,
      pauseReasonCode: null,
    },
  });
  requireOne(updated.count, "scopes_change_conflict", "The account changed before scopes update");
}

export async function changeMarketingChannelPolicyVersion(
  database: MarketingTransaction,
  rawInput: {
    id: string;
    expectedPolicyVersion: number;
    expectedScopesDigest: string;
    expectedGraduationEpoch: number;
    policyVersion: number;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedPolicyVersion: Number(rawInput.expectedPolicyVersion),
    expectedScopesDigest: String(rawInput.expectedScopesDigest),
    expectedGraduationEpoch: Number(rawInput.expectedGraduationEpoch),
    policyVersion: Number(rawInput.policyVersion),
  };
  if (
    !Number.isInteger(input.policyVersion) ||
    input.policyVersion <= 0 ||
    input.policyVersion === input.expectedPolicyVersion
  ) {
    throw new MarketingStoreRefusedError(
      "policy_version_invalid",
      "A policy change needs a different positive integer version",
    );
  }
  const row = await lockMarketingChannel(database, input.id);
  if (
    row.policyVersion !== input.expectedPolicyVersion ||
    row.scopesDigest !== input.expectedScopesDigest ||
    row.graduationEpoch !== input.expectedGraduationEpoch
  ) {
    throw new MarketingStoreRefusedError(
      "policy_change_conflict",
      "The account identity changed before its policy version was saved",
    );
  }
  if (row.status === "disconnected") {
    // Leaving `disconnected` takes a new connection generation (the channel
    // trigger requires it), and these writers do not issue one -- so this
    // reached the database as a raw exception and came back a 500. Bumping
    // the generation here would make a scope change a way to reconnect an
    // account, and reconnecting is a person confirming a connection. Refused
    // instead, naming the control that does it.
    throw new MarketingStoreRefusedError(
      "identity_change_needs_connection",
      "Reconnect the account before changing its identity",
    );
  }
  // An identity change forces the account back to `approval_mode`, which from
  // `paused` is a resume however it is spelled -- so it owes what a resume
  // owes. Without this a scope change on a paused account put a post whose
  // slot had passed back in front of the publisher, which is the thing policy
  // section 8.2 exists to stop, reached by a door nobody thought of as a
  // resume.
  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  if (marketingChannelWasStopped(row.status)) {
    // Only from a stopped state. Returning a *running* account to approval
    // mode is not a resume, and expiring its live schedules would be a
    // decision policy section 8.2 does not make and nobody has taken.
    await expireDueApprovals(database, input.id, now, {
      refuseIfMore: true,
      trigger: "identity_change",
    });
  }

  const updated = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      policyVersion: input.expectedPolicyVersion,
      scopesDigest: input.expectedScopesDigest,
      graduationEpoch: input.expectedGraduationEpoch,
    },
    data: {
      policyVersion: input.policyVersion,
      status: "approval_mode",
      graduationEpoch: input.expectedGraduationEpoch + 1,
      graduatedAt: null,
      graduationSnapshot: Prisma.DbNull,
      pauseReasonCode: null,
    },
  });
  requireOne(updated.count, "policy_change_conflict", "The account changed before policy update");
}

export async function pauseMarketingChannel(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedStatus: MarketingPausableMode;
    reasonCode: MarketingPauseReasonCode;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedStatus: rawInput.expectedStatus,
    reasonCode: rawInput.reasonCode,
  };
  if (!(MARKETING_PAUSE_REASON_CODES as readonly string[]).includes(input.reasonCode)) {
    throw new MarketingStoreRefusedError(
      "pause_reason_invalid",
      "The pause reason is not one of the recorded reason codes",
    );
  }
  const row = await lockMarketingChannel(database, input.id);
  if (row.status !== input.expectedStatus) {
    throw new MarketingStoreRefusedError(
      "pause_conflict",
      "The account is no longer in the mode being paused",
    );
  }
  const updated = await database.marketingChannel.updateMany({
    where: { id: input.id, status: input.expectedStatus },
    data: { status: "paused", pauseReasonCode: input.reasonCode },
  });
  requireOne(updated.count, "pause_conflict", "The account changed before pause");
}

type DueApprovalPost = {
  id: string;
  status: "approved" | "scheduled";
  historyVersion: number;
  /**
   * Null for an autonomous post, which has no approval window at all.
   *
   * It was typed as a `Date` while the query selected only rows whose window
   * had closed. Widening the query to cover a schedule that came due made the
   * null reachable, and the audit metadata dereferenced it -- so the resume
   * that was supposed to expire the post threw instead, and rolled back the
   * resume with it.
   */
  approvalExpiresAt: Date | null;
  scheduledAt: Date | null;
};

/**
 * How many due approvals one transaction may expire.
 *
 * Each one is a locked row, a conditional update and an audit append, and the
 * audit append takes a chain-wide advisory lock -- so this is not only this
 * account's latency, it is how long every other audit write waits. Fifty is
 * chosen to stay far inside the wrapper's twenty-second transaction timeout
 * with the chain lock held; a backlog larger than it is drained rather than
 * pushed through one transaction.
 */
const MARKETING_RESUME_DRAIN_LIMIT = 50;

/**
 * The states in which the publisher is not taking this account's posts.
 *
 * What policy section 8.2 is actually about: a slot that passed while nothing
 * was publishing must not go out the instant something is. Being paused is the
 * obvious one, but a disconnected account is not publishing either, and a
 * reconnect walks it straight back to `approval_mode` -- so it owes the same
 * expiry. Written as `status === "paused"` that call was dead code, which is
 * what the compiler pointed at.
 */
const MARKETING_STOPPED_STATUSES = [
  "paused",
  "disconnected",
  "connect_pending",
] as const;

const marketingChannelWasStopped = (status: string): boolean =>
  (MARKETING_STOPPED_STATUSES as readonly string[]).includes(status);

/**
 * Default resume path. Due approvals are expired and audited before the
 * account leaves paused, all under the caller's one transaction.
 */
/**
 * Expires every approval this account has that came due while it was stopped.
 *
 * Policy section 8.2 says a schedule that came due during a pause becomes an
 * expired approval rather than a post that goes out the moment the account is
 * back, and it does not say that only one kind of resume has to do it. It was
 * written inside the approval resume, so an account resumed into autonomous
 * mode kept its stale schedules and the publisher could take them straight
 * out -- which is the thing the rule exists to stop.
 *
 * Two independent reasons a post is due: its approval window closed, or its
 * slot passed. An autonomous post has no approval window at all, so neither
 * the row nor the audit entry may assume one.
 */
async function expireDueApprovals(
  database: MarketingTransaction,
  channelId: string,
  now: Date,
  options: {
    refuseIfMore: boolean;
    /**
     * Which door this came through.
     *
     * The action name stays the one the S2 inventory names, because it is one
     * fact -- an approval that came due while the account was stopped -- and
     * splitting it would mean two names for one thing. But the sentence used
     * to say "while its account resumed", and a drain is not a resume and an
     * identity change is not spelled like one, so the record was asserting a
     * door that had not been used.
     */
    trigger:
      | "resume"
      | "identity_change"
      | "connection_confirmed"
      | "drain";
  },
): Promise<{ expiredPostIds: string[]; remaining: boolean }> {
  // One more row than this transaction will touch, so "is there more" is an
  // answer this query already has rather than a second scan.
  const due = await database.$queryRaw<DueApprovalPost[]>(Prisma.sql`
    SELECT "id", "status", "historyVersion", "approvalExpiresAt", "scheduledAt"
    FROM "MarketingPost"
    WHERE "channelId" = ${channelId}
      AND "status" IN ('approved', 'scheduled')
      AND (
        "approvalExpiresAt" <= ${now}
        OR ("scheduledAt" IS NOT NULL AND "scheduledAt" <= ${now})
      )
    ORDER BY "id"
    LIMIT ${MARKETING_RESUME_DRAIN_LIMIT + 1}
    FOR UPDATE
  `);
  const remaining = due.length > MARKETING_RESUME_DRAIN_LIMIT;
  if (remaining && options.refuseIfMore) {
    // Before the first update, so the transaction that cannot succeed has not
    // also spent the chain lock on fifty audit appends on its way to failing.
    throw new MarketingStoreRefusedError(
      "resume_drain_required",
      "Too many approvals came due during the pause to expire in one resume",
    );
  }
  const expiredPostIds: string[] = [];
  for (const post of due.slice(0, MARKETING_RESUME_DRAIN_LIMIT)) {
    const expired = await database.marketingPost.updateMany({
      where: {
        id: post.id,
        status: post.status,
        historyVersion: post.historyVersion,
        approvalExpiresAt: post.approvalExpiresAt,
      },
      data: { status: "approval_expired" },
    });
    requireOne(
      expired.count,
      "approval_expiry_conflict",
      "A due post changed while the account was resuming",
    );
    await writeSystemAuditLog({
      tx: database,
      systemActor: "marketing-guard",
      action: MARKETING_S2B1_ACTIONS.postApprovalExpiredOnResume,
      targetType: "MarketingPost",
      targetId: post.id,
      summary: "Expired a due marketing approval while its account was stopped.",
      metadata: {
        channelId,
        trigger: options.trigger,
        historyVersion: post.historyVersion,
        // Both reasons, not the first true one: a post can be past its slot
        // *and* out of approval window, and reporting only the window loses
        // the fact that the schedule had also gone by.
        dueByApprovalWindow:
          post.approvalExpiresAt !== null && post.approvalExpiresAt <= now,
        dueBySchedule: post.scheduledAt !== null && post.scheduledAt <= now,
        // The instant both were judged against, so the two booleans can be
        // checked afterwards rather than taken on trust.
        judgedAt: now.toISOString(),
        approvalExpiresAt: post.approvalExpiresAt?.toISOString() ?? null,
        scheduledAt: post.scheduledAt?.toISOString() ?? null,
      },
    });
    expiredPostIds.push(post.id);
  }
  return { expiredPostIds, remaining };
}

/**
 * Expires a bounded batch of due approvals while the account stays paused.
 *
 * A resume does its own expiry, but it can only do a bounded amount of it --
 * so an account that accumulated more due posts than one transaction may touch
 * could not resume at all, and each attempt burned the same work again under
 * the audit chain's advisory lock before timing out. Lifting the bound was not
 * the answer: it only moved the ceiling from a number to a latency.
 *
 * This is the other half. It expires up to the same bound and leaves the
 * account exactly where it was -- in one of the states where the publisher is
 * not taking its posts, which is what keeps them from going out meanwhile --
 * and says whether more remain. Called until `remaining` is false, it leaves a resume with nothing
 * to do but the small final batch, and the resume still verifies that for
 * itself rather than trusting that this ran.
 *
 * It only ever moves posts to `approval_expired`, so there is no state it can
 * reach in which something goes out; that is why the kill switch does not gate
 * it. A kill-switched account that could not be drained could not be resumed
 * afterwards either.
 *
 * It accepts every state the resumes refuse from, not just `paused`. A drain
 * narrower than the refusal is a hole: a disconnected account past the bound
 * refused to reconnect, could not be drained, and has no edge into `paused`.
 */
export async function drainDueMarketingApprovals(
  database: MarketingTransaction,
  rawInput: { id: string },
): Promise<{
  status: MarketingChannelStatus;
  expiredPostIds: string[];
  remaining: boolean;
}> {
  const input = { id: String(rawInput.id) };
  const channel = await lockMarketingChannel(database, input.id);
  if (!marketingChannelWasStopped(channel.status)) {
    // The same predicate the resumes use, and it has to be: a drain that
    // covered fewer states than the refusal did left a hole. A disconnected
    // account with more than one batch of due posts refused to reconnect, had
    // no way to be drained, and has no transition into `paused` -- so no
    // Admin route could reduce the backlog and the account was stuck for good.
    throw new MarketingStoreRefusedError(
      "drain_not_stopped",
      "Only an account that is not publishing has approvals to drain",
    );
  }
  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  const drained = await expireDueApprovals(database, input.id, now, {
    refuseIfMore: false,
    trigger: "drain",
  });
  return { status: channel.status, ...drained };
}

export async function resumeMarketingChannelToApproval(
  database: MarketingTransaction,
  rawInput: { id: string },
): Promise<{ expiredPostIds: string[] }> {
  const input = { id: String(rawInput.id) };
  const channel = await lockMarketingChannel(database, input.id);
  if (channel.status !== "paused") {
    throw new MarketingStoreRefusedError(
      "resume_approval_conflict",
      "Only a paused account can resume into approval mode",
    );
  }
  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  const { expiredPostIds } = await expireDueApprovals(database, input.id, now, {
    // A backlog larger than one transaction's bound refuses here rather than
    // being half-expired and rolled back. The drain action clears it while
    // the account stays paused.
    refuseIfMore: true,
    trigger: "resume",
  });
  const resumed = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      status: "paused",
      pausedAt: channel.pausedAt,
      pausedFromMode: channel.pausedFromMode,
      pauseReasonCode: channel.pauseReasonCode,
      lastResumeAuditLogId: channel.lastResumeAuditLogId,
    },
    data: { status: "approval_mode", pauseReasonCode: null },
  });
  requireOne(
    resumed.count,
    "resume_approval_conflict",
    "The account changed before approval-mode resume",
  );
  return { expiredPostIds };
}

export async function resumeMarketingChannelToAutonomous(
  database: MarketingTransaction,
  rawInput: {
    id: string;
    auditLogId: string;
    reasonCode: MarketingResumeReasonCode;
  },
) {
  const input = {
    id: String(rawInput.id),
    auditLogId: String(rawInput.auditLogId),
    reasonCode: rawInput.reasonCode,
  };
  if (
    !(MARKETING_RESUME_REASON_CODES as readonly unknown[]).includes(
      input.reasonCode,
    )
  ) {
    throw new MarketingStoreRefusedError(
      "resume_reason_invalid",
      "Autonomous resume needs a closed reason code",
    );
  }
  const row = await lockMarketingChannel(database, input.id);
  if (
    row.status !== "paused" ||
    row.pausedFromMode !== "autonomous_mode" ||
    (MARKETING_NO_AUTONOMY_CHANNELS as readonly string[]).includes(row.channel)
  ) {
    throw new MarketingStoreRefusedError(
      "resume_autonomous_not_allowed",
      "The account cannot resume into autonomous mode",
    );
  }
  if (input.auditLogId === row.lastResumeAuditLogId) {
    throw new MarketingStoreRefusedError(
      "resume_evidence_reused",
      "That audit entry already resumed this account once",
    );
  }
  const verdict = await verifyMarketingAuditEvidence(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_RESUME_AUTONOMOUS_ACTION,
    targetId: input.id,
    metadata: { reasonCode: input.reasonCode },
    notBefore: row.pausedAt ?? undefined,
  });
  if (!verdict.ok) {
    throw new MarketingStoreRefusedError(
      `resume_evidence_${verdict.problem}`,
      `The audit entry for this resume is not evidence of it: ${verdict.problem}`,
    );
  }
  // Policy section 8.2 does not limit this to one kind of resume: a schedule
  // that came due while the account was stopped is an expired approval either
  // way. Written only into the approval resume, it left an autonomous account
  // holding stale schedules the publisher could take out the moment it came
  // back -- which is the thing the rule exists to stop.
  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  const { expiredPostIds } = await expireDueApprovals(database, input.id, now, {
    // A backlog larger than one transaction's bound refuses here rather than
    // being half-expired and rolled back. The drain action clears it while
    // the account stays paused.
    refuseIfMore: true,
    trigger: "resume",
  });
  const updated = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      status: "paused",
      pausedFromMode: "autonomous_mode",
      pausedAt: row.pausedAt,
      pauseReasonCode: row.pauseReasonCode,
      lastResumeAuditLogId: row.lastResumeAuditLogId,
      graduationEpoch: row.graduationEpoch,
    },
    data: {
      status: "autonomous_mode",
      lastResumeAuditLogId: input.auditLogId,
      lastResumeReasonCode: input.reasonCode,
      pauseReasonCode: null,
    },
  });
  requireOne(
    updated.count,
    "resume_autonomous_conflict",
    "The account changed before autonomous resume",
  );
  return { expiredPostIds };
}

export async function lowerMarketingChannelCaps(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    dailyCapOverride: number | null;
    weeklyCapOverride: number | null;
  },
) {
  const input = {
    id: String(rawInput.id),
    dailyCapOverride:
      rawInput.dailyCapOverride === null ? null : Number(rawInput.dailyCapOverride),
    weeklyCapOverride:
      rawInput.weeklyCapOverride === null
        ? null
        : Number(rawInput.weeklyCapOverride),
  };
  for (const value of [input.dailyCapOverride, input.weeklyCapOverride]) {
    if (value !== null && (!Number.isInteger(value) || value < 0)) {
      throw new MarketingStoreRefusedError(
        "cap_override_invalid",
        "Posting cap overrides are non-negative integers",
      );
    }
  }
  const row = await lockMarketingChannel(database, input.id);
  const policy = MARKETING_CHANNEL_CAPS[row.channel];
  if (!policy) {
    throw new MarketingStoreRefusedError(
      "manual_channel_has_no_caps",
      "A manual channel has no publisher cap to override",
    );
  }
  const oldDaily = row.dailyCapOverride ?? policy.daily;
  const oldWeekly = row.weeklyCapOverride ?? policy.weekly;
  const newDaily = input.dailyCapOverride ?? policy.daily;
  const newWeekly = input.weeklyCapOverride ?? policy.weekly;
  if (newDaily > oldDaily || newWeekly > oldWeekly) {
    throw new MarketingStoreRefusedError(
      "cap_change_raises_limit",
      "This action may only lower effective posting caps",
    );
  }
  if (
    input.dailyCapOverride === row.dailyCapOverride &&
    input.weeklyCapOverride === row.weeklyCapOverride
  ) {
    throw new MarketingStoreRefusedError(
      "cap_change_is_noop",
      "At least one cap must change",
    );
  }
  const updated = await database.marketingChannel.updateMany({
    where: {
      id: input.id,
      dailyCapOverride: row.dailyCapOverride,
      weeklyCapOverride: row.weeklyCapOverride,
    },
    data: {
      dailyCapOverride: input.dailyCapOverride,
      weeklyCapOverride: input.weeklyCapOverride,
    },
  });
  requireOne(updated.count, "cap_change_conflict", "The caps changed before this update");
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
  /**
   * The Guard's decision, as the object it returned.
   *
   * Not the verdict as a string, and not the codes and the mode beside it. A
   * caller used to be able to write `guardDecision: "autonomous_eligible"` and
   * `mode: "autonomous"` into the single-writer API without a Guard having run
   * at all -- which made every seal above it decoration. The verdict, the
   * codes, the rule ids, the status and the mode are all derived from this,
   * and it has to be an object `guardDraft()` sealed.
   */
  decision: GuardDecision;
  draftedAt: Date;
};

/**
 * The digest of an envelope, computed here so nobody can state it.
 *
 * `envelopeDigest` used to be a caller's 64 hex characters, and the same
 * envelope with the same sealed decision went to the database under any value
 * the caller liked. The template loader compares that column against
 * `approvedDigest` to decide whether the words are still the approved ones, so
 * a digest that says nothing about the content is the check answering a
 * question it was never asked.
 *
 * Keys sorted, so two objects that say the same thing hash the same.
 */
const canonicalJson = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonicalJson(inner)]),
    );
  }
  return value;
};

export function marketingEnvelopeDigest(envelope: MarketingEnvelope): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalJson(envelope)), "utf8")
    .digest("hex");
}

/**
 * What every marketing post has to satisfy before it is written, whoever is
 * writing it.
 *
 * This was the first half of `createMarketingPost` while there was one
 * writer. S2b2 adds a second -- the autonomous scheduled insert -- and the two
 * differ in exactly two places: one refuses a sealed `autonomous_eligible`
 * decision and a scheduled envelope, the other requires both. Everything
 * before that is the same question and is asked once, here, because the same
 * checks written twice are two places to get them right and one place to get
 * them wrong quietly.
 *
 * It reads the channel, so it takes a database. It writes nothing.
 */
async function admitMarketingPostInput(
  database: MarketingDatabase,
  rawInput: CreateMarketingPostInput,
) {
  // **Read once, into plain values.** Every field below is a property, and a
  // property can be an accessor: one that returned a sealed decision to the
  // check and a forged one to the write passed both, and one that returned
  // `chn_safe` to the digest and `chn_other` to the insert wrote a post for an
  // account the Guard never saw. The snapshot is what is checked and what is
  // written, and there is nothing in between for a second read to happen in.
  const decision = rawInput.decision;
  const input: CreateMarketingPostInput = {
    channelId: String(rawInput.channelId),
    locale: rawInput.locale,
    kind: rawInput.kind,
    logicalKey: String(rawInput.logicalKey),
    envelope: rawInput.envelope,
    envelopeDigest: String(rawInput.envelopeDigest),
    rendererVersion: String(rawInput.rendererVersion),
    templateId: rawInput.templateId === null ? null : String(rawInput.templateId),
    templateDigest:
      rawInput.templateDigest === null ? null : String(rawInput.templateDigest),
    claimIds: [...rawInput.claimIds].map(String),
    assetIds: [...rawInput.assetIds].map(String),
    claimRegistryVersion: Number(rawInput.claimRegistryVersion),
    assetRegistryVersion: Number(rawInput.assetRegistryVersion),
    // Parsed here rather than after the first `await`. The reference used to
    // be kept and parsed later, and a caller that mutated the object while the
    // channel lookup was in flight changed what was stored.
    factSnapshot: marketingFactSnapshotSchema.parse(
      rawInput.factSnapshot,
    ) as MarketingFactSnapshot,
    decision,
    draftedAt: new Date(rawInput.draftedAt.getTime()),
  };

  if (!marketingGuardDecisionIsSealed(decision)) {
    throw new MarketingStoreRefusedError(
      "guard_decision_not_sealed",
      "A post records a decision `guardDraft()` made, not one the caller assembled",
    );
  }

  // Read once. Every use below is of this snapshot rather than of the object,
  // so a decision whose fields answer differently on the second read cannot
  // pass the checks with one answer and be written with another. The freeze in
  // `sealDecision()` is what stops the accessor being installed at all; this
  // is the second lock on the same door.
  const verdict = decision.verdict;
  const guardCodes = "codes" in decision ? [...decision.codes] : [];
  const guardRuleIds = [...decision.ruleIds];
  const draftDigest = decision.draftDigest;
  const factsDigest = decision.factsDigest;

  // **The decision has to be about this post.** Provenance says a Guard made
  // it; it does not say what about. The Guard was shown "Three answers side by
  // side." and the row written said "The best AI, guaranteed.", with the first
  // decision attached to the second body.
  const envelopeForDigest = marketingEnvelopeSchema.parse(input.envelope);

  // **The envelope and the columns say the same thing, or neither is stored.**
  // The digest was computed from the columns, and the envelope is what a
  // publisher renders. With the two free to disagree, a post whose columns
  // said `en` with no claims went to the database carrying an envelope in `ko`
  // naming a claim and an asset nothing had checked.
  const envelopeAssetIds = envelopeForDigest.assets.map((asset) => asset.assetId);
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
  if (
    envelopeForDigest.locale !== input.locale ||
    !sameSet([...envelopeForDigest.claimIds], [...input.claimIds]) ||
    !sameSet(envelopeAssetIds, [...input.assetIds])
  ) {
    throw new MarketingStoreRefusedError(
      "envelope_disagrees_with_columns",
      "The envelope and the columns name different locales, claims or assets",
    );
  }

  // **And about these facts.** The draft digest says the words match; this
  // says the claims, the assets, the registry versions and the fact snapshot
  // are the ones the Guard was resolved against. A decision made with one
  // registry could otherwise be recorded on a post claiming another.
  const storedFactsScopeDigest = marketingFactsScopeDigest({
    channelId: input.channelId,
    channel: envelopeForDigest.channel,
    locale: input.locale,
    claimIds: input.claimIds,
    assetIds: input.assetIds,
    claimRegistryVersion: input.claimRegistryVersion,
    assetRegistryVersion: input.assetRegistryVersion,
    factSnapshotDigest: createHash("sha256")
      .update(JSON.stringify(canonicalJson(input.factSnapshot)), "utf8")
      .digest("hex"),
  });
  if (storedFactsScopeDigest !== decision.factsScopeDigest) {
    throw new MarketingStoreRefusedError(
      "guard_decision_not_about_these_facts",
      "That decision was resolved against different facts",
    );
  }

  const recomputed = marketingGuardDraftDigest({
    renderedText: envelopeForDigest.renderedText,
    locale: input.locale,
    channel: envelopeForDigest.channel,
    channelId: input.channelId,
    claimIds: input.claimIds,
    assetIds: input.assetIds,
    templateId: input.templateId ?? undefined,
  });
  if (recomputed !== draftDigest) {
    throw new MarketingStoreRefusedError(
      "guard_decision_not_about_this_post",
      "That decision was made about a different draft",
    );
  }

  // The digest is of these bytes, not of whatever the caller said.
  const computedDigest = marketingEnvelopeDigest(envelopeForDigest);
  if (input.envelopeDigest !== computedDigest) {
    throw new MarketingStoreRefusedError(
      "envelope_digest_not_of_this_envelope",
      "The envelope digest is computed from the envelope, not supplied",
    );
  }

  // The account the envelope names has to be the account being written to.
  // `accountSlug` is what a publisher posts from, and the Guard checked the
  // channel this row belongs to.
  const account = await database.marketingChannel.findUnique({
    where: { id: input.channelId },
    select: { accountSlug: true, channel: true },
  });
  if (
    !account ||
    account.accountSlug !== envelopeForDigest.accountSlug ||
    account.channel !== envelopeForDigest.channel
  ) {
    throw new MarketingStoreRefusedError(
      "envelope_account_not_this_channel",
      "The envelope names an account other than the one this post belongs to",
    );
  }

  return {
    input,
    envelope: envelopeForDigest,
    verdict,
    guardCodes,
    guardRuleIds,
    factsDigest,
    account,
  };
}

export async function createMarketingPost(
  database: MarketingDatabase,
  rawInput: CreateMarketingPostInput,
) {
  const { input, envelope: envelopeForDigest, verdict, guardCodes, guardRuleIds, factsDigest } =
    await admitMarketingPostInput(database, rawInput);

  // A draft is not scheduled. The envelope carries a `scheduledAt` and the row
  // has a column for one, and a create that set the first and not the second
  // left two answers to the same question.
  if (envelopeForDigest.scheduledAt !== null) {
    throw new MarketingStoreRefusedError(
      "envelope_scheduled_at_create",
      "A post is scheduled by an append, not by the envelope it is created with",
    );
  }

  // **S1 writes no autonomous post.** The decision's binding says what the
  // template row has to still look like at the moment of the write, and making
  // that true means reading the database's own clock and the row in the same
  // transaction as the insert -- which is the publish path, and the publish
  // path is S2. Until it exists, the honest answer is that this function
  // cannot write the row, rather than writing it without the check.
  if (verdict === "autonomous_eligible") {
    throw new MarketingStoreRefusedError(
      "autonomous_creation_not_available",
      "Creating an autonomous post needs the transactional template check, which is S2",
    );
  }

  const envelope = envelopeForDigest;
  const factSnapshot = input.factSnapshot;

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
      factsDigest,
      // Derived, every one of them. Two columns that could disagree with the
      // decision are two columns somebody can set to whatever they need.
      guardDecision: verdict,
      guardCodes,
      guardRuleIds,
      status: verdict === "reject" ? "guard_rejected" : "drafted",
      mode: "approval",
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
  /**
   * The mode, which this path may only ever lower.
   *
   * `autonomous` is not settable here. It was: a post created in `approval`
   * mode could be moved to `autonomous` by an ordinary append, which satisfied
   * the table's own CHECK and the channel trigger, and nothing in between had
   * read a Guard decision. Turning a post autonomous is the publish path's
   * business, and the publish path does it inside the transaction that checks
   * the template row.
   */
  mode?: Exclude<MarketingPostMode, "autonomous">;
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

type MaterialisedPostPatch = {
  data: Prisma.MarketingPostUpdateManyMutationInput;
  envelope?: MarketingEnvelope;
  hasScheduledAt: boolean;
  scheduledAt: string | null;
};

const postPatchData = (
  rawPatch: MarketingPostPatch,
): MaterialisedPostPatch => {
  // Read once, for the reason `createMarketingPost()` does it: a `mode`
  // accessor that answered `approval` to the refusal and `autonomous` to the
  // assignment put an autonomous row in the database through a path that had
  // just refused one. A shallow copy is enough -- every value here is a
  // primitive, a `Date` or `null`.
  const patch: MarketingPostPatch = { ...rawPatch };
  const data: Prisma.MarketingPostUpdateManyMutationInput = {};
  let parsedEnvelope: MarketingEnvelope | undefined;
  const copyDate = (value: Date | null): Date | null =>
    value === null ? null : new Date(value.getTime());
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.mode !== undefined) {
    // The type says `autonomous` is not one of the values; this says it at run
    // time too, because a caller reaching this through `as never` is exactly
    // the caller the rule is for.
    if ((patch.mode as string) === "autonomous") {
      throw new MarketingStoreRefusedError(
        "autonomous_mode_not_settable_here",
        "Turning a post autonomous belongs to the publish path, inside the transaction that checks the template",
      );
    }
    data.mode = patch.mode;
  }
  if (patch.envelope !== undefined) {
    // The digest of an envelope is of that envelope, here as on the create
    // path. A patch that changed the words and carried the old digest left the
    // column saying the approved post was still the approved post, which is
    // the question `lib/marketingTemplates.ts` asks it.
    const envelope = marketingEnvelopeSchema.parse(patch.envelope);
    parsedEnvelope = envelope;
    const digest = marketingEnvelopeDigest(envelope);
    if (patch.envelopeDigest !== undefined && patch.envelopeDigest !== digest) {
      throw new MarketingStoreRefusedError(
        "envelope_digest_not_of_this_envelope",
        "The envelope digest is computed from the envelope, not supplied",
      );
    }
    data.envelope = asJson(envelope);
    data.envelopeDigest = digest;
  } else if (patch.envelopeDigest !== undefined) {
    // A digest without the envelope it is of is a claim about bytes nobody
    // supplied. The approval path re-renders and patches both together.
    throw new MarketingStoreRefusedError(
      "envelope_digest_without_envelope",
      "An envelope digest is set by the change that sets the envelope",
    );
  }
  if (patch.approvalAuditLogId !== undefined) {
    data.approvalAuditLogId = patch.approvalAuditLogId;
  }
  if (patch.approvedAt !== undefined) data.approvedAt = copyDate(patch.approvedAt);
  if (patch.approvedDigest !== undefined) data.approvedDigest = patch.approvedDigest;
  if (patch.approvalExpiresAt !== undefined) {
    data.approvalExpiresAt = copyDate(patch.approvalExpiresAt);
  }
  if (patch.reusableAsTemplate !== undefined) {
    data.reusableAsTemplate = patch.reusableAsTemplate;
  }
  if (patch.scheduledAt !== undefined) data.scheduledAt = copyDate(patch.scheduledAt);
  if (patch.slotDate !== undefined) data.slotDate = copyDate(patch.slotDate);
  if (patch.claimToken !== undefined) data.claimToken = patch.claimToken;
  if (patch.leaseUntil !== undefined) data.leaseUntil = copyDate(patch.leaseUntil);
  if (patch.publishAttempt !== undefined) data.publishAttempt = patch.publishAttempt;
  if (patch.providerRequestKey !== undefined) {
    data.providerRequestKey = patch.providerRequestKey;
  }
  if (patch.externalPostId !== undefined) data.externalPostId = patch.externalPostId;
  if (patch.externalUrl !== undefined) data.externalUrl = patch.externalUrl;
  if (patch.publishedAt !== undefined) data.publishedAt = copyDate(patch.publishedAt);
  if (patch.verifiedPublicAt !== undefined) {
    data.verifiedPublicAt = copyDate(patch.verifiedPublicAt);
  }
  if (patch.verificationMethod !== undefined) {
    data.verificationMethod = patch.verificationMethod;
  }
  if (patch.errorCode !== undefined) data.errorCode = patch.errorCode;
  if (patch.outcomeUnknownAt !== undefined) {
    data.outcomeUnknownAt = copyDate(patch.outcomeUnknownAt);
  }
  if (patch.deletedAt !== undefined) data.deletedAt = copyDate(patch.deletedAt);
  if (patch.deletionMethod !== undefined) data.deletionMethod = patch.deletionMethod;
  if (patch.legalHold !== undefined) data.legalHold = patch.legalHold;
  return {
    data,
    ...(parsedEnvelope === undefined ? {} : { envelope: parsedEnvelope }),
    hasScheduledAt: patch.scheduledAt !== undefined,
    scheduledAt:
      patch.scheduledAt === undefined || patch.scheduledAt === null
        ? null
        : patch.scheduledAt.toISOString(),
  };
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

/**
 * The only writer that may insert a post already scheduled, already
 * autonomous, with nobody having looked at it.
 *
 * Authority: S1 plan r7 amendment 2 and the S2 plan's "Autonomous insert:
 * complete shape", both approved 2026-09-23. The insert trigger carries the
 * half of the contract that is a property of the row; this carries the half
 * that needs other rows, and the two halves are checked in the same
 * transaction as the write so neither can be true at a different moment than
 * the other.
 *
 * What it does, in the order it matters:
 *
 * 1. Locks the channel. It is the per-channel mutex the caps rest on, and it
 *    is what stops the account changing mode underneath the decision.
 * 2. Reads the database's clock. The binding's window is judged against that
 *    clock and no other -- a caller's clock is one nobody agreed on.
 * 3. Holds the template row with `FOR SHARE` and writes against every
 *    condition `marketingTemplateWriteConditions()` returns. Autonomy is only
 *    ever inside an approved template, so a template that has been edited,
 *    purged, un-marked or moved on a version is not one this may reuse.
 * 4. Resolves admission *here*, by calling the resolver this function was
 *    handed, inside this transaction. Taking a resolved answer as an argument
 *    would let it be resolved anywhere, at any time, against anything.
 * 5. Inserts, and writes the system audit row in the same transaction.
 *
 * The audit metadata is what dispatch compares against later: the code digest,
 * the configuration generation and the deployment id. A post admitted by one
 * build is not dispatched by another without being admitted again.
 */
export async function insertAutonomousScheduledMarketingPost(
  database: MarketingTransaction,
  rawInput: CreateMarketingPostInput & {
    /** The sealed proof that this template was a template, and when. */
    readonly binding: MarketingTemplateBinding;
    /**
     * Resolved inside this transaction, by this function, rather than handed
     * in already answered.
     */
    /**
     * Resolved inside this transaction, against the row this function locked.
     *
     * The locked channel is handed over rather than looked up again, and
     * rather than taken from whatever the caller believed: this transaction
     * holds that row `FOR UPDATE`, so it is the only description of the
     * account that cannot change under the answer. A resolver reading the
     * caller's copy would be judging a mode that was true when the caller
     * assembled its arguments.
     */
    readonly resolveAdmission: (
      database: MarketingTransaction,
      channel: MarketingAdmissionChannel,
    ) => Promise<MarketingAutonomousAdmission>;
    /**
     * The facts the decision was sealed over.
     *
     * Not taken on trust: both digests are recomputed below, and the sealed
     * decision carries them, so a facts object that is not the one the Guard
     * read fails before it is used. It is needed because the decision records
     * only the digests, and `usedBefore` -- the one answer in there that another
     * transaction can invalidate -- has to be re-asked at write time.
     */
    readonly facts: MarketingGuardFacts;
    readonly admissionCodeDigest: string;
    readonly configGeneration: number;
    readonly deploymentId: string;
    readonly commitSha: string;
  },
) {
  const binding = rawInput.binding;
  const resolveAdmission = rawInput.resolveAdmission;
  // Copied field by field, here, for the reason everything else in this module
  // is: a property can be an accessor. `marketingFactsDigest()` reads
  // `claims` and the prior-use check below reads it again, and an object whose
  // getter answered one list to the digest and another to the check would have
  // its digest verified against facts that were never used. There is one list
  // from here on and the argument is not read again.
  const facts: MarketingGuardFacts = {
    channelId: String(rawInput.facts.channelId),
    channel: String(rawInput.facts.channel),
    locale: String(rawInput.facts.locale),
    claims: [...rawInput.facts.claims].map((claim) => ({ ...claim })),
    assets: [...rawInput.facts.assets].map((asset) => ({ ...asset })),
    claimRegistryVersion: Number(rawInput.facts.claimRegistryVersion),
    assetRegistryVersion: Number(rawInput.facts.assetRegistryVersion),
    factSnapshotDigest:
      rawInput.facts.factSnapshotDigest === null
        ? null
        : String(rawInput.facts.factSnapshotDigest),
  };
  const provenance = {
    admissionCodeDigest: String(rawInput.admissionCodeDigest),
    configGeneration: Number(rawInput.configGeneration),
    deploymentId: String(rawInput.deploymentId),
    commitSha: String(rawInput.commitSha),
  };

  // **The audit chain lock, before any row lock.** `lib/adminAudit.ts` takes
  // this lock inside every append, and `lib/marketingAdminMutations.ts` takes
  // it first in its transaction and says so: every other audit write in the
  // process queues behind it. This function writes its audit entry last,
  // because it needs the id of the row it creates -- so without this line it
  // would take the channel's row lock first and the chain lock last, the exact
  // reverse of the admin path, and two of them running at once would deadlock.
  // Taking it here costs an ordering, not a second lock: it is the same
  // transaction-scoped advisory lock the append will ask for again.
  await takeAuditChainLock(database);

  const { input, envelope, guardRuleIds, factsDigest, verdict, guardCodes } =
    await admitMarketingPostInput(database, rawInput);

  // The opposite of the draft path in both directions: this one requires the
  // verdict a person never saw, and requires the slot the draft path refuses.
  if (verdict !== "autonomous_eligible") {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_not_eligible",
      "Only an autonomous-eligible decision may be inserted already scheduled",
    );
  }
  if (guardCodes.length > 0) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_has_codes",
      "An autonomous-eligible decision carries no codes",
    );
  }
  if (envelope.scheduledAt === null) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_not_scheduled",
      "An autonomous post is inserted with the slot its envelope names",
    );
  }
  if (input.templateId === null || input.templateDigest === null) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_without_template",
      "Autonomy is only ever inside an approved template",
    );
  }
  if (input.templateId !== binding.templateId) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_template_mismatch",
      "The binding proves a different template than the post names",
    );
  }
  if (input.templateDigest !== binding.approvedDigest) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_template_digest_mismatch",
      "The binding proves a different approved digest than the post names",
    );
  }

  // The per-channel mutex, and the thing that stops the account changing mode
  // under the decision.
  const channel = await lockMarketingChannel(database, input.channelId);
  if (channel.status !== "autonomous_mode") {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_channel_not_autonomous",
      "Only an account in autonomous mode may be written to without a person",
    );
  }
  if (
    (MARKETING_NO_AUTONOMY_CHANNELS as readonly string[]).includes(channel.channel)
  ) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_channel_has_no_autonomy",
      "This channel is posted by hand and has no autonomous path",
    );
  }

  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }

  // The slot is in the future at the database's clock. A post inserted for an
  // instant that has already passed is due the moment it exists, which is a
  // way of publishing now while appearing to schedule.
  const slot = new Date(envelope.scheduledAt);
  if (!Number.isFinite(slot.getTime())) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_slot_unreadable",
      "The envelope's scheduled instant is not a time",
    );
  }
  if (slot.getTime() <= now.getTime()) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_slot_not_future",
      "An autonomous post is scheduled for a time that has not happened yet",
    );
  }

  // The binding's window is judged against that clock and no other.
  const conditions = marketingTemplateWriteConditions(binding, now);
  if (!conditions.ok) {
    // Two throws, each with its code where the reader and the check both
    // look for it: immediately after the constructor. Assembling the code
    // from a fragment made it ungreppable, and putting it behind a ternary
    // made it invisible to the sweep that gives every refusal an HTTP
    // meaning -- both of which read, from outside, as a status for a
    // refusal nothing raises.
    if (conditions.refusal === "binding_expired") {
      throw new MarketingStoreRefusedError(
        "autonomous_insert_binding_expired",
        "The template binding proof has aged out at the database clock",
      );
    }
    throw new MarketingStoreRefusedError(
      "autonomous_insert_binding_not_sealed",
      "The template binding is not a write condition at the database's clock",
    );
  }

  // Held, not looked at. `FOR SHARE` keeps the template as the binding proved
  // it until this transaction ends, so an edit or a purge in flight loses the
  // race rather than winning it silently.
  const held = await database.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "MarketingPost" WHERE "id" = ${binding.templateId} FOR SHARE
  `);
  if (held.length !== 1) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_template_gone",
      "The template this post reuses no longer exists",
    );
  }
  const template = await database.marketingPost.findFirst({
    where: conditions.where,
    select: { id: true },
  });
  if (!template) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_template_changed",
      "The template no longer matches the binding that proved it",
    );
  }

  // **The facts are the ones the decision was sealed over.** The decision
  // records two digests and nothing else, so this is where a facts object
  // stops being an argument and starts being the thing the Guard read.
  // One comparison, not two. `marketingFactsDigest()` covers the account, the
  // channel, the locale, every claim and asset answer, both registry versions
  // and the snapshot digest -- so a facts object that passes it is the one the
  // decision was sealed over, and the scope digest is already checked against
  // the post's own columns in `admitMarketingPostInput()`. A second check over
  // a subset of the same bytes would look like a further guarantee and be none.
  if (marketingFactsDigest(facts) !== factsDigest) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_facts_mismatch",
      "These are not the facts the decision was made from",
    );
  }

  // **The one answer in the facts another transaction can turn false.**
  //
  // Which way round matters, and it is the opposite of the obvious one. An
  // autonomous decision has `usedBefore: true` for every claim and asset it
  // names -- `guardDraft()` raises `first_use_of_claim` otherwise and the
  // verdict stops being autonomous -- so a *new* prior use cannot hurt this
  // post. What can is prior use going away: a concurrent unpublish, delete or
  // retention purge of the last row that carried the claim leaves nothing
  // saying this account ever published it, and the autonomy rested on that
  // exact sentence.
  //
  // Refusing then is not conservatism. The Guard re-run on the same facts
  // would say `first_use_of_claim`, and first use of a claim is a thing the
  // policy sends to a person.
  //
  // Two queries rather than one with the column interpolated: a runtime
  // column name is a thing `check:protected-table-writers` refuses on sight,
  // and it is right to -- it cannot tell a literal chosen here from a string
  // that arrived. Both ask "which of these", not "is any of these": any is not
  // what the decision rested on.
  //
  // Asking it here, rather than trusting what the decision recorded, is the
  // whole check: the answer is taken from what the database says now.
  //
  // It is also the read that the isolation level needs in order to have
  // anything to say, since SSI detects a dependency only against a read a
  // transaction actually performed -- but that is a smaller claim than it
  // sounds, and `runMarketingTransaction`'s `isolationLevel` spells out how
  // small. A concurrent unpublish does not have to become a serialization
  // failure: this transaction committing first is a legal order and the post
  // is then right as of that point. What the isolation level buys is that this
  // read and the three before it are one instant.
  const reliedOnClaimIds = facts.claims
    .filter((claim) => claim.usedBefore === true)
    .map((claim) => claim.claimId);
  const reliedOnAssetIds = facts.assets
    .filter((asset) => asset.usedBefore === true)
    .map((asset) => asset.assetId);

  const publishedClaims =
    reliedOnClaimIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await database.$queryRaw<Array<{ value: string }>>(Prisma.sql`
              SELECT DISTINCT used."value" AS "value"
              FROM "MarketingPost" AS post,
                   unnest(post."claimIds") AS used("value")
              WHERE post."channelId" = ${input.channelId}
                AND post."status" IN (${Prisma.join([
                  ...MARKETING_PRIOR_USE_STATUSES,
                ])})
                AND used."value" IN (${Prisma.join([...reliedOnClaimIds])})
            `)
          ).map((row) => row.value),
        );
  const missingClaim = reliedOnClaimIds.find((id) => !publishedClaims.has(id));
  if (missingClaim !== undefined) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_claim_no_longer_used",
      "A claim this decision relied on having been published no longer has been",
    );
  }

  const publishedAssets =
    reliedOnAssetIds.length === 0
      ? new Set<string>()
      : new Set(
          (
            await database.$queryRaw<Array<{ value: string }>>(Prisma.sql`
              SELECT DISTINCT used."value" AS "value"
              FROM "MarketingPost" AS post,
                   unnest(post."assetIds") AS used("value")
              WHERE post."channelId" = ${input.channelId}
                AND post."status" IN (${Prisma.join([
                  ...MARKETING_PRIOR_USE_STATUSES,
                ])})
                AND used."value" IN (${Prisma.join([...reliedOnAssetIds])})
            `)
          ).map((row) => row.value),
        );
  const missingAsset = reliedOnAssetIds.find((id) => !publishedAssets.has(id));
  if (missingAsset !== undefined) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_asset_no_longer_used",
      "An asset this decision relied on having been published no longer has been",
    );
  }

  // Resolved here, inside this transaction, by this function.
  const admission = await resolveAdmission(database, {
    id: channel.id,
    channel: channel.channel as MarketingChannelName,
    status: channel.status as MarketingChannelStatus,
    connectionGeneration: Number(channel.connectionGeneration),
  });

  // **The decision was made under one build, one configuration and one
  // deployment; the write happens under whatever is running now.** The caller
  // carries what it saw when the decision was sealed, the resolver reports what
  // it just read, and a difference means the decision is about a world that has
  // moved. Checked before the admission answer itself: an answer produced under
  // a configuration the decision never saw is not the answer the decision was
  // given, whichever way it came out.
  if (admission.admissionCodeDigest !== provenance.admissionCodeDigest) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_code_digest_changed",
      "The admission code is not the build this decision was made under",
    );
  }
  if (admission.configGeneration !== provenance.configGeneration) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_config_generation_changed",
      "A setting that affects admission changed after this decision was made",
    );
  }
  // Refused before the comparison, because an empty deployment id compares
  // equal to an empty deployment id: with the variable unset on both sides the
  // fence passes every time and the audit records a fence that was never one.
  // "We do not know which deployment this is" is not a match.
  if (provenance.deploymentId === "" || admission.deploymentId === "") {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_deployment_unknown",
      "There is no deployment identity to fence this decision to",
    );
  }
  if (admission.deploymentId !== provenance.deploymentId) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_deployment_changed",
      "This decision was made on a deployment that is no longer the one running",
    );
  }

  if (!admission.autonomousPublish) {
    throw new MarketingStoreRefusedError(
      "autonomous_insert_not_admitted",
      "Autonomous publishing is not admitted right now",
    );
  }

  const draftEntry = marketingHistoryEntrySchema.parse({
    at: input.draftedAt.toISOString(),
    type: "draft",
    envelopeDigest: input.envelopeDigest,
  });

  const created = await database.marketingPost.create({
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
      factSnapshot: asJson(input.factSnapshot),
      factsDigest,
      // Derived from the decision, never from the caller.
      guardDecision: "autonomous_eligible",
      guardCodes: [],
      guardRuleIds: [...guardRuleIds],
      status: "scheduled",
      mode: "autonomous",
      scheduledAt: slot,
      history: asJson([draftEntry]),
    },
    select: { id: true },
  });

  await writeSystemAuditLog({
    tx: database,
    systemActor: "marketing-guard",
    action: MARKETING_S2B2_ACTIONS.postAutonomousScheduled,
    targetType: "MarketingPost",
    targetId: created.id,
    summary: "Scheduled a marketing post without a person, inside an approved template.",
    metadata: {
      channelId: input.channelId,
      factsDigest,
      factsScopeDigest: rawInput.decision.factsScopeDigest,
      templateId: binding.templateId,
      templateDigest: binding.approvedDigest,
      // What dispatch compares against. A post admitted by one build of the
      // admission code, one configuration generation or one deployment is not
      // dispatched by another without being admitted again. The commit is
      // provenance: Git identity alone does not prove what bytes ran.
      admissionCodeDigest: provenance.admissionCodeDigest,
      configGeneration: provenance.configGeneration,
      deploymentId: provenance.deploymentId,
      commitSha: provenance.commitSha,
      scheduledAt: slot.toISOString(),
    },
  });

  return { id: created.id };
}

/**
 * Refuse a transaction that is not at the isolation this work needs.
 *
 * Asked of the database rather than assumed of the caller. The level is set
 * where the transaction is opened, which is a different file from the one that
 * depends on it, and a caller that forgets gets a claim that looks like it
 * worked.
 */
async function requireSerializableTransaction(
  database: MarketingTransaction,
  what: string,
): Promise<void> {
  const rows = await database.$queryRaw<Array<{ level: string }>>(Prisma.sql`
    SELECT current_setting('transaction_isolation') AS "level"
  `);
  const level = rows[0]?.level ?? "";
  if (level.toLowerCase() !== "serializable") {
    throw new MarketingStoreRefusedError(
      "transaction_not_serializable",
      `A marketing ${what} runs at SERIALIZABLE, not ${level || "an unknown level"}`,
    );
  }
}

/**
 * One post this account is due to publish, locked, or nothing.
 *
 * `SKIP LOCKED` is what makes several workers useful rather than a queue with
 * extra steps: a row another worker is already holding is not waited for, it is
 * passed over. `FOR UPDATE OF p` locks the post and not the channel joined to
 * it, because the channel is locked separately and deliberately -- see
 * `claimDueMarketingPost`.
 *
 * Due means the slot has arrived at the database's clock and nobody is
 * currently holding it: either no claim, or a claim whose lease has run out.
 * An expired lease is a claim whose worker is gone, and reclaiming it is the
 * only way a post whose process died ever goes out.
 */
async function lockDueMarketingPost(
  database: MarketingTransaction,
  channelId: string,
  now: Date,
): Promise<{ id: string; historyVersion: number } | null> {
  const rows = await database.$queryRaw<
    Array<{ id: string; historyVersion: number }>
  >(Prisma.sql`
    SELECT p."id", p."historyVersion"
    FROM "MarketingPost" AS p
    WHERE p."channelId" = ${channelId}
      AND p."status" = 'scheduled'
      AND p."scheduledAt" IS NOT NULL
      AND p."scheduledAt" <= ${now}
      AND p."deletedAt" IS NULL
      AND p."contentPurgedAt" IS NULL
      AND (p."claimToken" IS NULL OR p."leaseUntil" IS NULL OR p."leaseUntil" <= ${now})
    ORDER BY p."scheduledAt" ASC, p."id" ASC
    LIMIT 1
    FOR UPDATE OF p SKIP LOCKED
  `);
  return rows[0] ?? null;
}

/**
 * Take the next due post's slot for this worker.
 *
 * **A claim is not a dispatch.** The row stays `scheduled`, its history and
 * history version do not move, and `publishAttempt` and `providerRequestKey`
 * are untouched -- those three are what say a request left for the platform,
 * and nothing has. What this writes is `slotDate`, `claimToken` and
 * `leaseUntil`: which day the post is spending, who is spending it, and until
 * when that is true.
 *
 * The order of locks is the channel first, then the post. The channel is the
 * per-channel mutex the plan names: the day and week counts are read while it
 * is held, so two workers cannot each count four of a five-a-week cap and both
 * take the fifth. The post lock comes second and skips what is already held,
 * so workers on different posts of the same account still serialise on the
 * channel -- which is correct, because the thing they are competing for is the
 * account's allowance, not the row.
 */
export async function claimDueMarketingPost(
  database: MarketingTransaction,
  rawInput: {
    readonly channelId: string;
    readonly claimToken: string;
    /** Resolved inside this transaction, as the autonomous insert's is. */
    readonly resolveAdmission: (
      database: MarketingTransaction,
      channel: MarketingAdmissionChannel,
    ) => Promise<{ readonly publish: boolean }>;
    readonly leaseMs?: number;
  },
): Promise<
  | { readonly claimed: true; readonly id: string; readonly leaseUntil: Date }
  | { readonly claimed: false; readonly reason: MarketingClaimRefusal }
> {
  const channelId = String(rawInput.channelId);
  const claimToken = String(rawInput.claimToken);
  const resolveAdmission = rawInput.resolveAdmission;
  const leaseMs =
    rawInput.leaseMs === undefined
      ? MARKETING_CLAIM_LEASE_MS
      : Number(rawInput.leaseMs);
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) {
    throw new MarketingStoreRefusedError(
      "claim_lease_not_positive",
      "A lease that has already expired is not a lease",
    );
  }
  if (claimToken.length === 0) {
    throw new MarketingStoreRefusedError(
      "claim_token_empty",
      "A claim is held by a token, and an empty one identifies nobody",
    );
  }

  // The audit chain lock before any row lock, for the reason the autonomous
  // insert takes it: this function's audit entry names the row it claims, so
  // it is written last, and taking the two locks in the other order from the
  // admin paths is how two of them deadlock.
  // The plan puts this whole transaction at `SERIALIZABLE`, and the caller is
  // what sets it -- `runMarketingTransaction` takes the level, this function
  // takes a transaction. So this asks. A claim that counted an account's
  // allowance under read committed would be counting rows as of whenever each
  // statement ran, and the channel lock alone does not fix that: it serialises
  // the two workers, and the second one still reads its counts from a snapshot
  // taken before the first committed.
  await requireSerializableTransaction(database, "claim");

  await takeAuditChainLock(database);

  const channel = await lockMarketingChannel(database, channelId);
  if (channel.status !== "autonomous_mode" && channel.status !== "approval_mode") {
    return { claimed: false, reason: "channel_not_publishing" };
  }

  const clock = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = clock[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }

  const admission = await resolveAdmission(database, {
    id: channel.id,
    channel: channel.channel as MarketingChannelName,
    status: channel.status as MarketingChannelStatus,
    connectionGeneration: Number(channel.connectionGeneration),
  });
  if (!admission.publish) {
    return { claimed: false, reason: "not_admitted" };
  }

  const due = await lockDueMarketingPost(database, channelId, now);
  if (!due) return { claimed: false, reason: "nothing_due" };

  const caps = marketingChannelCaps({
    channel: channel.channel,
    dailyCapOverride: channel.dailyCapOverride,
    weeklyCapOverride: channel.weeklyCapOverride,
  });
  if (caps === null) {
    // A channel the policy gives no cap is one that is posted by hand. There
    // is no number to count against, so there is no slot to take.
    return { claimed: false, reason: "channel_posts_by_hand" };
  }

  // Counted while the channel is held, which is what makes the count worth
  // anything. The day is the database's, not the process's: a worker in
  // another time zone must not get a second Tuesday.
  // Counted while the channel is held, which is what makes the count worth
  // anything, and counted against the database's own UTC day.
  //
  // The day is computed in the statement rather than bound from JavaScript.
  // A `Date` sent as a parameter arrives as a `timestamptz`, and `::date` on a
  // `timestamptz` resolves in the *session's* time zone -- so a server whose
  // `TimeZone` is not UTC would count a different day from the one the claim
  // is about to write, and at 22:00 UTC the two would be different days. The
  // expression below is the same one the clock read above uses, so there is
  // one definition of "today" in this transaction.
  const used = await database.$queryRaw<Array<{ today: bigint; week: bigint }>>(
    Prisma.sql`
      SELECT
        count(*) FILTER (
          WHERE "slotDate" = (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date
        ) AS "today",
        count(*) FILTER (
          WHERE "slotDate" > (pg_catalog.clock_timestamp() AT TIME ZONE 'UTC')::date - 7
        ) AS "week"
      FROM "MarketingPost"
      WHERE "channelId" = ${channelId}
        AND "slotDate" IS NOT NULL
    `,
  );
  const today = Number(used[0]?.today ?? 0);
  const week = Number(used[0]?.week ?? 0);
  if (today >= caps.daily) return { claimed: false, reason: "daily_cap_reached" };
  if (week >= caps.weekly) return { claimed: false, reason: "weekly_cap_reached" };

  const leaseUntil = new Date(now.getTime() + leaseMs);
  // The same UTC calendar day the count just used. `now` is already the
  // database's clock read as UTC, so its UTC components are that day; taking
  // midnight of it keeps Prisma's `@db.Date` serialisation from moving it.
  const slotDate = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );

  // Conditional on everything the decision to claim was made against. The row
  // is held by `FOR UPDATE` so none of it can have moved, and the predicate is
  // here for the case where it somehow did: a claim written over another
  // worker's is two workers publishing one post.
  const claimed = await database.marketingPost.updateMany({
    where: {
      id: due.id,
      status: "scheduled",
      historyVersion: due.historyVersion,
      // Nobody holds it. Deliberately *not* also `slotDate: null`: a post that
      // failed and was requeued keeps the slot date of the day it spent --
      // that is what stops a bad afternoon spending a week's allowance -- and
      // requiring it to be null left such a row matching neither this
      // predicate nor the expired-lease one below, so it could never be
      // claimed again at all.
      claimToken: null,
      deletedAt: null,
      contentPurgedAt: null,
    },
    data: {
      slotDate,
      claimToken,
      leaseUntil,
    },
  });
  if (claimed.count !== 1) {
    // Either the row moved, or it was an expired claim rather than an unclaimed
    // one. The second is a real case and is taken separately, so the
    // difference between "nobody had it" and "somebody's lease ran out" is
    // visible in the predicate rather than folded into one.
    const reclaimed = await database.marketingPost.updateMany({
      where: {
        id: due.id,
        status: "scheduled",
        historyVersion: due.historyVersion,
        leaseUntil: { lte: now },
        deletedAt: null,
        contentPurgedAt: null,
      },
      data: {
        slotDate: now,
        claimToken,
        leaseUntil,
      },
    });
    if (reclaimed.count !== 1) {
      return { claimed: false, reason: "claim_conflict" };
    }
  }

  await writeSystemAuditLog({
    tx: database,
    systemActor: "marketing-publisher",
    action: MARKETING_S2C_ACTIONS.postClaimed,
    targetType: "MarketingPost",
    targetId: due.id,
    summary: "Took a publishing slot for a scheduled post.",
    metadata: {
      channelId,
      // The token is the claim's identity and the release has to present it,
      // so it is recorded. It identifies a worker's attempt, not a person.
      claimToken,
      leaseUntil: leaseUntil.toISOString(),
      slotDate: now.toISOString().slice(0, 10),
      dailyUsedBefore: today,
      weeklyUsedBefore: week,
      dailyCap: caps.daily,
      weeklyCap: caps.weekly,
    },
  });

  return { claimed: true, id: due.id, leaseUntil };
}

/**
 * Give a claimed slot back, before anything has left for the platform.
 *
 * The caller has to say which claim it is giving back. A release that matched
 * only on the post id would let a worker whose lease had already expired --
 * and whose slot another worker had since taken -- clear the new holder's
 * claim, which is worse than the stall it was trying to fix.
 *
 * `status`, `history` and `historyVersion` do not move here either. A
 * release is the exact undo of a claim and nothing else happened in between:
 * if something had, this is not the function to call.
 */
export async function releaseMarketingPostClaim(
  database: MarketingTransaction,
  rawInput: {
    readonly id: string;
    readonly claimToken: string;
    /**
     * The lease this caller believes it holds.
     *
     * The token alone is not enough. A worker can be told its token, finish a
     * long pause, and try to tidy up after a lease that expired while it was
     * gone -- by which time another worker may hold the same row under a new
     * lease. Binding the exact instant makes that release match nothing, which
     * is the right answer.
     */
    readonly expectedLeaseUntil: Date;
    readonly expectedHistoryVersion: number;
    readonly reason: MarketingClaimReleaseReason;
  },
): Promise<{ readonly released: boolean }> {
  const id = String(rawInput.id);
  const claimToken = String(rawInput.claimToken);
  const expectedHistoryVersion = Number(rawInput.expectedHistoryVersion);
  const expectedLeaseUntil = new Date(rawInput.expectedLeaseUntil.getTime());
  if (!Number.isFinite(expectedLeaseUntil.getTime())) {
    throw new MarketingStoreRefusedError(
      "claim_release_lease_unreadable",
      "A release names the lease it is giving back, and that is not a time",
    );
  }
  const reason = rawInput.reason;
  if (!(MARKETING_CLAIM_RELEASE_REASONS as readonly string[]).includes(reason)) {
    throw new MarketingStoreRefusedError(
      "claim_release_reason_unknown",
      "A release says why, from a closed list",
    );
  }

  await takeAuditChainLock(database);

  const released = await database.marketingPost.updateMany({
    where: {
      id,
      status: "scheduled",
      claimToken,
      leaseUntil: expectedLeaseUntil,
      historyVersion: expectedHistoryVersion,
      // Nothing has left. A row holding a request key is one that has been
      // dispatched, and a dispatched post is not released -- its outcome is
      // recorded.
      providerRequestKey: null,
    },
    data: {
      slotDate: null,
      claimToken: null,
      leaseUntil: null,
    },
  });
  if (released.count !== 1) return { released: false };

  await writeSystemAuditLog({
    tx: database,
    systemActor: "marketing-publisher",
    action: MARKETING_S2C_ACTIONS.postClaimReleased,
    targetType: "MarketingPost",
    targetId: id,
    summary: "Gave back a publishing slot without publishing.",
    metadata: {
      claimToken,
      reason,
      historyVersion: expectedHistoryVersion,
      leaseUntil: expectedLeaseUntil.toISOString(),
    },
  });

  return { released: true };
}

export async function appendMarketingPostHistory(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedVersion: number;
    entry: MarketingHistoryEntry;
    patch?: MarketingPostPatch;
    requeue?: MarketingRequeueEvidence;
  },
): Promise<{ appended: boolean }> {
  // Read once, for the reason the two functions above do it. A `patch` getter
  // that answered `status: "scheduled"` with a forged approval to the check
  // and `status: "drafted"` to the write walked past the audit verification
  // and stored the first answer. There is one object from here on and the
  // original is not read again.
  const rawPatch = rawInput.patch;
  const rawRequeue = rawInput.requeue;
  const input = {
    id: String(rawInput.id),
    expectedVersion: Number(rawInput.expectedVersion),
    entry: rawInput.entry,
    patch: rawPatch === undefined ? undefined : { ...rawPatch },
    requeue: rawRequeue === undefined ? undefined : { ...rawRequeue },
  };

  const entry = marketingHistoryEntrySchema.parse(input.entry);
  // Materialise the patch before the first await. `postPatchData()` parses the
  // envelope once and returns that same value for both the write and the final
  // schedule comparison; the original object is never parsed a second time.
  const materialisedPatch = postPatchData(input.patch ?? {});
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
    select: {
      history: true,
      historyVersion: true,
      status: true,
      envelopeDigest: true,
      envelope: true,
      scheduledAt: true,
    },
  });
  if (!current || current.historyVersion !== input.expectedVersion) {
    return { appended: false };
  }

  const history = marketingHistorySchema.parse(current.history);
  const data = materialisedPatch.data;

  // **The two places a schedule can live agree after this append, not just
  // inside it.** Comparing them only when both were patched let either one
  // move on its own: an envelope carrying a date went in while the column
  // stayed null, and the row then said two things about when the post goes
  // out. The values compared are the ones that will be there afterwards.
  const currentEnvelope = marketingEnvelopeSchema.safeParse(current.envelope);
  const finalEnvelopeSchedule =
    materialisedPatch.envelope !== undefined
      ? (materialisedPatch.envelope.scheduledAt ?? null)
      : currentEnvelope.success
        ? (currentEnvelope.data.scheduledAt ?? null)
        : null;
  const finalColumnSchedule =
    materialisedPatch.hasScheduledAt
      ? materialisedPatch.scheduledAt
      : (current.scheduledAt?.toISOString() ?? null);
  if (finalEnvelopeSchedule !== finalColumnSchedule) {
    throw new MarketingStoreRefusedError(
      "envelope_schedule_disagrees",
      "The envelope and the column would name different schedules",
    );
  }

  // docs/policy/marketing-automation.md §2: a confirmed failure is re-queued by
  // a person, and the decision is about this content and this failure. The
  // trigger sees that the approval is new and later than the failure; only here
  // can the entry be read to check that it approved these bytes.
  if (current.status === "failed" && input.patch?.status === "scheduled") {
    if (!input.requeue) {
      throw new MarketingStoreRefusedError(
        "requeue_evidence_missing",
        "Re-queueing a failed post needs the operator's audit entry",
      );
    }

    const digest = input.patch.envelopeDigest ?? current.envelopeDigest;
    const lastFailureAt = history
      .filter((item) => item.type === "attempt" && item.outcome === "failed")
      .map((item) => new Date(item.at).getTime())
      .reduce((latest, at) => Math.max(latest, at), Number.NEGATIVE_INFINITY);

    if (!Number.isFinite(lastFailureAt)) {
      throw new MarketingStoreRefusedError(
        "requeue_without_failure",
        "This post is failed and its history records no failed attempt",
      );
    }

    const verdict = await verifyMarketingAuditEvidence(database, {
      auditLogId: input.requeue.auditLogId,
      action: MARKETING_REQUEUE_ACTION,
      targetId: input.id,
      metadata: { digest },
      notBefore: new Date(lastFailureAt),
    });
    if (!verdict.ok) {
      throw new MarketingStoreRefusedError(
        `requeue_evidence_${verdict.problem}`,
        `The audit entry for this re-queue is not evidence of it: ${verdict.problem}`,
      );
    }
    data.approvalAuditLogId = input.requeue.auditLogId;
    data.approvedAt = verdict.createdAt;
    data.approvedDigest = digest;
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

type LockedMarketingPost = {
  id: string;
  channelId: string;
  channel: MarketingChannelName;
  accountSlug: string;
  locale: MarketingLocale;
  status: MarketingPostStatus;
  envelope: Prisma.JsonValue | null;
  envelopeDigest: string;
  approvedDigest: string | null;
  approvalAuditLogId: string | null;
  approvedAt: Date | null;
  approvalExpiresAt: Date | null;
  reusableAsTemplate: boolean;
  scheduledAt: Date | null;
  publishAttempt: number;
  externalPostId: string | null;
  publishedAt: Date | null;
  deletedAt: Date | null;
  contentPurgedAt: Date | null;
  legalHold: boolean;
  history: Prisma.JsonValue;
  historyVersion: number;
  claimIds: string[];
  assetIds: string[];
  claimRegistryVersion: number;
  assetRegistryVersion: number;
  factSnapshot: Prisma.JsonValue;
  factsDigest: string | null;
};

async function lockMarketingPost(
  database: MarketingDatabase,
  id: string,
): Promise<LockedMarketingPost> {
  const rows = await database.$queryRaw<LockedMarketingPost[]>(Prisma.sql`
    SELECT
      p."id", p."channelId", c."channel", c."accountSlug", p."locale",
      p."status", p."envelope", p."envelopeDigest", p."approvedDigest",
      p."approvalAuditLogId", p."approvedAt", p."approvalExpiresAt",
      p."reusableAsTemplate", p."scheduledAt", p."publishAttempt",
      p."externalPostId", p."publishedAt", p."deletedAt", p."contentPurgedAt",
      p."legalHold", p."history", p."historyVersion", p."claimIds",
      p."assetIds", p."claimRegistryVersion", p."assetRegistryVersion",
      p."factSnapshot", p."factsDigest"
    FROM "MarketingPost" AS p
    JOIN "MarketingChannel" AS c ON c."id" = p."channelId"
    WHERE p."id" = ${id}
    FOR UPDATE OF p
  `);
  const row = rows[0];
  if (!row) {
    throw new MarketingStoreRefusedError(
      "post_not_found",
      "The marketing post does not exist",
    );
  }
  return row;
}

async function marketingDatabaseNow(database: MarketingDatabase): Promise<Date> {
  const rows = await database.$queryRaw<Array<{ now: Date }>>(Prisma.sql`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `);
  const now = rows[0]?.now;
  if (!now) {
    throw new MarketingStoreRefusedError(
      "database_clock_unavailable",
      "The database clock did not return a timestamp",
    );
  }
  return now;
}

async function requireMarketingAudit(
  database: MarketingDatabase,
  input: {
    auditLogId: string;
    action: string;
    targetId: string;
    metadata?: Readonly<Record<string, string | number | boolean>>;
    notBefore?: Date;
  },
): Promise<Date> {
  const verdict = await verifyMarketingAuditEvidence(database, input);
  if (!verdict.ok) {
    throw new MarketingStoreRefusedError(
      `audit_evidence_${verdict.problem}`,
      `The audit entry is not evidence of this write: ${verdict.problem}`,
    );
  }
  return verdict.createdAt;
}

export async function approveMarketingPost(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedEnvelopeDigest: string;
    expectedHistoryVersion: number;
    approvalAuditLogId: string;
    approvalExpiresAt: Date;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedEnvelopeDigest: String(rawInput.expectedEnvelopeDigest),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    approvalAuditLogId: String(rawInput.approvalAuditLogId),
    approvalExpiresAt: new Date(rawInput.approvalExpiresAt.getTime()),
  };
  const row = await lockMarketingPost(database, input.id);
  if (
    row.status !== "pending_approval" ||
    row.envelopeDigest !== input.expectedEnvelopeDigest ||
    row.historyVersion !== input.expectedHistoryVersion
  ) {
    throw new MarketingStoreRefusedError(
      "approval_conflict",
      "The pending post changed before approval",
    );
  }
  const approvedAt = await requireMarketingAudit(database, {
    auditLogId: input.approvalAuditLogId,
    action: MARKETING_S2B1_ACTIONS.postApprove,
    targetId: input.id,
    metadata: { digest: input.expectedEnvelopeDigest },
  });
  if (input.approvalExpiresAt.getTime() <= approvedAt.getTime()) {
    throw new MarketingStoreRefusedError(
      "approval_expiry_invalid",
      "An approval must expire after it was recorded",
    );
  }
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      status: "pending_approval",
      envelopeDigest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
    },
    data: {
      status: "approved",
      approvalAuditLogId: input.approvalAuditLogId,
      approvedDigest: input.expectedEnvelopeDigest,
      approvedAt,
      approvalExpiresAt: input.approvalExpiresAt,
    },
  });
  requireOne(updated.count, "approval_conflict", "Another approval won this post");
}

export async function rejectMarketingPost(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedEnvelopeDigest: string;
    expectedHistoryVersion: number;
    auditLogId: string;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedEnvelopeDigest: String(rawInput.expectedEnvelopeDigest),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    auditLogId: String(rawInput.auditLogId),
  };
  const row = await lockMarketingPost(database, input.id);
  if (
    row.status !== "pending_approval" ||
    row.envelopeDigest !== input.expectedEnvelopeDigest ||
    row.historyVersion !== input.expectedHistoryVersion
  ) {
    throw new MarketingStoreRefusedError(
      "rejection_conflict",
      "The pending post changed before rejection",
    );
  }
  await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_S2B1_ACTIONS.postReject,
    targetId: input.id,
    metadata: { digest: input.expectedEnvelopeDigest },
  });
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      status: "pending_approval",
      envelopeDigest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
    },
    data: { status: "rejected" },
  });
  requireOne(updated.count, "rejection_conflict", "Another decision won this post");
}

export async function editMarketingPost(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedEnvelopeDigest: string;
    expectedHistoryVersion: number;
    envelope: MarketingEnvelope;
    decision: GuardDecision;
    auditLogId: string;
  },
) {
  const decision = rawInput.decision;
  const envelope = marketingEnvelopeSchema.parse(rawInput.envelope);
  const input = {
    id: String(rawInput.id),
    expectedEnvelopeDigest: String(rawInput.expectedEnvelopeDigest),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    envelope,
    decision,
    auditLogId: String(rawInput.auditLogId),
  };
  if (!marketingGuardDecisionIsSealed(decision)) {
    throw new MarketingStoreRefusedError(
      "guard_decision_not_sealed",
      "An edit records a decision guardDraft() made",
    );
  }
  if (decision.verdict === "reject") {
    throw new MarketingStoreRefusedError(
      "edited_content_guard_rejected",
      "Guard-rejected content cannot remain in the approval queue",
    );
  }
  const digest = marketingEnvelopeDigest(envelope);
  const row = await lockMarketingPost(database, input.id);
  if (
    row.status !== "pending_approval" ||
    row.envelopeDigest !== input.expectedEnvelopeDigest ||
    row.historyVersion !== input.expectedHistoryVersion ||
    row.contentPurgedAt !== null
  ) {
    throw new MarketingStoreRefusedError(
      "edit_conflict",
      "The post changed before the edit was saved",
    );
  }
  const history = marketingHistorySchema.parse(row.history);
  if (
    history.some(
      (entry) =>
        entry.type === "edit_revision" && entry.byAuditLogId === input.auditLogId,
    )
  ) {
    throw new MarketingStoreRefusedError(
      "edit_audit_reused",
      "One audit entry authorises one edit",
    );
  }
  const sameSet = (left: readonly string[], right: readonly string[]) =>
    left.length === right.length &&
    new Set(left).size === left.length &&
    left.every((value) => right.includes(value));
  if (
    envelope.channel !== row.channel ||
    envelope.accountSlug !== row.accountSlug ||
    envelope.locale !== row.locale ||
    !sameSet(envelope.claimIds, row.claimIds) ||
    !sameSet(
      envelope.assets.map((asset) => asset.assetId),
      row.assetIds,
    )
  ) {
    throw new MarketingStoreRefusedError(
      "edit_changes_immutable_scope",
      "An edit cannot move the post to different account, locale, claims or assets",
    );
  }
  const draftDigest = marketingGuardDraftDigest({
    renderedText: envelope.renderedText,
    locale: row.locale,
    channel: row.channel,
    channelId: row.channelId,
    claimIds: row.claimIds,
    assetIds: row.assetIds,
  });
  const factSnapshotDigest = createHash("sha256")
    .update(JSON.stringify(canonicalJson(row.factSnapshot)), "utf8")
    .digest("hex");
  const factsScopeDigest = marketingFactsScopeDigest({
    channelId: row.channelId,
    channel: row.channel,
    locale: row.locale,
    claimIds: row.claimIds,
    assetIds: row.assetIds,
    claimRegistryVersion: row.claimRegistryVersion,
    assetRegistryVersion: row.assetRegistryVersion,
    factSnapshotDigest,
  });
  if (
    decision.draftDigest !== draftDigest ||
    decision.factsScopeDigest !== factsScopeDigest
  ) {
    throw new MarketingStoreRefusedError(
      "edit_guard_binding_mismatch",
      "The Guard decision is not about this edited post and its stored facts",
    );
  }
  const editedAt = await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_S2B1_ACTIONS.postEdit,
    targetId: input.id,
    metadata: {
      digest,
      previousDigest: input.expectedEnvelopeDigest,
    },
  });
  const codes = "codes" in decision ? [...decision.codes] : [];
  const entries: MarketingHistoryEntry[] = [
    {
      at: editedAt.toISOString(),
      type: "edit_revision",
      envelopeDigest: digest,
      previousEnvelopeDigest: input.expectedEnvelopeDigest,
      byAuditLogId: input.auditLogId,
    },
    {
      at: editedAt.toISOString(),
      type: "guard_result",
      decision: decision.verdict,
      codes,
      ruleIds: [...decision.ruleIds],
    },
  ];
  entries.forEach((entry) => marketingHistoryEntrySchema.parse(entry));
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      status: "pending_approval",
      envelopeDigest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
    },
    data: {
      envelope: asJson(envelope),
      envelopeDigest: digest,
      guardDecision: decision.verdict,
      guardCodes: codes,
      guardRuleIds: [...decision.ruleIds],
      factsDigest: decision.factsDigest,
      reusableAsTemplate: false,
      history: asJson([...history, ...entries]),
      historyVersion: input.expectedHistoryVersion + 1,
    },
  });
  requireOne(updated.count, "edit_conflict", "The post changed before the edit committed");
}

/**
 * The states a post can be marked reusable from.
 *
 * The same four `loadApprovedTemplate` accepts (S1 plan r4 amendment 5). It is
 * not just `published`: verification is the publisher confirming the post is
 * publicly visible, and it happens on its own, so a narrower list would let a
 * post pass out of reach before anyone marked it -- and a template nobody can
 * mark is an autonomy path nothing can reach.
 */
export const MARKETING_TEMPLATE_SOURCE_STATUSES = [
  "approved",
  "scheduled",
  "published",
  "verified",
] as const;

export async function markMarketingPostReusable(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedEnvelopeDigest: string;
    expectedHistoryVersion: number;
    auditLogId: string;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedEnvelopeDigest: String(rawInput.expectedEnvelopeDigest),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    auditLogId: String(rawInput.auditLogId),
  };
  const row = await lockMarketingPost(database, input.id);
  if (
    !(MARKETING_TEMPLATE_SOURCE_STATUSES as readonly string[]).includes(row.status) ||
    row.reusableAsTemplate ||
    row.envelopeDigest !== input.expectedEnvelopeDigest ||
    row.approvedDigest !== input.expectedEnvelopeDigest ||
    row.historyVersion !== input.expectedHistoryVersion ||
    row.contentPurgedAt !== null ||
    row.deletedAt !== null
  ) {
    throw new MarketingStoreRefusedError(
      "mark_reusable_conflict",
      "Only unchanged approved content in a template-eligible state can become reusable",
    );
  }
  await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_S2B1_ACTIONS.postMarkReusable,
    targetId: input.id,
    metadata: {
      digest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
    },
  });
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      // The state it was read in, not the list. The row was locked and checked
      // against the list above; pinning the exact value is what makes a
      // transition between the read and the write a refusal rather than a
      // write against a post that has moved on.
      status: row.status,
      reusableAsTemplate: false,
      envelopeDigest: input.expectedEnvelopeDigest,
      approvedDigest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
      contentPurgedAt: null,
      deletedAt: null,
    },
    data: { reusableAsTemplate: true },
  });
  requireOne(updated.count, "mark_reusable_conflict", "The post changed before marking");
}

export async function scheduleMarketingPost(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedEnvelopeDigest: string;
    expectedHistoryVersion: number;
    scheduledAt: Date;
    auditLogId: string;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedEnvelopeDigest: String(rawInput.expectedEnvelopeDigest),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    scheduledAt: new Date(rawInput.scheduledAt.getTime()),
    auditLogId: String(rawInput.auditLogId),
  };
  const row = await lockMarketingPost(database, input.id);
  const envelope = marketingEnvelopeSchema.safeParse(row.envelope);
  const now = await marketingDatabaseNow(database);
  if (
    row.status !== "approved" ||
    row.envelopeDigest !== input.expectedEnvelopeDigest ||
    row.approvedDigest !== input.expectedEnvelopeDigest ||
    row.historyVersion !== input.expectedHistoryVersion ||
    !envelope.success ||
    envelope.data.scheduledAt !== input.scheduledAt.toISOString() ||
    input.scheduledAt.getTime() <= now.getTime()
  ) {
    throw new MarketingStoreRefusedError(
      "schedule_conflict",
      "The approval or its future envelope schedule no longer matches",
    );
  }
  await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_S2B1_ACTIONS.postSchedule,
    targetId: input.id,
    metadata: {
      digest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
    },
  });
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      status: "approved",
      envelopeDigest: input.expectedEnvelopeDigest,
      approvedDigest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
    },
    data: { status: "scheduled", scheduledAt: input.scheduledAt },
  });
  requireOne(updated.count, "schedule_conflict", "The post changed before scheduling");
}

export async function requeueMarketingPostAfterFailure(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedEnvelopeDigest: string;
    expectedHistoryVersion: number;
    auditLogId: string;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedEnvelopeDigest: String(rawInput.expectedEnvelopeDigest),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    auditLogId: String(rawInput.auditLogId),
  };
  const row = await lockMarketingPost(database, input.id);
  if (
    row.status !== "failed" ||
    row.envelopeDigest !== input.expectedEnvelopeDigest ||
    row.historyVersion !== input.expectedHistoryVersion ||
    input.auditLogId === row.approvalAuditLogId
  ) {
    throw new MarketingStoreRefusedError(
      "requeue_conflict",
      "The failed post changed before re-queue",
    );
  }
  const history = marketingHistorySchema.parse(row.history);
  const lastFailureAt = history
    .filter(
      (entry) =>
        entry.type === "attempt" &&
        entry.outcome === "failed" &&
        entry.attempt === row.publishAttempt,
    )
    .map((entry) => new Date(entry.at).getTime())
    .reduce((latest, at) => Math.max(latest, at), Number.NEGATIVE_INFINITY);
  if (!Number.isFinite(lastFailureAt)) {
    throw new MarketingStoreRefusedError(
      "requeue_without_failure",
      "The current failed attempt is absent from history",
    );
  }
  const approvedAt = await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_REQUEUE_ACTION,
    targetId: input.id,
    metadata: { digest: input.expectedEnvelopeDigest },
    notBefore: new Date(lastFailureAt),
  });
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      status: "failed",
      envelopeDigest: input.expectedEnvelopeDigest,
      historyVersion: input.expectedHistoryVersion,
      approvalAuditLogId: row.approvalAuditLogId,
      publishAttempt: row.publishAttempt,
    },
    data: {
      status: "scheduled",
      approvalAuditLogId: input.auditLogId,
      approvedAt,
      approvedDigest: input.expectedEnvelopeDigest,
    },
  });
  requireOne(updated.count, "requeue_conflict", "The post changed before re-queue");
}

async function updateMarketingPostLegalHold(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedHistoryVersion: number;
    auditLogId: string;
  },
  legalHold: boolean,
) {
  const input = {
    id: String(rawInput.id),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    auditLogId: String(rawInput.auditLogId),
  };
  const row = await lockMarketingPost(database, input.id);
  if (
    row.historyVersion !== input.expectedHistoryVersion ||
    row.legalHold !== !legalHold
  ) {
    throw new MarketingStoreRefusedError(
      "legal_hold_conflict",
      "The post or its legal-hold state changed",
    );
  }
  await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: legalHold
      ? MARKETING_S2B1_ACTIONS.postLegalHoldSet
      : MARKETING_S2B1_ACTIONS.postLegalHoldReleased,
    targetId: input.id,
    metadata: { historyVersion: input.expectedHistoryVersion },
  });
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      historyVersion: input.expectedHistoryVersion,
      legalHold: !legalHold,
    },
    data: { legalHold },
  });
  requireOne(updated.count, "legal_hold_conflict", "The post changed before legal hold update");
}

export const setMarketingPostLegalHold = (
  database: MarketingDatabase,
  input: { id: string; expectedHistoryVersion: number; auditLogId: string },
) => updateMarketingPostLegalHold(database, input, true);

export const releaseMarketingPostLegalHold = (
  database: MarketingDatabase,
  input: { id: string; expectedHistoryVersion: number; auditLogId: string },
) => updateMarketingPostLegalHold(database, input, false);

export async function resolveMarketingPostOutcomeUnknown(
  database: MarketingDatabase,
  rawInput:
    | {
        id: string;
        expectedHistoryVersion: number;
        resolution: "published";
        externalPostId: string;
        externalUrl: string;
        evidenceRef: string;
        auditLogId: string;
      }
    | {
        id: string;
        expectedHistoryVersion: number;
        resolution: "failed";
        errorCode: string;
        evidenceRef: string;
        auditLogId: string;
      },
) {
  const common = {
    id: String(rawInput.id),
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    resolution: rawInput.resolution,
    evidenceRef: String(rawInput.evidenceRef),
    auditLogId: String(rawInput.auditLogId),
  };
  const input =
    rawInput.resolution === "published"
      ? {
          ...common,
          resolution: "published" as const,
          externalPostId: String(rawInput.externalPostId),
          externalUrl: String(rawInput.externalUrl),
        }
      : {
          ...common,
          resolution: "failed" as const,
          errorCode: String(rawInput.errorCode),
        };
  if (
    input.evidenceRef.length < 1 ||
    input.evidenceRef.length > 2048 ||
    /[\u0000-\u001F\u007F]/u.test(input.evidenceRef)
  ) {
    throw new MarketingStoreRefusedError(
      "outcome_evidence_invalid",
      "Outcome evidence must be a bounded control-free reference",
    );
  }
  if (
    input.resolution === "published" &&
    (input.externalPostId.length < 1 || !input.externalUrl.startsWith("https://"))
  ) {
    throw new MarketingStoreRefusedError(
      "published_evidence_invalid",
      "Confirmed publication needs an external id and HTTPS URL",
    );
  }
  if (
    input.resolution === "failed" &&
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/u.test(input.errorCode)
  ) {
    throw new MarketingStoreRefusedError(
      "failure_code_invalid",
      "Confirmed failure needs a bounded error code",
    );
  }
  const row = await lockMarketingPost(database, input.id);
  if (
    row.status !== "outcome_unknown" ||
    row.historyVersion !== input.expectedHistoryVersion ||
    row.publishedAt !== null
  ) {
    throw new MarketingStoreRefusedError(
      "outcome_resolution_conflict",
      "The unknown outcome changed before resolution",
    );
  }
  await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_S2B1_ACTIONS.postResolveOutcomeUnknown,
    targetId: input.id,
    metadata: {
      resolution: input.resolution,
      evidenceRef: input.evidenceRef,
      historyVersion: input.expectedHistoryVersion,
    },
  });
  const now = await marketingDatabaseNow(database);
  const history = marketingHistorySchema.parse(row.history);
  const failedEntry: MarketingHistoryEntry | null =
    input.resolution === "failed"
      ? {
          at: now.toISOString(),
          type: "attempt",
          attempt: row.publishAttempt,
          outcome: "failed",
          errorCode: input.errorCode,
        }
      : null;
  if (failedEntry) marketingHistoryEntrySchema.parse(failedEntry);
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      status: "outcome_unknown",
      historyVersion: input.expectedHistoryVersion,
      publishAttempt: row.publishAttempt,
      publishedAt: null,
    },
    data:
      input.resolution === "published"
        ? {
            status: "published",
            externalPostId: input.externalPostId,
            externalUrl: input.externalUrl,
            publishedAt: now,
            errorCode: null,
          }
        : {
            status: "failed",
            errorCode: input.errorCode,
            history: asJson([...history, failedEntry!]),
            historyVersion: input.expectedHistoryVersion + 1,
          },
  });
  requireOne(
    updated.count,
    "outcome_resolution_conflict",
    "The unknown outcome changed before resolution committed",
  );
}

export async function unpublishMarketingPost(
  database: MarketingDatabase,
  rawInput: {
    id: string;
    expectedStatus: "published" | "verified";
    expectedHistoryVersion: number;
    expectedExternalPostId: string;
    evidenceRef: string;
    cancellationSupported: true;
    removalConfirmed: true;
    auditLogId: string;
  },
) {
  const input = {
    id: String(rawInput.id),
    expectedStatus: rawInput.expectedStatus,
    expectedHistoryVersion: Number(rawInput.expectedHistoryVersion),
    expectedExternalPostId: String(rawInput.expectedExternalPostId),
    evidenceRef: String(rawInput.evidenceRef),
    cancellationSupported: rawInput.cancellationSupported,
    removalConfirmed: rawInput.removalConfirmed,
    auditLogId: String(rawInput.auditLogId),
  };
  if (input.cancellationSupported !== true || input.removalConfirmed !== true) {
    throw new MarketingStoreRefusedError(
      "unpublish_not_confirmed",
      "No ledger deletion is written until external removal is confirmed",
    );
  }
  const row = await lockMarketingPost(database, input.id);
  if (
    row.status !== input.expectedStatus ||
    row.historyVersion !== input.expectedHistoryVersion ||
    row.externalPostId !== input.expectedExternalPostId ||
    row.deletedAt !== null
  ) {
    throw new MarketingStoreRefusedError(
      "unpublish_conflict",
      "The published post changed before removal was recorded",
    );
  }
  await requireMarketingAudit(database, {
    auditLogId: input.auditLogId,
    action: MARKETING_S2B1_ACTIONS.postUnpublish,
    targetId: input.id,
    metadata: {
      externalPostId: input.expectedExternalPostId,
      evidenceRef: input.evidenceRef,
      historyVersion: input.expectedHistoryVersion,
    },
  });
  const now = await marketingDatabaseNow(database);
  const updated = await database.marketingPost.updateMany({
    where: {
      id: input.id,
      status: input.expectedStatus,
      historyVersion: input.expectedHistoryVersion,
      externalPostId: input.expectedExternalPostId,
      deletedAt: null,
    },
    data: {
      status: "deleted",
      deletedAt: now,
      deletionMethod: "api_unpublish",
    },
  });
  requireOne(updated.count, "unpublish_conflict", "The post changed before removal commit");
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
