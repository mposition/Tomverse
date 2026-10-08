/**
 * The support-triage agent's deterministic core: the timeout layers and the
 * guarded budget derived from them, the retention batch gate, the retention
 * heartbeat conditions, the per-pass promotion budget and the decision about an
 * inherited `transaction_timeout`.
 *
 * Every value here is fixed by docs/policy/support-triage.md (version 1). This
 * module is pure: no I/O, no clock reads, no environment. Callers pass the
 * clock and the database facts in, so the same inputs always give the same
 * decision.
 */

export const SUPPORT_TRIAGE_POLICY_VERSION = 1;

export type SupportTriageLane = "worker" | "retention" | "admin";

export type LaneTimeouts = {
  /** Server deadline from run start; `null` means no deadline (admin). */
  readonly deadlineMs: number | null;
  readonly statementTimeoutMs: number;
  readonly idleInTransactionTimeoutMs: number;
  /** Armed only on PostgreSQL 17; 16 has no such setting. */
  readonly transactionTimeoutMs: number;
  readonly prismaTransactionTimeoutMs: number;
  /** Largest round-trip count any transaction of this lane may send. */
  readonly maxRoundTrips: number;
};

/** docs/policy/support-triage.md section 4. */
export const LANE_TIMEOUTS: Readonly<Record<SupportTriageLane, LaneTimeouts>> =
  Object.freeze({
    worker: Object.freeze({
      deadlineMs: 5 * 60_000,
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 2_000,
      transactionTimeoutMs: 150_000,
      prismaTransactionTimeoutMs: 180_000,
      maxRoundTrips: 20,
    }),
    retention: Object.freeze({
      deadlineMs: 100_000,
      statementTimeoutMs: 400,
      idleInTransactionTimeoutMs: 150,
      transactionTimeoutMs: 20_000,
      prismaTransactionTimeoutMs: 30_000,
      maxRoundTrips: 19,
    }),
    admin: Object.freeze({
      deadlineMs: null,
      statementTimeoutMs: 5_000,
      idleInTransactionTimeoutMs: 2_000,
      transactionTimeoutMs: 120_000,
      prismaTransactionTimeoutMs: 150_000,
      maxRoundTrips: 16,
    }),
  });

/**
 * The application-derived guarded budget of one transaction:
 * `A × statement_timeout + (A − 1) × idle`. It is not a database bound —
 * PostgreSQL has no statement counter — and must never be called one.
 */
export const guardedBudgetMs = (lane: SupportTriageLane, roundTrips: number) => {
  if (!Number.isSafeInteger(roundTrips) || roundTrips < 1) {
    throw new RangeError("roundTrips must be a positive integer");
  }
  const timeouts = LANE_TIMEOUTS[lane];
  if (roundTrips > timeouts.maxRoundTrips) {
    throw new RangeError(`roundTrips exceeds the ${lane} lane maximum`);
  }
  return (
    roundTrips * timeouts.statementTimeoutMs +
    (roundTrips - 1) * timeouts.idleInTransactionTimeoutMs
  );
};

/** The largest `C_guarded` of a lane: 138 s, 10.3 s and 110 s. */
export const maxGuardedBudgetMs = (lane: SupportTriageLane) =>
  guardedBudgetMs(lane, LANE_TIMEOUTS[lane].maxRoundTrips);

/**
 * `Prisma timeout > transaction_timeout > C_guarded max > statement_timeout >
 * idle`, strictly. If the database timeouts invert, the shorter two are
 * silently never armed, so the order is a precondition of every budget above.
 */
export const laneTimeoutOrderHolds = (lane: SupportTriageLane) => {
  const t = LANE_TIMEOUTS[lane];
  const guarded = maxGuardedBudgetMs(lane);
  return (
    t.prismaTransactionTimeoutMs > t.transactionTimeoutMs &&
    t.transactionTimeoutMs > guarded &&
    guarded > t.statementTimeoutMs &&
    t.statementTimeoutMs > t.idleInTransactionTimeoutMs
  );
};

export type InheritedTimeoutDecision =
  | { readonly action: "proceed"; readonly armedBy: "policy" }
  | { readonly action: "proceed"; readonly armedBy: "inherited" }
  | { readonly action: "refuse"; readonly reason: "inherited_transaction_timeout_too_short" };

/**
 * Policy section 4 (Q22). A positive inherited `transaction_timeout` is armed
 * at transaction start and is not re-armed with the policy value. At or below
 * the lane's largest `C_guarded` the transaction is refused before any write;
 * above it the run proceeds and accepts that the occupancy bound is the
 * inherited number, not ours. `null` means the server has no such setting
 * (PostgreSQL 16).
 */
export const decideInheritedTransactionTimeout = (
  lane: SupportTriageLane,
  inheritedMs: number | null
): InheritedTimeoutDecision => {
  if (inheritedMs === null || inheritedMs === 0) {
    return { action: "proceed", armedBy: "policy" };
  }
  if (!Number.isSafeInteger(inheritedMs) || inheritedMs < 0) {
    throw new RangeError("inherited transaction_timeout must be a non-negative integer");
  }
  if (inheritedMs <= maxGuardedBudgetMs(lane)) {
    return { action: "refuse", reason: "inherited_transaction_timeout_too_short" };
  }
  return { action: "proceed", armedBy: "inherited" };
};

/** Policy sections 4, 5 and 8. */
export const RETENTION_BATCHES_PER_RUN_MAX = 8;
export const RETENTION_BATCH_ROUND_TRIPS = 19;
export const RETENTION_BATCH_SIZES = Object.freeze([500, 250, 125] as const);
export const RETENTION_OVERDUE_GRACE_SECONDS = 86_400;
export const RETENTION_LIVENESS_THRESHOLD_SECONDS = 80 * 60;
export const DAILY_RUN_CAP = Object.freeze({ worker: 52, retention: 52 } as const);

/**
 * A retention batch starts only while the remaining budget is strictly larger
 * than the batch's `C_guarded` and fewer than eight batches have started in
 * this run. Both must hold; either alone was not a bound.
 */
export const mayStartRetentionBatch = (input: {
  readonly remainingMs: number;
  readonly batchesStarted: number;
}) => {
  if (!Number.isFinite(input.remainingMs)) {
    throw new RangeError("remainingMs must be a finite number");
  }
  if (!Number.isSafeInteger(input.batchesStarted) || input.batchesStarted < 0) {
    throw new RangeError("batchesStarted must be a non-negative integer");
  }
  return (
    input.remainingMs > guardedBudgetMs("retention", RETENTION_BATCH_ROUND_TRIPS) &&
    input.batchesStarted < RETENTION_BATCHES_PER_RUN_MAX
  );
};

/** The next batch size after a `statement_timeout` abort, or `null` at the floor. */
export const reducedRetentionBatchSize = (current: number) => {
  const index = RETENTION_BATCH_SIZES.indexOf(current as 500 | 250 | 125);
  if (index < 0) throw new RangeError("unknown retention batch size");
  return index + 1 < RETENTION_BATCH_SIZES.length ? RETENTION_BATCH_SIZES[index + 1] : null;
};

export type RetentionRunFact = {
  readonly finishedAt: Date;
  readonly batchesCompleted: number;
  readonly overdueRemaining: number;
  readonly oldestOverdueAgeSeconds: number;
};

export type RetentionHeartbeat = {
  readonly stale: boolean;
  readonly liveness: boolean;
  readonly progressSingle: boolean;
  readonly progressDeadline: boolean;
};

const validTime = (value: Date, name: string) => {
  const time = value instanceof Date ? value.getTime() : Number.NaN;
  if (!Number.isFinite(time)) throw new RangeError(`${name} must be a valid Date`);
  return time;
};

/**
 * Policy section 7: three separate conditions, any of which opens the
 * heartbeat. Liveness reads the newest **successful** retention run
 * (`latestSuccessAt`, `null` when none exists in the 30-day window); the two
 * progress conditions read the newest **finished** run whatever its outcome
 * (`latestFinished`), because a run that ends with no completed batch and rows
 * still overdue answers non-2xx and is not a success.
 */
export const retentionHeartbeat = (input: {
  readonly now: Date;
  readonly latestSuccessAt: Date | null;
  readonly latestFinished: RetentionRunFact | null;
}): RetentionHeartbeat => {
  const now = validTime(input.now, "now");
  const liveness =
    input.latestSuccessAt === null ||
    (now - validTime(input.latestSuccessAt, "latestSuccessAt")) / 1_000 >
      RETENTION_LIVENESS_THRESHOLD_SECONDS;
  const latest = input.latestFinished;
  if (latest !== null) {
    validTime(latest.finishedAt, "latestFinished.finishedAt");
    for (const key of ["batchesCompleted", "overdueRemaining", "oldestOverdueAgeSeconds"] as const) {
      if (!Number.isSafeInteger(latest[key]) || latest[key] < 0) {
        throw new RangeError(`latestFinished.${key} must be a non-negative integer`);
      }
    }
  }
  const progressSingle =
    latest !== null && latest.batchesCompleted === 0 && latest.overdueRemaining > 0;
  const progressDeadline =
    latest !== null && latest.oldestOverdueAgeSeconds > RETENTION_OVERDUE_GRACE_SECONDS;
  return {
    stale: liveness || progressSingle || progressDeadline,
    liveness,
    progressSingle,
    progressDeadline,
  };
};

/** Group kinds in priority order, highest first. */
export const GROUP_KIND_PRIORITY = Object.freeze([
  "server_evidence_match",
  "same_account",
  "autofix_fingerprint",
] as const);
export type GroupKind = (typeof GROUP_KIND_PRIORITY)[number];

export const GROUP_MEMBER_CAP = 50;
export const PROMOTION_MOVES_PER_PASS_MAX = 50;

export type PromotionCandidate = {
  readonly kind: GroupKind;
  readonly groupCandidateKey: string;
  /** Memberships the move would create; at most `GROUP_MEMBER_CAP`. */
  readonly moves: number;
};

/**
 * Policy section 6. Candidates are ordered by kind priority (highest first),
 * then by `groupCandidateKey` ascending, and only the prefix whose cumulative
 * move count stays within the remaining pass budget is admitted. Comparing each
 * candidate alone against the budget let two 30-move candidates through a
 * 50-move budget together.
 */
export const allocatePromotionBudget = (
  candidates: readonly PromotionCandidate[],
  remainingBudget: number
) => {
  if (!Number.isSafeInteger(remainingBudget) || remainingBudget < 0) {
    throw new RangeError("remainingBudget must be a non-negative integer");
  }
  for (const candidate of candidates) {
    if (!GROUP_KIND_PRIORITY.includes(candidate.kind)) {
      throw new RangeError("unknown group kind");
    }
    if (!Number.isSafeInteger(candidate.moves) || candidate.moves < 1 || candidate.moves > GROUP_MEMBER_CAP) {
      throw new RangeError("a candidate moves between 1 and 50 members");
    }
  }
  const ordered = [...candidates].sort((a, b) => {
    const byKind = GROUP_KIND_PRIORITY.indexOf(a.kind) - GROUP_KIND_PRIORITY.indexOf(b.kind);
    if (byKind !== 0) return byKind;
    return a.groupCandidateKey < b.groupCandidateKey
      ? -1
      : a.groupCandidateKey > b.groupCandidateKey
        ? 1
        : 0;
  });
  const admitted: PromotionCandidate[] = [];
  const deferred: PromotionCandidate[] = [];
  let used = 0;
  for (const candidate of ordered) {
    // A prefix only: once one candidate is deferred, every later one is too.
    if (deferred.length === 0 && used + candidate.moves <= remainingBudget) {
      admitted.push(candidate);
      used += candidate.moves;
    } else {
      deferred.push(candidate);
    }
  }
  return { admitted, deferred, movesUsed: used, remainingAfter: remainingBudget - used };
};

/**
 * `SupportTriageRun` (policy sections 4 and 8): one row per run. The kinds and
 * outcomes below are the CHECK lists of migration
 * 20261003120000_support_triage_run; `npm run check:enum-constraints`
 * compares them.
 */
export const SUPPORT_TRIAGE_RUN_KINDS = Object.freeze(["worker", "retention"] as const);
export const SUPPORT_TRIAGE_RUN_OUTCOMES = Object.freeze([
  "running",
  "success",
  "partial",
  "failed",
  "deadline_exceeded",
] as const);
export type SupportTriageRunKind = (typeof SUPPORT_TRIAGE_RUN_KINDS)[number];
export type SupportTriageRunOutcome = (typeof SUPPORT_TRIAGE_RUN_OUTCOMES)[number];

/** A run row may be deleted only once it is this old; younger rows are immutable evidence. */
export const SUPPORT_TRIAGE_RUN_RETENTION_DAYS = 30;

/**
 * `SupportTriageSuggestion` (policy sections 1, 2 and 6). The lists and the
 * transition table below are the CHECK lists and the `-- transitions:` block
 * of migration 20261004010000_support_triage_suggestion; tests compare them.
 */
export const SUGGESTION_STATES = Object.freeze([
  "pending",
  "claimed",
  "ready",
  "accepted",
  "rejected",
  "expired",
  "superseded",
  "invalidated",
  "failed",
] as const);
export type SuggestionState = (typeof SUGGESTION_STATES)[number];

/** No transition leaves a terminal state. */
export const SUGGESTION_TERMINAL_STATES: readonly SuggestionState[] = Object.freeze([
  "accepted",
  "rejected",
  "expired",
  "superseded",
  "invalidated",
  "failed",
]);

export const SUGGESTION_TRANSITIONS: readonly (readonly [SuggestionState, SuggestionState])[] =
  Object.freeze([
    ["pending", "claimed"],
    // Lease reclaim: the claim token is cleared and the attempt counted.
    ["claimed", "pending"],
    ["claimed", "ready"],
    ["claimed", "failed"],
    ["ready", "accepted"],
    ["ready", "rejected"],
    ["ready", "expired"],
    ["ready", "superseded"],
    ["ready", "invalidated"],
    ["pending", "superseded"],
    ["claimed", "superseded"],
    ["pending", "invalidated"],
    ["claimed", "invalidated"],
    // A not_queued suggestion expires seven days after creation whatever its
    // state (policy section 5); one that never became ready has no lane.
    ["pending", "expired"],
    ["claimed", "expired"],
  ]);

export const isSuggestionTransitionAllowed = (from: SuggestionState, to: SuggestionState) =>
  SUGGESTION_TRANSITIONS.some(([a, b]) => a === from && b === to);

export const SUGGESTION_FAILURE_CODES = Object.freeze([
  "config_error",
  "internal_error",
  "retry_exhausted",
] as const);

/** Reclaims allowed before a claimed suggestion must fail as retry_exhausted. */
export const SUGGESTION_MAX_ATTEMPTS = 3;

/**
 * The lanes a suggestion proposes. Account and privacy reports go to
 * `trust_safety_human` with security, legal and self-harm reports
 * (operator decision 2026-10-03, design section 5.6); there is no separate
 * account lane.
 */
export const TRIAGE_LANES = Object.freeze([
  "bug_verified",
  "bug_unverified",
  "billing_human",
  "trust_safety_human",
  "feature_request",
  "other",
] as const);
export type TriageLane = (typeof TRIAGE_LANES)[number];

/** Codes from fixed per-locale keyword lists; a report's text never becomes anything else. */
export const KEYWORD_FLAGS = Object.freeze([
  "money",
  "account_privacy",
  "security",
  "legal",
  "self_harm_threat",
] as const);

export const OWNER_QUEUE_STATES = Object.freeze(["not_queued", "displayed"] as const);

/** A claim's lease, set by the database when a suggestion is claimed. */
export const SUGGESTION_LEASE_SECONDS = 5 * 60;

/**
 * `SupportTriageGroup` (policy section 6, design section 5.4). The lists and
 * the transition table below are the CHECK lists and the `-- transitions:`
 * block of migration 20261004020000_support_triage_group; tests compare them.
 * A group is one equivalence class of one kind (`GROUP_KIND_PRIORITY`).
 */
export const GROUP_STATES = Object.freeze([
  "candidate",
  "confirmed",
  "dismissed",
  "expired",
  "invalidated",
] as const);
export type GroupState = (typeof GROUP_STATES)[number];

/** Open groups hold members, signals and a primary snapshot digest; terminal ones hold none. */
export const GROUP_OPEN_STATES: readonly GroupState[] = Object.freeze(["candidate", "confirmed"]);
export const GROUP_TERMINAL_STATES: readonly GroupState[] = Object.freeze([
  "dismissed",
  "expired",
  "invalidated",
]);

export const GROUP_TRANSITIONS: readonly (readonly [GroupState, GroupState])[] = Object.freeze([
  // A person's decision.
  ["candidate", "confirmed"],
  ["candidate", "dismissed"],
  // Seven days not_queued, or the primary signal's snapshot expired.
  ["candidate", "expired"],
  // Fewer than two members, a key collision lost, or three deferred evaluations in a row.
  ["candidate", "invalidated"],
  ["confirmed", "invalidated"],
]);

export const isGroupTransitionAllowed = (from: GroupState, to: GroupState) =>
  GROUP_TRANSITIONS.some(([a, b]) => a === from && b === to);

/** A person's decision, kept apart from the state so an invalidated group keeps it. */
export const GROUP_DECISIONS = Object.freeze(["confirmed", "dismissed"] as const);

/** Where a signal's server value comes from; determined by its kind. */
export const SIGNAL_PROVENANCE: Readonly<Record<GroupKind, string>> = Object.freeze({
  server_evidence_match: "server_evidence",
  same_account: "account_derived",
  autofix_fingerprint: "autofix_derived",
});

/** Member ids a terminal group keeps as its key tombstone, at most one group's worth. */
export const GROUP_RETIRED_MEMBER_IDS_MAX = GROUP_MEMBER_CAP;

/** Consecutive deferred key evaluations that invalidate a group (policy section 6). */
export const GROUP_KEY_RECHECK_DEFERRAL_LIMIT = 3;
export const GROUP_KEY_TOMBSTONE_DAYS = 7;

/** The provenance classes a signal can carry; `SIGNAL_PROVENANCE` maps each kind to one. */
export const SIGNAL_PROVENANCE_CLASSES = Object.freeze([
  "server_evidence",
  "account_derived",
  "autofix_derived",
] as const);

/**
 * `SupportTriageDecisionRecord` (policy sections 5 and 6). The kinds are the
 * CHECK list of migration 20261005010000_support_triage_decision_record.
 */
export const DECISION_KINDS = Object.freeze([
  "suggestion_accepted",
  "suggestion_rejected",
  "group_confirmed",
  "group_dismissed",
  "sample_judged",
] as const);
export type DecisionKind = (typeof DECISION_KINDS)[number];

/** How long a decision record is kept (operator decision X2); a CHECK holds it. */
export const DECISION_RECORD_RETENTION_MONTHS = 12;

/** Reports one decision can be bound to: a group's members at most. */
export const DECISION_RECORD_LINKS_MAX = GROUP_MEMBER_CAP;

/**
 * Retention of the other deletable classes (policy section 5). A terminal
 * suggestion and a terminal group are kept 30 days after they became
 * terminal; a decision record carries its own `retentionUntil`.
 */
export const TERMINAL_SUGGESTION_RETENTION_DAYS = 30;
export const TERMINAL_GROUP_RETENTION_DAYS = 30;

/** The classes one retention batch deletes, one statement pair each, in this order. */
export const RETENTION_CLASSES = Object.freeze(["runs", "suggestions", "groups", "decisionRecords"] as const);
export type RetentionClass = (typeof RETENTION_CLASSES)[number];

/** Worker liveness (policy section 7): twice the 30-minute cadence plus 20 minutes. */
export const WORKER_LIVENESS_THRESHOLD_SECONDS = 80 * 60;

/**
 * The one bit the heartbeat route answers: the retention heartbeat, or, while
 * triage is enabled, a worker with no successful run within its threshold.
 * No successful run at all is stale (fail-closed, no grace). With triage
 * disabled the worker is not judged.
 */
export const supportTriageHeartbeatStale = (input: {
  readonly now: Date;
  readonly enabled: boolean;
  readonly retention: { readonly latestSuccessAt: Date | null; readonly latestFinished: RetentionRunFact | null };
  readonly workerLatestSuccessAt: Date | null;
}): boolean => {
  const retention = retentionHeartbeat({ now: input.now, ...input.retention });
  if (retention.stale) return true;
  if (!input.enabled) return false;
  if (input.workerLatestSuccessAt === null) return true;
  return (
    (validTime(input.now, "now") - validTime(input.workerLatestSuccessAt, "workerLatestSuccessAt")) / 1_000 >
    WORKER_LIVENESS_THRESHOLD_SECONDS
  );
};

/** Flags that send a report to the person-only trust and safety lane. */
export const TRUST_SAFETY_FLAGS = Object.freeze(["account_privacy", "security", "legal", "self_harm_threat"] as const);

/**
 * The lane a report is proposed for (policy section 1). Trust and safety
 * flags win over money, money or a billing report win over everything else,
 * and only then does the report's type decide; a bug is verified only when
 * the server verified its error report.
 */
export const triageLaneFor = (input: {
  readonly type: string;
  readonly keywordFlags: readonly string[];
  readonly errorReportVerification: string | null;
}): TriageLane => {
  if (input.keywordFlags.some((flag) => (TRUST_SAFETY_FLAGS as readonly string[]).includes(flag))) {
    return "trust_safety_human";
  }
  if (input.keywordFlags.includes("money") || input.type === "billing") return "billing_human";
  if (input.type === "bug") return input.errorReportVerification === "verified" ? "bug_verified" : "bug_unverified";
  if (input.type === "feature") return "feature_request";
  return "other";
};

/** The worker pass (design section 5.2): claim batches of 10, at most 50 reports per pass. */
export const WORKER_CLAIM_BATCH_SIZE = 10;
export const WORKER_PASS_MAX = 50;
/** Expired claims a pass returns to pending (or fails), at most. */
export const WORKER_RECLAIM_MAX = 50;
/** Reports a pass considers: still awaiting an operator. */
export const TRIAGE_ELIGIBLE_REPORT_STATUSES = Object.freeze(["open", "reviewing"] as const);
/** The message lib/accountDeletion.ts leaves on a deleted account's report. */
export const DELETED_ACCOUNT_MARKER = "[deleted account]";
