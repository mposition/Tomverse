/**
 * The decisions a fan-out makes, separated from the rows it reads.
 *
 * Contract: docs/policy/email-notifications.md §10.2,
 * .github/audits/model-lifecycle-email-2026-08-22.md EM-01, §12.3.
 *
 * `EmailEvent` has carried `audienceKind`, `audienceSpec`, `expansionCursor`
 * and the `pending`/`expanding`/`failed` statuses since the schema was written,
 * and nothing ever wrote any of them: every event was `single_user`, already
 * `expanded`. That is why there is no way to tell anybody about a model
 * retirement today.
 *
 * The rules live here rather than in the expander so the interesting ones --
 * when a pass may start, when it must stop, what the cap means -- can be tested
 * without a database and without ten thousand rows.
 */

export const AUDIENCE_KINDS = ["single_user", "user_segment", "all_users"] as const;
export type AudienceKind = (typeof AUDIENCE_KINDS)[number];

export const EXPANSION_STATUSES = [
  "pending",
  "expanding",
  "expanded",
  "failed",
] as const;
export type ExpansionStatus = (typeof EXPANSION_STATUSES)[number];

/** How many recipients one transaction takes (§12.3). */
export const EXPANSION_BATCH_SIZE = 200;

export type ExpansionRefusal =
  | "not_a_segment"
  | "already_expanded"
  | "previously_failed";

/**
 * Whether a pass may run at all.
 *
 * `expanding` is allowed through: it is what a pass that died halfway leaves
 * behind, and refusing it would make a crash permanent. Resuming is safe
 * because the unique index on `(eventId, recipientKey)` decides duplicates, not
 * this function.
 */
export const expansionRefusal = (input: {
  audienceKind: string;
  status: string;
}): ExpansionRefusal | null => {
  if (input.audienceKind === "single_user") {
    // A single-user event is written whole by the enqueue path, delivery row
    // and all. Expanding one would mean a second row for the same person.
    return "not_a_segment";
  }
  if (input.status === "expanded") return "already_expanded";
  if (input.status === "failed") {
    // Deliberately not resumable without a person. A fan-out that failed left
    // an unknown amount done, and the reason it failed is usually not the kind
    // that fixes itself.
    return "previously_failed";
  }
  return null;
};

export type ExpansionSpec = {
  /** Explicit recipients, for a cohort computed somewhere else. */
  userIds?: readonly string[];
  /**
   * The most this event may ever produce.
   *
   * A cap is not a page size. It is the answer to "what if the audience query
   * is wrong", and the cost of being wrong about a send is that it has already
   * arrived (§12.3).
   */
  recipientCap?: number;
  /**
   * Expand and record, but let the lane skip every row instead of sending.
   *
   * A dry run that produced no rows would not answer the question a dry run is
   * asked -- who would this have reached -- so it produces exactly the same
   * rows and marks them.
   */
  dryRun?: boolean;
};

/**
 * Reads the stored spec, defaulting rather than throwing.
 *
 * A malformed spec is treated as an empty one: an expansion that cannot tell
 * who it is for must reach nobody, and a throw here would mark the event
 * `failed` for what may be a typo in one field.
 */
export const readExpansionSpec = (raw: unknown): ExpansionSpec => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const userIds = Array.isArray(value.userIds)
    ? value.userIds.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const cap =
    typeof value.recipientCap === "number" &&
    Number.isInteger(value.recipientCap) &&
    value.recipientCap >= 0
      ? value.recipientCap
      : undefined;
  return {
    ...(userIds ? { userIds } : {}),
    ...(cap === undefined ? {} : { recipientCap: cap }),
    ...(value.dryRun === true ? { dryRun: true } : {}),
  };
};

export type BatchPlan = {
  /** How many to read. Zero means the cap is already reached. */
  take: number;
  capReached: boolean;
};

/**
 * How many to read next, given the cap and what is already written.
 *
 * Returned rather than clamped inside the loop so "the cap stopped this" is a
 * value the caller can report, not a shape of the data it has to infer.
 */
export const nextBatchPlan = (input: {
  expandedSoFar: number;
  recipientCap?: number;
  batchSize?: number;
}): BatchPlan => {
  const batchSize = input.batchSize ?? EXPANSION_BATCH_SIZE;
  if (input.recipientCap === undefined) {
    return { take: batchSize, capReached: false };
  }
  const remaining = input.recipientCap - input.expandedSoFar;
  if (remaining <= 0) return { take: 0, capReached: true };
  return { take: Math.min(batchSize, remaining), capReached: false };
};

export type ExpansionResult = {
  /** Delivery rows written by this pass. */
  expanded: number;
  /** Recipients this pass looked at and did not write a row for. */
  skipped: number;
  /** Rows a previous pass had already written for the same recipients. */
  alreadyPresent: number;
  status: ExpansionStatus;
  /** Set when the pass ended because it ran out of room rather than people. */
  capReached: boolean;
  cursor: string | null;
};

/**
 * Why a recipient produced no delivery row.
 *
 * `no_address` is the only one decided here. Consent and suppression are left
 * to the gates the lane already runs at send time: a row that is skipped there
 * records *why* on itself, which is how "who did this reach" stays answerable
 * from one table (§12.2 asks the same question of the campaign layer).
 */
export const EXPANSION_SKIP_REASONS = ["no_address"] as const;
export type ExpansionSkipReason = (typeof EXPANSION_SKIP_REASONS)[number];
