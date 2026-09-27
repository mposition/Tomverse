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

const pairKey = (from: string, to: string) => `${from}\u0000${to}`;

const transitionSet = <S extends string>(table: readonly Transition<S>[]) =>
  new Set(table.map(([from, to]) => pairKey(from, to)));

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

export const PUBLISH_STATES = [
  "queued",
  "claimed",
  "needs_lookup",
  "published",
  "publish_refused",
  "publish_failed",
  "outcome_unknown",
  "expired",
] as const;
export type PublishState = (typeof PUBLISH_STATES)[number];

/**
 * How a publish item was claimed. A write claim consumed a capability; a
 * lookup claim did not, may not write, and exists only to find out what an
 * earlier claim did (policy §10).
 */
export const PUBLISH_CLAIM_MODES = ["write", "lookup"] as const;
export type PublishClaimMode = (typeof PUBLISH_CLAIM_MODES)[number];

/**
 * Every allowed transition of a publish work item, and the only place they are
 * written down. `claimed` is split by claim mode below because the same pair
 * (`claimed -> queued`) means two different things: a write claim that refused
 * before writing, and a lookup claim that proved no earlier write happened.
 */
export const PUBLISH_TRANSITIONS: readonly Transition<PublishState>[] = [
  ["queued", "claimed"],
  ["queued", "expired"],
  ["claimed", "published"],
  ["claimed", "queued"],
  ["claimed", "publish_refused"],
  ["claimed", "publish_failed"],
  ["claimed", "needs_lookup"],
  ["claimed", "outcome_unknown"],
  ["needs_lookup", "claimed"],
  ["outcome_unknown", "claimed"],
] as const;

const PUBLISH_TRANSITION_SET = transitionSet(PUBLISH_TRANSITIONS);

export const PUBLISH_TERMINAL_STATES: readonly PublishState[] = [
  "published",
  "publish_refused",
  "publish_failed",
  "expired",
];

/** What a publish claim transition is allowed to rest on. */
export type PublishTransitionContext =
  | { event: "claim"; mode: PublishClaimMode; capabilityConsumed: boolean }
  | { event: "expire_ttl" }
  | { event: "lease_expired" }
  | {
      event: "result";
      claimMode: PublishClaimMode;
      fencingMatches: boolean;
      outcome:
        | "pr_confirmed"
        | "refused_before_write"
        | "revalidation_refused"
        | "push_rejected"
        | "pr_create_rejected"
        | "lookup_no_prior_write"
        | "lookup_found_pr"
        | "lookup_impossible";
    };

export type PublishTransitionVerdict =
  | { allowed: true }
  | { allowed: false; reason: string };

const refuse = (reason: string): PublishTransitionVerdict => ({
  allowed: false,
  reason,
});

/**
 * The publish table with its conditions. The pair must be in the table, and the
 * event must be one the pair is allowed to rest on:
 *
 * - a write claim consumes a capability in the same transaction; a lookup claim
 *   must not, and is only reachable from `needs_lookup` or `outcome_unknown`;
 * - `claimed -> queued` is a write claim's refusal before any GitHub write, or a
 *   lookup that proved no earlier write -- never a lease expiry, which goes to
 *   `needs_lookup` so nothing is ever written again without looking first;
 * - every result carries the claim's fencing token, and a stale token decides
 *   nothing.
 */
export const decidePublishTransition = (
  from: PublishState,
  to: PublishState,
  context: PublishTransitionContext,
): PublishTransitionVerdict => {
  if (!PUBLISH_TRANSITION_SET.has(pairKey(from, to))) {
    return refuse("transition_not_in_table");
  }

  switch (context.event) {
    case "claim": {
      if (to !== "claimed") return refuse("claim_must_enter_claimed");
      if (context.mode === "write") {
        if (from !== "queued") return refuse("write_claim_only_from_queued");
        if (!context.capabilityConsumed) {
          return refuse("write_claim_requires_capability_consumption");
        }
        return { allowed: true };
      }
      if (from !== "needs_lookup" && from !== "outcome_unknown") {
        return refuse("lookup_claim_only_after_unknown_outcome");
      }
      if (context.capabilityConsumed) {
        return refuse("lookup_claim_must_not_consume_capability");
      }
      return { allowed: true };
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
      const expected = resultTarget(context.claimMode, context.outcome);
      if (expected === null) return refuse("outcome_not_valid_for_claim_mode");
      return expected === to
        ? { allowed: true }
        : refuse("outcome_does_not_lead_to_target");
    }
  }
};

const resultTarget = (
  mode: PublishClaimMode,
  outcome: Extract<PublishTransitionContext, { event: "result" }>["outcome"],
): PublishState | null => {
  if (mode === "write") {
    switch (outcome) {
      case "pr_confirmed":
        return "published";
      case "refused_before_write":
        return "queued";
      case "revalidation_refused":
      case "push_rejected":
        return "publish_refused";
      case "pr_create_rejected":
        return "publish_failed";
      case "lookup_impossible":
        return "outcome_unknown";
      default:
        return null;
    }
  }
  switch (outcome) {
    case "lookup_no_prior_write":
      return "queued";
    case "lookup_found_pr":
      return "published";
    case "lookup_impossible":
      return "outcome_unknown";
    default:
      return null;
  }
};

/**
 * Consecutive lookup failures on one `outcome_unknown` item before it becomes a
 * decision item for a person (proposed: 3).
 */
export const OUTCOME_UNKNOWN_LOOKUP_LIMIT = 3;

export const shouldEscalateOutcomeUnknown = (consecutiveLookupFailures: number) =>
  consecutiveLookupFailures >= OUTCOME_UNKNOWN_LOOKUP_LIMIT;

export const RUN_STATUSES = ["active", "finished", "abandoned"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const RUN_TRANSITIONS: readonly Transition<RunStatus>[] = [
  ["active", "finished"],
  ["active", "abandoned"],
] as const;

export const RUN_OUTCOMES = [
  "t1_queued",
  "t2_draft",
  "no_change",
  "agent_failed",
  "schema_invalid",
  "scope_violation",
  "secret_detected",
  "abandoned",
] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

/** How a run's outcome settles the AMUX attempt it is bound to (design §5.10). */
export const AMUX_SETTLEMENT_FOR_OUTCOME: Readonly<
  Record<RunOutcome, "review" | "retry" | "blocked" | null>
> = {
  t1_queued: "review",
  t2_draft: "review",
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
 */
export const REGISTRATION_TRANSITIONS: readonly Transition<RegistrationResult>[] = [
  ["pending", "registered"],
  ["pending", "registration_refused"],
  ["pending", "absent"],
  ["pending", "partial"],
] as const;

export const isAllowedTransition = <S extends string>(
  table: readonly Transition<S>[],
  from: S,
  to: S,
) => table.some(([a, b]) => a === from && b === to);

/* ------------------------------------------------------------------------- */
/* Mode and switches                                                          */
/* ------------------------------------------------------------------------- */

export const ENGINEERING_AGENT_MODE_SETTING_KEY = "feature.engineeringAgentMode";
export const ENGINEERING_AGENT_FREEZE_SETTING_KEY = "feature.engineeringAgentFreeze";
export const ENGINEERING_AGENT_REGISTRATION_SETTING_KEY =
  "feature.engineeringAgentRegistration";
export const ENGINEERING_AGENT_KILL_SWITCH_ENV = "ENGINEERING_AGENT_KILL_SWITCH";

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

export const resolveEngineeringAgentSwitches = (
  reading: SwitchReading,
): EffectiveSwitches => {
  const killed =
    reading.killSwitch !== undefined &&
    reading.killSwitch !== null &&
    reading.killSwitch !== "" &&
    reading.killSwitch !== "0" &&
    reading.killSwitch.toLowerCase() !== "false";
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
  /** Undecided decision items: T2 drafts, mismatches, repeated failures, observation failures, partial registrations. */
  pendingDecisions: number;
  /** When mode first became `t1`, or null if it never has. */
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
export const decideHalt = (reading: HaltReading): HaltValue => {
  if (!reading.appIdentityConfigured) return "config_missing";
  if (reading.circuitLatched) return "circuit_open";
  if (reading.unboundAppPrs > 0) return "unbound_app_pr";
  if (reading.unboundAppRefs > 0) return "unbound_app_ref";
  if (reading.openStateMismatches > 0) return "state_mismatch";
  return "none";
};

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
 * - Three incident starts within the trailing thirty days latch it, and so
 *   does the latest terminated run already being `circuit_open`.
 *
 * Only an acknowledgement in the Admin console clears it; nothing here does.
 */
export const isCircuitLatched = (input: {
  runs: readonly TerminatedRun[];
  acknowledgedAt: Date | null;
  now: Date;
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

  const windowStart = input.now.getTime() - CIRCUIT_WINDOW_DAYS * DAY_MS;
  let incidents = 0;
  considered.forEach((run, index) => {
    if (run.halt === "none") return;
    const previous = index === 0 ? null : considered[index - 1];
    const starts = previous === null || previous.halt === "none";
    if (starts && run.endedAt.getTime() >= windowStart) incidents += 1;
  });
  return incidents >= CIRCUIT_INCIDENT_LIMIT;
};

/**
 * A success heartbeat goes out only when the run finished and nothing is
 * halted. Mode `off`, a freeze or the kill switch still send it -- the monitor
 * watches whether the service is alive, not whether it did work (policy §12).
 */
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
