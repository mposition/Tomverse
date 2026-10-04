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
  | "previously_failed"
  | "no_audience";

/**
 * Why a pass produced nothing, including the one reason the pure rule cannot
 * see: an event id that names no row. Kept a closed list rather than `string`
 * so a caller switching on it is told when a new reason appears.
 */
export type ExpansionRefusalReason =
  | ExpansionRefusal
  | "not_found"
  /**
   * The marketing feature is switched off (EM-05).
   *
   * Not part of the pure rule above because it is a fact about the
   * installation rather than about the event, and it is read from
   * `AppSetting` rather than from anything the caller passes in.
   *
   * It has to be here at all because a fan-out does not go through
   * `enqueueStandardEmail`: it writes its delivery rows directly. A flag that
   * only guarded the single-message path would leave the campaign path as an
   * unguarded second route to exactly the sends it was meant to stop.
   */
  | "marketing_disabled"
  /**
   * The release-notes product is switched off, which is not the same switch.
   *
   * Here for the same reason `marketing_disabled` is: a fan-out writes its
   * delivery rows directly rather than going through `enqueueStandardEmail`, so
   * a flag guarding only the single-message path would leave this one open.
   */
  | "release_notes_disabled"
  /**
   * The amendment notice and its cohort are not paired as the contract says
   * (`policyChangeNoticePairingProblem`). Checked at draft too; here because an
   * event stored before that check, or written by another path, must not reach
   * a different set of people than the gate counts.
   */
  | "notice_audience_mismatch";

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
  /** The spec as read, so an unusable one is refused rather than widened. */
  spec?: ExpansionSpec;
}): ExpansionRefusal | null => {
  if (input.audienceKind === "single_user") {
    // A single-user event is written whole by the enqueue path, delivery row
    // and all. Expanding one would mean a second row for the same person.
    return "not_a_segment";
  }
  if (input.audienceKind === "user_segment" && input.spec && !hasAudience(input.spec)) {
    // A segment that names nobody is not "everybody". `readExpansionSpec`
    // defaults a spec it cannot read to an empty one, and an empty one used to
    // fall through to the unfiltered query -- so one mistyped field turned a
    // retirement notice for a few hundred people into a send to the whole
    // product. `all_users` still means everyone, because saying so is a
    // separate, deliberate act.
    return "no_audience";
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

/**
 * An audience the expander resolves itself, rather than one handed to it.
 *
 * A model retirement reaches thousands of people across three overlapping
 * cohorts (§13.1). Computing that list somewhere else and carrying it in
 * `userIds` would put thousands of ids in a JSON column, and would freeze the
 * answer at the moment it was computed -- which is exactly wrong for a reminder
 * wave, whose whole job is to re-ask who is still affected.
 */
export type AudienceCohortSpec =
  | {
      kind: "model_retirement";
      targetModelId: string;
      replacementModelId: string;
    }
  | {
      /** Active accounts that explicitly opted into this marketing purpose. */
      kind: "marketing_consent";
      purpose: "product_updates";
    }
  | {
      /**
       * Every account the amendment notice is owed to and has not yet reached
       * or is not already on its way to (S10).
       *
       * Owed means what the publication gate counts as owed
       * (lib/emailPolicyPublication.ts): created before the effective date, or
       * with no creation time at all. The date is in the spec rather than read
       * at expansion so a wave keeps meaning the amendment it was approved for;
       * the draft refuses a date that is not the notice's own.
       */
      kind: "policy_change_notice";
      effectiveDate: string;
    };

/**
 * How long a `sent` notice counts as on its way without a delivery report.
 *
 * An account holding a notice that arrived -- the gate's told states *with* a
 * recorded arrival, exactly as `noticeFactsFor` reads them -- or one still on
 * its way is not written to again. `pending` is on its way for as long as it
 * is pending. `sent` is on its way only for this long: a delivery report that
 * never comes leaves the row `sent` for good while the gate counts the account
 * untold, and an account the gate is waiting on must not be left out of every
 * later wave. Everything else -- bounced, suppressed, skipped, failed,
 * abandoned -- did not arrive, so a later wave asks again; a lane that still
 * refuses the address records that on the new row, which is what the gate's
 * unreachable rule reads.
 */
export const NOTICE_SENT_IN_FLIGHT_DAYS = 3;

/**
 * The waves an amendment notice draft holds, all started by hand.
 *
 * Distinct kinds, because the schedule check refuses a repeated kind at
 * approval. Each wave asks the cohort again, so the two follow-ups reach
 * accounts created since and notices that did not arrive.
 */
export const POLICY_NOTICE_CAMPAIGN_WAVES = [
  { kind: "launch", sequence: 1 },
  { kind: "reminder", sequence: 1 },
  { kind: "final_reminder", sequence: 1 },
] as const;

/** YYYY-MM-DD naming a real calendar day, or null. */
export const readIsoDay = (raw: unknown): string | null => {
  if (typeof raw !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const day = new Date(`${raw}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== raw ? null : raw;
};

/**
 * Why a template and a cohort may not go out together, or null.
 *
 * The notice cohort reaches people who turned every email off, because the
 * notice is a `legal` message and that is what it is for. Paired with any other
 * template it would mail a marketing or product message to that same
 * population, so the pairing is closed in both directions: the notice cohort
 * carries only the notice, and the notice goes only to its own cohort -- a
 * hand-picked list or a consent cohort would leave owed accounts out, and the
 * gate would then wait on people nobody wrote to.
 */
export const policyChangeNoticePairingProblem = (input: {
  templateKey: string;
  noticeTemplateKey: string;
  noticeEffectiveDate: string | null;
  spec: ExpansionSpec;
}): string | null => {
  const isNoticeTemplate = input.templateKey === input.noticeTemplateKey;
  const cohort = input.spec.cohort;
  const isNoticeCohort = cohort?.kind === "policy_change_notice";
  if (isNoticeCohort && !isNoticeTemplate) {
    return `The amendment notice cohort carries only ${input.noticeTemplateKey}, not ${input.templateKey}.`;
  }
  if (!isNoticeTemplate) return null;
  if (!isNoticeCohort || (input.spec.userIds && input.spec.userIds.length > 0)) {
    return "The amendment notice goes to its own cohort (every owed account), not to a list or another cohort.";
  }
  if (input.noticeEffectiveDate === null) {
    return "The amendment notice has no effective date yet, so it has no audience.";
  }
  if (cohort.effectiveDate !== input.noticeEffectiveDate) {
    return `The amendment notice announces ${input.noticeEffectiveDate}; this campaign names ${cohort.effectiveDate}.`;
  }
  return null;
};

export type ExpansionSpec = {
  /** Explicit recipients, for a cohort computed somewhere else. */
  userIds?: readonly string[];
  /** A cohort the expander resolves as it goes. */
  cohort?: AudienceCohortSpec;
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
const readCohortSpec = (raw: unknown): AudienceCohortSpec | undefined => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const value = raw as Record<string, unknown>;
  if (value.kind === "marketing_consent") {
    return value.purpose === "product_updates"
      ? { kind: "marketing_consent", purpose: "product_updates" }
      : undefined;
  }
  if (value.kind === "policy_change_notice") {
    const effectiveDate = readIsoDay(value.effectiveDate);
    return effectiveDate ? { kind: "policy_change_notice", effectiveDate } : undefined;
  }
  if (value.kind !== "model_retirement") return undefined;
  const target = value.targetModelId;
  const replacement = value.replacementModelId;
  // Both, or neither. A retirement cohort with no replacement cannot answer
  // the plan-compatibility question (§13.3 condition 4), and a spec that is
  // half-read is the kind that reaches the wrong people confidently.
  if (typeof target !== "string" || target.trim().length === 0) return undefined;
  if (typeof replacement !== "string" || replacement.trim().length === 0) {
    return undefined;
  }
  return {
    kind: "model_retirement",
    targetModelId: target.trim(),
    replacementModelId: replacement.trim(),
  };
};

export const readExpansionSpec = (raw: unknown): ExpansionSpec => {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const value = raw as Record<string, unknown>;
  const userIds = Array.isArray(value.userIds)
    ? value.userIds.filter((entry): entry is string => typeof entry === "string")
    : undefined;
  const cohort = readCohortSpec(value.cohort);
  const cap =
    typeof value.recipientCap === "number" &&
    Number.isInteger(value.recipientCap) &&
    value.recipientCap >= 0
      ? value.recipientCap
      : undefined;
  return {
    ...(userIds ? { userIds } : {}),
    ...(cohort ? { cohort } : {}),
    ...(cap === undefined ? {} : { recipientCap: cap }),
    ...(value.dryRun === true ? { dryRun: true } : {}),
  };
};

/**
 * Whether a spec names anybody at all.
 *
 * Separate from parsing so the refusal above and the expander read the same
 * answer: "the spec was unreadable" and "the spec named nobody" have to reach
 * the same place, because a caller cannot tell them apart and both mean the
 * send must not go out.
 */
export const hasAudience = (spec: ExpansionSpec): boolean =>
  Boolean((spec.userIds && spec.userIds.length > 0) || spec.cohort);

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
