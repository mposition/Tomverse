/**
 * The engineering agent's deterministic core: every transition table, the mode
 * and switch reading, the owner queues, the halt and circuit decisions, and the
 * exact shape of what the publisher is allowed to write.
 *
 * docs/policy/engineering-agent.md is the contract. This module is pure: no
 * I/O, no clock of its own, no dependency outside the runtime. The runner and
 * publisher entry points may import it for that reason (§8), and the store
 * that lands in the next stage must generate its database triggers from the
 * tables here rather than restate them -- a transition written in two places is
 * a transition that will one day disagree with itself.
 *
 * Numbers marked "proposed" are the design's proposed values. The policy
 * (§16) fixes each of them by revision before the code enforcing it enters
 * shadow; until then they live here and nowhere else.
 */

/* ------------------------------------------------------------------------- */
/* Transition tables                                                          */
/* ------------------------------------------------------------------------- */

export type Transition<S extends string> = readonly [from: S, to: S];

export const isAllowedTransition = <S extends string>(
  table: readonly Transition<S>[],
  from: S,
  to: S,
) => table.some(([a, b]) => a === from && b === to);

export const ENGINEERING_AGENT_WORK_ITEM_KINDS = [
  "t2_draft",
  "publish",
  "expire_close",
  "prune",
  "decision",
  "state_mismatch",
] as const;
export type EngineeringAgentWorkItemKind =
  (typeof ENGINEERING_AGENT_WORK_ITEM_KINDS)[number];

/**
 * The three kinds of work item that write to GitHub: opening the pull request,
 * closing an expired one, and deleting a branch. Each write is irrevocable, so
 * all three share one shape -- a claim, a result that must carry the claim's
 * fencing token, and a lookup before anything is written a second time
 * (policy §10). They differ only in what their terminal states are called and
 * in what a write claim has to rest on.
 */
export const WRITE_ITEM_KINDS = ["publish", "expire_close", "prune"] as const;
export type WriteItemKind = (typeof WRITE_ITEM_KINDS)[number];

const WRITE_ITEM_TERMINALS = {
  publish: { success: "published", refused: "publish_refused", failed: "publish_failed" },
  expire_close: { success: "closed", refused: "expire_refused", failed: "expire_failed" },
  prune: { success: "pruned", refused: "prune_refused", failed: "prune_failed" },
} as const;

export type WriteItemState<K extends WriteItemKind = WriteItemKind> =
  | "queued"
  | "claimed"
  | "needs_lookup"
  | "outcome_unknown"
  | "expired"
  | (typeof WRITE_ITEM_TERMINALS)[K]["success" | "refused" | "failed"];

export const writeItemStates = <K extends WriteItemKind>(kind: K): WriteItemState<K>[] => {
  const terminals = WRITE_ITEM_TERMINALS[kind];
  return [
    "queued",
    "claimed",
    "needs_lookup",
    "outcome_unknown",
    ...(kind === "publish" ? (["expired"] as const) : []),
    terminals.success,
    terminals.refused,
    terminals.failed,
  ] as WriteItemState<K>[];
};

export const writeItemTerminalStates = <K extends WriteItemKind>(kind: K) => {
  const terminals = WRITE_ITEM_TERMINALS[kind];
  return [
    ...(kind === "publish" ? (["expired"] as const) : []),
    terminals.success,
    terminals.refused,
    terminals.failed,
  ] as WriteItemState<K>[];
};

/**
 * Every allowed transition of a write item of this kind, and the only place
 * they are written down. The store generates its trigger from this.
 *
 * - `queued -> claimed` is a write claim; `needs_lookup -> claimed` and
 *   `outcome_unknown -> claimed` are lookup-only claims that write nothing and
 *   consume no capability.
 * - A lease expiry sends `claimed` to `needs_lookup`, never back to `queued`.
 * - `claimed -> queued` is a write claim's refusal before any GitHub write, or
 *   a lookup that proved no earlier write happened. A consumed capability
 *   stays consumed (§10); the returned item's next write claim is judged
 *   again under a new capability, so a publish item holds several over its
 *   life, at most one of them live.
 * - Only an unclaimed publish item expires by TTL; the maintenance kinds are
 *   created when they are due and are not left waiting.
 */
export const writeItemTransitions = <K extends WriteItemKind>(
  kind: K,
): readonly Transition<WriteItemState<K>>[] => {
  const terminals = WRITE_ITEM_TERMINALS[kind];
  const table: Array<readonly [string, string]> = [
    ["queued", "claimed"],
    ["claimed", terminals.success],
    ["claimed", "queued"],
    ["claimed", terminals.refused],
    ["claimed", terminals.failed],
    ["claimed", "needs_lookup"],
    ["claimed", "outcome_unknown"],
    ["needs_lookup", "claimed"],
    ["outcome_unknown", "claimed"],
  ];
  if (kind === "publish") table.push(["queued", "expired"]);
  return table as unknown as readonly Transition<WriteItemState<K>>[];
};

/** The publish table, kept by name because the policy and the design cite it. */
export const PUBLISH_TRANSITIONS = writeItemTransitions("publish");
export const PUBLISH_STATES = writeItemStates("publish");
export const PUBLISH_TERMINAL_STATES = writeItemTerminalStates("publish");
export type PublishState = WriteItemState<"publish">;

/**
 * The three kinds of work item that wait on a person (policy §7, §12): a T2
 * draft waits for its decision, a decision item for acknowledgement, a state
 * mismatch for a person's fix. Each opens once and closes once; nothing
 * reopens it. A T2 draft and a decision item expire by the owner queue's TTL
 * (`QUEUE_TTL_DAYS.decision`); a state mismatch never does, because it halts
 * the agent until a person acts.
 */
export const OWNER_ITEM_KINDS = ["t2_draft", "decision", "state_mismatch"] as const;
export type OwnerItemKind = (typeof OWNER_ITEM_KINDS)[number];

const OWNER_ITEM_TABLES: Readonly<Record<OwnerItemKind, ReadonlyArray<readonly [string, string]>>> = {
  t2_draft: [
    ["open", "approved"],
    ["open", "rejected"],
    ["open", "expired"],
  ],
  decision: [
    ["open", "acknowledged"],
    ["open", "expired"],
  ],
  state_mismatch: [["open", "resolved"]],
};

/** A T2 decision's two answers (policy §7); the approval table allows no other. */
export const ENGINEERING_AGENT_T2_DECISIONS = ["approved", "rejected"] as const;

export const ownerItemTransitions = (kind: OwnerItemKind): readonly Transition<string>[] =>
  OWNER_ITEM_TABLES[kind];

export const ownerItemStates = (kind: OwnerItemKind): string[] => [
  "open",
  ...OWNER_ITEM_TABLES[kind].map(([, to]) => to),
];

const isWriteItemKind = (kind: EngineeringAgentWorkItemKind): kind is WriteItemKind =>
  (WRITE_ITEM_KINDS as readonly string[]).includes(kind);

/** Every state of a work item of any kind: the table the store's trigger is checked against. */
export const workItemStates = (kind: EngineeringAgentWorkItemKind): string[] =>
  isWriteItemKind(kind) ? writeItemStates(kind) : ownerItemStates(kind);

/** Every transition of a work item of any kind: the table the store's trigger is checked against. */
export const workItemTransitions = (kind: EngineeringAgentWorkItemKind): readonly Transition<string>[] =>
  isWriteItemKind(kind) ? writeItemTransitions(kind) : ownerItemTransitions(kind);

/** The state a work item of this kind is created in. */
export const workItemInitialState = (kind: EngineeringAgentWorkItemKind) =>
  isWriteItemKind(kind) ? "queued" : "open";

/**
 * How a write item was claimed. A write claim may write; a lookup claim exists
 * only to find out what an earlier claim did, and writes nothing.
 */
export const WRITE_CLAIM_MODES = ["write", "lookup"] as const;
export type WriteClaimMode = (typeof WRITE_CLAIM_MODES)[number];

/** What a write claim of each kind has to rest on, all in the claim transaction. */
export type WriteClaimPrecondition =
  | { kind: "publish"; capabilityConsumed: boolean }
  | {
      kind: "expire_close";
      /** The binding (number, run id, head) re-read and unchanged. */
      bindingMatches: boolean;
      /** Expiry recomputed from owner activity at claim time. */
      stillExpired: boolean;
    }
  | {
      kind: "prune";
      /** The branch's ref oid equals the recorded sha. */
      refMatchesRecorded: boolean;
      /**
       * Either the PR is closed or merged, or -- for a branch left by a failed
       * PR creation -- a lookup read the full PR list and found none.
       */
      prClosedOrConfirmedAbsent: boolean;
    };

/**
 * The outcome a result reports. The first group ends a write claim; the second
 * ends a lookup claim; `lookup_impossible` can end either -- a write whose
 * result is unknown looks first, and when looking fails it stops there.
 */
export type WriteResultOutcome =
  | "confirmed"
  | "refused_before_write"
  | "revalidation_refused"
  | "write_rejected"
  | "pr_create_rejected"
  | "lookup_no_prior_write"
  | "lookup_found_result"
  | "lookup_impossible";

export type WriteTransitionContext =
  | { event: "claim"; mode: "write"; precondition: WriteClaimPrecondition }
  | { event: "claim"; mode: "lookup"; capabilityConsumed: boolean }
  | { event: "expire_ttl" }
  | { event: "lease_expired" }
  | {
      event: "result";
      claimMode: WriteClaimMode;
      fencingMatches: boolean;
      outcome: WriteResultOutcome;
      /**
       * Whether the capability this result rests on has been consumed: for a
       * write claim, by this claim; for a lookup claim, by an earlier write
       * claim. Only a publish item has capabilities; for the others it is false.
       */
      capabilityConsumed: boolean;
    };

export type TransitionVerdict = { allowed: true } | { allowed: false; reason: string };

const refuse = (reason: string): TransitionVerdict => ({ allowed: false, reason });

const resultTarget = (
  kind: WriteItemKind,
  mode: WriteClaimMode,
  outcome: WriteResultOutcome,
  capabilityConsumed: boolean,
): string | null => {
  const target = unconditionalResultTarget(kind, mode, outcome);
  if (kind !== "publish" || target === null) return target;
  const terminals = WRITE_ITEM_TERMINALS.publish;
  // Nothing is published without a consumed capability. A return to the
  // queue leaves a consumed one consumed; the next claim needs a new one.
  if (target === terminals.success && !capabilityConsumed) return null;
  return target;
};

const unconditionalResultTarget = (
  kind: WriteItemKind,
  mode: WriteClaimMode,
  outcome: WriteResultOutcome,
): string | null => {
  const terminals = WRITE_ITEM_TERMINALS[kind];
  if (mode === "write") {
    switch (outcome) {
      case "confirmed":
        return terminals.success;
      case "refused_before_write":
        return "queued";
      case "revalidation_refused":
        return terminals.refused;
      case "write_rejected":
        // A rejected push leaves nothing behind, so it is a refusal; a rejected
        // close or delete leaves the binding in place, so it is a failure.
        return kind === "publish" ? terminals.refused : terminals.failed;
      case "pr_create_rejected":
        // The branch is already there; the prune that follows looks first.
        return kind === "publish" ? terminals.failed : null;
      case "lookup_impossible":
        return "outcome_unknown";
      default:
        return null;
    }
  }
  switch (outcome) {
    case "lookup_no_prior_write":
      return "queued";
    case "lookup_found_result":
      return terminals.success;
    case "lookup_impossible":
      return "outcome_unknown";
    default:
      return null;
  }
};

const writePreconditionHolds = (
  kind: WriteItemKind,
  precondition: WriteClaimPrecondition,
): string | null => {
  if (precondition.kind !== kind) return "precondition_for_another_kind";
  switch (precondition.kind) {
    case "publish":
      return precondition.capabilityConsumed ? null : "write_claim_requires_capability_consumption";
    case "expire_close":
      if (!precondition.bindingMatches) return "binding_changed";
      return precondition.stillExpired ? null : "no_longer_expired";
    case "prune":
      if (!precondition.refMatchesRecorded) return "ref_not_recorded_sha";
      return precondition.prClosedOrConfirmedAbsent ? null : "pr_not_closed_or_absence_unconfirmed";
  }
};

/**
 * The table with its conditions. The pair must be in the kind's table, and the
 * event must be one that pair may rest on. Every result must carry the claim's
 * fencing token; a stale token decides nothing.
 */
export const decideWriteItemTransition = <K extends WriteItemKind>(
  kind: K,
  from: WriteItemState<K>,
  to: WriteItemState<K>,
  context: WriteTransitionContext,
): TransitionVerdict => {
  if (!isAllowedTransition(writeItemTransitions(kind), from, to)) {
    return refuse("transition_not_in_table");
  }

  switch (context.event) {
    case "claim": {
      if (to !== "claimed") return refuse("claim_must_enter_claimed");
      if (context.mode === "write") {
        if (from !== "queued") return refuse("write_claim_only_from_queued");
        const problem = writePreconditionHolds(kind, context.precondition);
        return problem === null ? { allowed: true } : refuse(problem);
      }
      if (from !== "needs_lookup" && from !== "outcome_unknown") {
        return refuse("lookup_claim_only_after_unknown_outcome");
      }
      return context.capabilityConsumed
        ? refuse("lookup_claim_must_not_consume_capability")
        : { allowed: true };
    }
    case "expire_ttl":
      return from === "queued" && to === "expired"
        ? { allowed: true }
        : refuse("ttl_expiry_only_from_queued");
    case "lease_expired":
      return from === "claimed" && to === "needs_lookup"
        ? { allowed: true }
        : refuse("lease_expiry_only_to_needs_lookup");
    case "result": {
      if (from !== "claimed") return refuse("result_only_from_claimed");
      if (!context.fencingMatches) return refuse("stale_fencing_token");
      if (kind !== "publish" && context.capabilityConsumed) {
        return refuse("only_a_publish_item_has_a_capability");
      }
      const expected = resultTarget(
        kind,
        context.claimMode,
        context.outcome,
        context.capabilityConsumed,
      );
      if (expected === null) return refuse("outcome_not_valid_for_claim_mode");
      return expected === to ? { allowed: true } : refuse("outcome_does_not_lead_to_target");
    }
  }
};

/**
 * Entering `outcome_unknown` hands the item to a person in the same
 * transaction (policy §10). Lookups continue once a round, read-only, and a
 * lookup that settles the result closes the decision with it.
 */
export const opensDecisionOnEntry = (to: string) => to === "outcome_unknown";

/**
 * The cause key of the decision item an entry into `outcome_unknown` opens:
 * one per item and claim, so a later entry opens its own. The migration builds
 * the same key in a deferred trigger and refuses the commit without it.
 */
export const UNKNOWN_OUTCOME_DECISION_CAUSE_PREFIX = "unknown:";
export const unknownOutcomeDecisionCauseKey = (workItemId: string, fencingToken: bigint | number) =>
  `${UNKNOWN_OUTCOME_DECISION_CAUSE_PREFIX}${workItemId}:${fencingToken}`;

/**
 * The cause key of the decision item a partial registration opens (§12,
 * "등록 결과 불명"). The owner queue counts that item, not the registration.
 */
export const PARTIAL_REGISTRATION_DECISION_CAUSE_PREFIX = "registration:";
export const partialRegistrationDecisionCauseKey = (registrationId: string) =>
  `${PARTIAL_REGISTRATION_DECISION_CAUSE_PREFIX}${registrationId}`;

/**
 * A branch left behind by a PR creation that GitHub rejected is only ever
 * pruned after a lookup read the whole PR list for its head and found none.
 */
export const mayQueuePruneAfterFailedPublish = (lookup: {
  listReadToEnd: boolean;
  pullRequestsForHead: number;
}) => lookup.listReadToEnd && lookup.pullRequestsForHead === 0;

export const RUN_STATUSES = ["active", "finished", "abandoned"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRANSITIONS: readonly Transition<RunStatus>[] = [
  ["active", "finished"],
  ["active", "abandoned"],
] as const;

export const RUN_OUTCOMES = [
  "t1_queued",
  "t2_draft",
  "private_result",
  "no_change",
  "agent_failed",
  "schema_invalid",
  "scope_violation",
  "secret_detected",
  "abandoned",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** v22 settlement alone records private_result; the legacy runner cannot
 * assert that an encrypted Task result exists. */
export const RUNNER_REPORTABLE_OUTCOMES = RUN_OUTCOMES.filter(
  (outcome) => outcome !== "abandoned" && outcome !== "private_result",
) as [Exclude<RunOutcome, "abandoned" | "private_result">,
  ...Exclude<RunOutcome, "abandoned" | "private_result">[]];

/** A v22 Task has at most one publication product. A private result is not
 * misreported as a draft, and an owner draft is not misreported as a PR. */
export const v22RunOutcomeForProduct = (input: {
  taskOutcome: "succeeded" | "failed" | "blocked";
  productKind: string | null;
}): RunOutcome => {
  if (input.productKind !== null && input.productKind !== "publish" &&
      input.productKind !== "t2_draft")
    throw new Error("v22 publication product kind invalid");
  if (input.productKind && input.taskOutcome !== "succeeded")
    throw new Error("v22 publication product without successful result");
  if (input.productKind === "publish") return "t1_queued";
  if (input.productKind === "t2_draft") return "t2_draft";
  return input.taskOutcome === "succeeded" ? "private_result" : "agent_failed";
};

/** How a run's outcome settles the AMUX attempt it is bound to. */
export const AMUX_SETTLEMENT_FOR_OUTCOME: Readonly<
  Record<RunOutcome, "review" | "retry" | "blocked" | null>
> = {
  t1_queued: "review",
  t2_draft: "review",
  private_result: "review",
  no_change: "blocked",
  agent_failed: "retry",
  schema_invalid: "blocked",
  scope_violation: "blocked",
  secret_detected: "blocked",
  // A lease that ran out is AMUX's to recover; the agent does not settle it.
  abandoned: null,
};

export const BINDING_STATES = ["open", "closed", "pruned"] as const;
export type BindingState = (typeof BINDING_STATES)[number];

export const BINDING_TRANSITIONS: readonly Transition<BindingState>[] = [
  ["open", "closed"],
  ["closed", "pruned"],
] as const;

export const REQUEST_STATES = [
  "accepted",
  "in_progress",
  "committed",
  "aborted",
] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

/**
 * Internal request idempotency (policy §10). `in_progress` may stay visible
 * indefinitely because a COMMIT can land late; nothing here moves it on a
 * timer.
 */
export const REQUEST_TRANSITIONS: readonly Transition<RequestState>[] = [
  ["accepted", "in_progress"],
  ["accepted", "aborted"],
  ["in_progress", "committed"],
  ["in_progress", "aborted"],
] as const;

export const REGISTRATION_RESULTS = [
  "pending",
  "registered",
  "registration_refused",
  "absent",
  "partial",
] as const;
export type RegistrationResult = (typeof REGISTRATION_RESULTS)[number];

/**
 * A registration result is written once. `pending` only exists between the
 * guard passing and the AMUX writer answering; an unclear answer is resolved
 * by AMUX's read-back into `absent` or `partial`, never by a retry.
 *
 * `partial` opens an owner decision item in the same transaction. It is
 * resolved -- to the card that turned out to exist, or to its confirmed
 * absence -- only after that item has been acknowledged or has expired, and
 * the resolution is recorded beside the first answer, not over it.
 */
export const REGISTRATION_TRANSITIONS: readonly Transition<RegistrationResult>[] = [
  ["pending", "registered"],
  ["pending", "registration_refused"],
  ["pending", "absent"],
  ["pending", "partial"],
  ["partial", "registered"],
  ["partial", "absent"],
] as const;

/* ------------------------------------------------------------------------- */
/* Mode and switches                                                          */
/* ------------------------------------------------------------------------- */

/**
 * The approved policy version this code implements (docs/policy/engineering-agent.md,
 * "정책 버전"). A capability records it at issue and is consumed only while it
 * is still current; tests/engineeringAgentStore.test.mjs compares it with the
 * policy header, so a new policy version cannot go unnoticed.
 */
export const ENGINEERING_AGENT_POLICY_VERSION = 4;

/**
 * Why an approval observation is not an approval (§9-10). The binding's JSON
 * CHECK lists the same values; tests/engineeringAgentSchema.test.mjs compares.
 */
export const ENGINEERING_AGENT_NOT_APPROVED_REASONS = [
  "base_not_develop",
  "head_not_verified",
  "required_check_failed",
  "no_authorised_review",
  "review_not_valid",
  "snapshot_changed",
  "review_before_snapshot",
  "merged_without_approval",
] as const;

/** Who merged, as a kind and never as an identity (§9-10: the merger is an observation only). */
export const ENGINEERING_AGENT_MERGER_KINDS = ["user", "bot", "app", "unknown"] as const;

export const ENGINEERING_AGENT_MODE_SETTING_KEY = "feature.engineeringAgentMode";
export const ENGINEERING_AGENT_FREEZE_SETTING_KEY = "feature.engineeringAgentFreeze";
export const ENGINEERING_AGENT_REGISTRATION_SETTING_KEY =
  "feature.engineeringAgentRegistration";
export const ENGINEERING_AGENT_KILL_SWITCH_ENV = "ENGINEERING_AGENT_KILL_SWITCH";

/**
 * Instants the app keeps beside the switches, each written by one recorded
 * act: the Admin acknowledgement that clears a halt (§12), each
 * service's report that a cycle ran to its end, and the operator's record that
 * both dead-man monitors are active and alerting (the armed gate, §12). An
 * absent or unparseable value is no record at all.
 */
export const ENGINEERING_AGENT_HALT_ACKNOWLEDGED_SETTING_KEY = "engineeringAgent.haltAcknowledgedAt";
export const ENGINEERING_AGENT_RUNNER_LAST_FINISH_SETTING_KEY = "engineeringAgent.runnerLastFinishAt";
export const ENGINEERING_AGENT_PUBLISHER_LAST_FINISH_SETTING_KEY = "engineeringAgent.publisherLastFinishAt";
export const ENGINEERING_AGENT_MONITORS_CONFIRMED_SETTING_KEY = "engineeringAgent.monitorsConfirmedAt";
/**
 * The latest unbound pull request or ref the runner observed outside a run,
 * as `{"halt":"unbound_app_pr","at":"<ISO instant>"}`. It halts like a halt a
 * run recorded, until a person acknowledges it (§12).
 */
export const ENGINEERING_AGENT_OBSERVED_HALT_SETTING_KEY = "engineeringAgent.observedHalt";

/** The halts an observation outside a run may record: what only GitHub shows. */
export const OBSERVABLE_HALTS = ["unbound_app_pr", "unbound_app_ref"] as const;
export type ObservableHalt = (typeof OBSERVABLE_HALTS)[number];

const SETTING_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

/** A stored instant, in exactly the form `Date.prototype.toISOString` writes, or no record. */
export const parseSettingInstant = (raw: string | null | undefined): Date | null => {
  if (typeof raw !== "string" || !SETTING_INSTANT.test(raw)) return null;
  const at = new Date(raw);
  return Number.isNaN(at.getTime()) ? null : at;
};

export const ENGINEERING_AGENT_MODES = ["off", "shadow", "t1"] as const;
export type EngineeringAgentMode = (typeof ENGINEERING_AGENT_MODES)[number];

/** Unset, unknown or unreadable is `off` (policy §11). */
export const parseEngineeringAgentMode = (
  raw: string | null | undefined,
): EngineeringAgentMode =>
  (ENGINEERING_AGENT_MODES as readonly string[]).includes(raw ?? "")
    ? (raw as EngineeringAgentMode)
    : "off";

/** Only the exact string `"true"` / `"on"` turns a boolean switch on. */
const switchOn = (raw: string | null | undefined, onValue: string) =>
  raw === onValue;

export type SwitchReading = {
  mode: string | null | undefined;
  freeze: string | null | undefined;
  registration: string | null | undefined;
  killSwitch: string | null | undefined;
  /** Any setting that could not be read at all. */
  readFailed: boolean;
};

export type EffectiveSwitches = {
  mode: EngineeringAgentMode;
  frozen: boolean;
  /** Claim a promoted card for a work run. */
  claimAllowed: boolean;
  /** Publish a T1 result. In `shadow` a T1 result ends as a T2 draft. */
  publishAllowed: boolean;
  /** Register cards into the AMUX backlog. */
  registrationAllowed: boolean;
  /** Expiry close, prune and observation keep running while frozen. */
  maintenanceAllowed: boolean;
};

/** Anything set other than empty, `0` or `false` engages the kill switch. */
export const killSwitchEngaged = (raw: string | null | undefined): boolean =>
  raw !== undefined && raw !== null && raw !== "" && raw !== "0" && raw.toLowerCase() !== "false";

export const resolveEngineeringAgentSwitches = (
  reading: SwitchReading,
): EffectiveSwitches => {
  const killed = killSwitchEngaged(reading.killSwitch);
  const mode =
    reading.readFailed || killed ? "off" : parseEngineeringAgentMode(reading.mode);
  // A freeze that cannot be read is a freeze.
  const frozen = reading.readFailed || switchOn(reading.freeze, "true");
  const on = mode !== "off";

  return {
    mode,
    frozen,
    claimAllowed: on && !frozen,
    publishAllowed: mode === "t1" && !frozen,
    registrationAllowed:
      on && !frozen && switchOn(reading.registration, "on"),
    maintenanceAllowed: on,
  };
};

/* ------------------------------------------------------------------------- */
/* Owner queues                                                               */
/* ------------------------------------------------------------------------- */

/** Proposed values; the owner-facing total is fixed by the policy at 5 (§12). */
export const OWNER_QUEUE_LIMITS = {
  pr: 2,
  prDuringFirstT1Days: 1,
  decision: 3,
} as const;
export const OWNER_QUEUE_TOTAL = OWNER_QUEUE_LIMITS.pr + OWNER_QUEUE_LIMITS.decision;
export const FIRST_T1_WINDOW_DAYS = 14;
export const QUEUE_TTL_DAYS = { pr: 14, decision: 7 } as const;

const DAY_MS = 24 * 60 * 60 * 1000;

export type QueueReading = {
  /** Bindings with an open PR or a remaining branch. */
  openPrBindings: number;
  /**
   * Open decision work items: T2 drafts, mismatches, and the decision items
   * opened for repeated failures, observation failures, unknown write
   * outcomes and partial registrations.
   */
  pendingDecisions: number;
  /**
   * When the first run that started under mode `t1` started (the earliest
   * EngineeringAgentRun whose `modeAtStart` is `t1`), or null if none has.
   * That is never earlier than the mode change, so the window it opens is
   * never shorter than the policy's.
   */
  t1StartedAt: Date | null;
  now: Date;
};

export type QueueVerdict = {
  prLimit: number;
  prFull: boolean;
  decisionFull: boolean;
  /** A card is claimed only when both queues have room (policy §2.1, §12). */
  claimAllowed: boolean;
};

export const decideOwnerQueues = (reading: QueueReading): QueueVerdict => {
  const inFirstWindow =
    reading.t1StartedAt !== null &&
    reading.now.getTime() - reading.t1StartedAt.getTime() <
      FIRST_T1_WINDOW_DAYS * DAY_MS;
  const prLimit = inFirstWindow
    ? OWNER_QUEUE_LIMITS.prDuringFirstT1Days
    : OWNER_QUEUE_LIMITS.pr;
  const prFull = reading.openPrBindings >= prLimit;
  const decisionFull = reading.pendingDecisions >= OWNER_QUEUE_LIMITS.decision;
  return { prLimit, prFull, decisionFull, claimAllowed: !prFull && !decisionFull };
};

/* ------------------------------------------------------------------------- */
/* Halt and circuit                                                           */
/* ------------------------------------------------------------------------- */

export const HALT_VALUES = [
  "none",
  "config_missing",
  "circuit_open",
  "unbound_app_pr",
  "unbound_app_ref",
  "state_mismatch",
] as const;
export type HaltValue = (typeof HALT_VALUES)[number];

export type HaltReading = {
  /** Publisher App bot login and registration time are both configured. */
  appIdentityConfigured: boolean;
  circuitLatched: boolean;
  unboundAppPrs: number;
  unboundAppRefs: number;
  openStateMismatches: number;
};

/**
 * One halt value, in the policy's priority. A missing App identity is never
 * `none`: without it the unbound checks cannot run, and a check that cannot
 * run is not a check that passed.
 */
/** The policy's priority among halts, highest first (the order decideHalt tests them in). */
export const HALT_PRIORITY: readonly HaltValue[] = [
  "config_missing",
  "circuit_open",
  "unbound_app_pr",
  "unbound_app_ref",
  "state_mismatch",
  "none",
];

export const higherHalt = (a: HaltValue, b: HaltValue): HaltValue =>
  HALT_PRIORITY.indexOf(a) <= HALT_PRIORITY.indexOf(b) ? a : b;

export const decideHalt = (reading: HaltReading): HaltValue => {
  if (!reading.appIdentityConfigured) return "config_missing";
  if (reading.circuitLatched) return "circuit_open";
  if (reading.unboundAppPrs > 0) return "unbound_app_pr";
  if (reading.unboundAppRefs > 0) return "unbound_app_ref";
  if (reading.openStateMismatches > 0) return "state_mismatch";
  return "none";
};

/**
 * What a runner may report when its run ends: the readings only it can make
 * -- the publisher App's identity, unbound App pull requests and refs. A
 * latched circuit and an open state mismatch are the app's to read, never a
 * runner's to assert: one report of `circuit_open` would otherwise latch the
 * circuit without the repeated failures that are its definition (§12).
 */
export const RUNNER_REPORTABLE_HALTS = ["none", "config_missing", "unbound_app_pr", "unbound_app_ref"] as const;
export type RunnerReportableHalt = (typeof RUNNER_REPORTABLE_HALTS)[number];

/**
 * The halt a run ends with: the runner's report combined with what the app
 * holds, in the policy's priority, so a report of `none` can never lower a
 * halt the app can see.
 */
export const combineRunHalt = (input: {
  reported: RunnerReportableHalt;
  circuitLatched: boolean;
  openStateMismatches: number;
}): HaltValue =>
  decideHalt({
    appIdentityConfigured: input.reported !== "config_missing",
    circuitLatched: input.circuitLatched,
    unboundAppPrs: input.reported === "unbound_app_pr" ? 1 : 0,
    unboundAppRefs: input.reported === "unbound_app_ref" ? 1 : 0,
    openStateMismatches: input.openStateMismatches,
  });

export const CIRCUIT_WINDOW_DAYS = 30;
export const CIRCUIT_INCIDENT_LIMIT = 3;

export type TerminatedRun = {
  startedAt: Date;
  endedAt: Date;
  halt: HaltValue;
};

/**
 * Whether the circuit is latched. Runs are counted from the app's own run rows,
 * which a trigger keeps from being edited or deleted.
 *
 * - Runs that started before the last acknowledgement are ignored.
 * - An incident starts at a terminated run whose halt is not `none` and whose
 *   previous terminated run was `none` or does not exist, so one long halt is
 *   one incident rather than one per run.
 * - Three incident starts that ever fell within thirty days of each other since
 *   the acknowledgement latch it, and so does the latest terminated run already
 *   being `circuit_open`.
 *
 * Only an acknowledgement in the Admin console clears it. The passage of time
 * does not: incidents that latched the circuit keep it latched however old they
 * become, which is why this takes no clock.
 */
export const isCircuitLatched = (input: {
  runs: readonly TerminatedRun[];
  acknowledgedAt: Date | null;
}): boolean => {
  const considered = input.runs
    .filter(
      (run) =>
        input.acknowledgedAt === null ||
        run.startedAt.getTime() >= input.acknowledgedAt.getTime(),
    )
    .slice()
    .sort((a, b) => a.endedAt.getTime() - b.endedAt.getTime());

  if (considered.length === 0) return false;
  if (considered[considered.length - 1].halt === "circuit_open") return true;

  const starts: number[] = [];
  considered.forEach((run, index) => {
    if (run.halt === "none") return;
    const previous = index === 0 ? null : considered[index - 1];
    if (previous === null || previous.halt === "none") starts.push(run.endedAt.getTime());
  });
  const windowMs = CIRCUIT_WINDOW_DAYS * DAY_MS;
  for (let i = CIRCUIT_INCIDENT_LIMIT - 1; i < starts.length; i += 1) {
    if (starts[i] - starts[i - (CIRCUIT_INCIDENT_LIMIT - 1)] <= windowMs) return true;
  }
  return false;
};

/**
 * A success heartbeat goes out only when the run finished and nothing is
 * halted. Mode `off`, a freeze or the kill switch still send it -- the monitor
 * watches whether the service is alive, not whether it did work (policy §12).
 */
/**
 * A halt value the app reported to a service, or `unknown` when it reported
 * none it knows -- never `none` by default, because `none` is what lets a
 * success signal out (§12).
 */
export const reportedHalt = (value: unknown): HaltValue | "unknown" =>
  typeof value === "string" && (HALT_VALUES as readonly string[]).includes(value) ? (value as HaltValue) : "unknown";

/**
 * The success signal after a round: the round finished, the halt the round
 * saw was none, and the halt read again after the round -- right before the
 * signal -- is none too (§12, §13-17).
 */
export const finalSignalIsSuccess = (input: {
  finishedNormally: boolean;
  roundHalt: HaltValue | "unknown";
  haltAfter: HaltValue | "unknown";
}) => input.finishedNormally && input.roundHalt === "none" && input.haltAfter === "none";

export const shouldSendSuccessHeartbeat = (input: {
  finishedNormally: boolean;
  halt: HaltValue;
}) => input.finishedNormally && input.halt === "none";

/* ------------------------------------------------------------------------- */
/* Armed gate                                                                 */
/* ------------------------------------------------------------------------- */

export const ARMED_GATE_LAST_FINISH_HOURS = 26;
export const ARMED_GATE_MONITOR_CONFIRMATION_DAYS = 7;

export type ArmedGateReading = {
  runnerLastFinishAt: Date | null;
  publisherLastFinishAt: Date | null;
  /** The operator's record that both monitors are active and alerting. */
  monitorsConfirmedAt: Date | null;
  now: Date;
};

export type ArmedGateVerdict =
  | { armed: true }
  | {
      armed: false;
      missing: Array<"runner_finish" | "publisher_finish" | "monitor_confirmation">;
    };

/** Turning the mode on from `off` passes this gate (policy §12). */
export const decideArmedGate = (reading: ArmedGateReading): ArmedGateVerdict => {
  const now = reading.now.getTime();
  const recent = (at: Date | null, ms: number) =>
    at !== null && now - at.getTime() <= ms && at.getTime() <= now;
  const missing: Array<"runner_finish" | "publisher_finish" | "monitor_confirmation"> =
    [];
  const finishMs = ARMED_GATE_LAST_FINISH_HOURS * 60 * 60 * 1000;
  if (!recent(reading.runnerLastFinishAt, finishMs)) missing.push("runner_finish");
  if (!recent(reading.publisherLastFinishAt, finishMs)) {
    missing.push("publisher_finish");
  }
  if (
    !recent(reading.monitorsConfirmedAt, ARMED_GATE_MONITOR_CONFIRMATION_DAYS * DAY_MS)
  ) {
    missing.push("monitor_confirmation");
  }
  return missing.length === 0 ? { armed: true } : { armed: false, missing };
};

/* ------------------------------------------------------------------------- */
/* What the publisher may write                                               */
/* ------------------------------------------------------------------------- */

const RUN_ID = /^[0-9]{1,12}$/;
const CARD_REF = /^[A-Za-z0-9_-]{1,64}$/;
const SHA1 = /^[0-9a-f]{40}$/;

export const BRANCH_NAMESPACE = "agent/engineering/";

export const isRunId = (value: string) => RUN_ID.test(value);

/** `agent/engineering/<runId>`. Never carries a `to-develop` segment (policy §9-3). */
export const engineeringBranchName = (runId: string) => {
  if (!isRunId(runId)) throw new Error("ENGINEERING_AGENT_RUN_ID_INVALID");
  return `${BRANCH_NAMESPACE}${runId}`;
};

export const parseEngineeringBranchName = (ref: string): string | null => {
  const name = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref;
  if (!name.startsWith(BRANCH_NAMESPACE)) return null;
  const runId = name.slice(BRANCH_NAMESPACE.length);
  return isRunId(runId) ? runId : null;
};

export const prBodyMarker = (runId: string) => {
  if (!isRunId(runId)) throw new Error("ENGINEERING_AGENT_RUN_ID_INVALID");
  return `<!-- engineering-agent run=${runId} -->`;
};

export const expireCommentMarker = (runId: string, prNumber: number) => {
  if (!isRunId(runId)) throw new Error("ENGINEERING_AGENT_RUN_ID_INVALID");
  if (!Number.isSafeInteger(prNumber) || prNumber <= 0) {
    throw new Error("ENGINEERING_AGENT_PR_NUMBER_INVALID");
  }
  return `<!-- engineering-agent expire run=${runId} pr=${prNumber} -->`;
};

/** The PR body's first line must be exactly the marker for this run. */
export const prBodyCarriesMarker = (body: string, runId: string) =>
  body.split("\n", 1)[0] === prBodyMarker(runId);

export type CommitIdentity = { name: string; email: string };

/**
 * The one identity a published commit carries, as author and committer. The
 * app issues capabilities with it and the publisher builds commits with it; a
 * commit object is compared byte for byte, so a second copy of these strings
 * anywhere is a mismatch waiting to happen.
 */
export const ENGINEERING_AGENT_COMMIT_IDENTITY: CommitIdentity = Object.freeze({
  name: "Tomverse Engineering Agent",
  email: "engineering-agent@users.noreply.github.com",
});

export type ExpectedCommit = {
  tree: string;
  baseSha: string;
  identity: CommitIdentity;
  /** The base commit's committer timestamp and zone, e.g. `1759000000 +1000`. */
  baseCommitterDate: string;
  runId: string;
  cardRef: string;
};

const IDENTITY_PART = /^[^<>\n\r\0]{1,100}$/;
const DATE = /^[0-9]{1,12} [+-][0-9]{4}$/;

/**
 * The only commit object the publisher may push: fields come from their named
 * sources and nowhere else (policy §9-8). No signature, one parent, a fixed
 * message.
 */
export const expectedCommitObject = (expected: ExpectedCommit): string => {
  if (!SHA1.test(expected.tree)) throw new Error("ENGINEERING_AGENT_TREE_INVALID");
  if (!SHA1.test(expected.baseSha)) throw new Error("ENGINEERING_AGENT_BASE_INVALID");
  if (
    !IDENTITY_PART.test(expected.identity.name) ||
    !IDENTITY_PART.test(expected.identity.email)
  ) {
    throw new Error("ENGINEERING_AGENT_IDENTITY_INVALID");
  }
  if (!DATE.test(expected.baseCommitterDate)) {
    throw new Error("ENGINEERING_AGENT_DATE_INVALID");
  }
  if (!isRunId(expected.runId)) throw new Error("ENGINEERING_AGENT_RUN_ID_INVALID");
  if (!CARD_REF.test(expected.cardRef)) {
    throw new Error("ENGINEERING_AGENT_CARD_REF_INVALID");
  }
  const person = `${expected.identity.name} <${expected.identity.email}> ${expected.baseCommitterDate}`;
  return [
    `tree ${expected.tree}`,
    `parent ${expected.baseSha}`,
    `author ${person}`,
    `committer ${person}`,
    "",
    `engineering-agent: run ${expected.runId}`,
    "",
    `Card: ${expected.cardRef}`,
    "",
  ].join("\n");
};

/**
 * Compares `git cat-file -p <commit>` output with the expected object, byte for
 * byte. Anything extra -- a second parent, a gpgsig header, a trailer, an
 * encoding header -- is a mismatch.
 */
export const commitObjectMatches = (catFileOutput: string, expected: ExpectedCommit) =>
  catFileOutput === expectedCommitObject(expected);
