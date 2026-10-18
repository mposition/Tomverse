/**
 * The AMUX Decision Maker switches, policy version 1
 * (docs/policy/amux-decision-maker.md §8, §10), stage S1b.
 *
 * Pure: the closed vocabularies that the CHECKs of migration
 * 20261008030000_amux_decision_maker_switch hold, the mapping from the newest
 * stored event of each scope to the switch state `routeDmQuestion()` reads,
 * and the input and audit shapes of the one writer,
 * lib/amux/decisionMakerSwitchStore.ts. No I/O.
 *
 * Every list here is compared with its CHECK by `npm run
 * check:enum-constraints`, and the trigger's action and actor rules are
 * mirrored by `dmOperatorSwitchAction()` and `DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE`.
 */

export const DM_KILL_SWITCH_SCOPE = "kill_switch" as const;

/** Section 7: the two DM instances, one per vendor. */
export const DM_INSTANCE_SCOPES = ["decision-maker-openai", "decision-maker-anthropic"] as const;
export type DmInstanceScope = (typeof DM_INSTANCE_SCOPES)[number];

export const DM_SWITCH_SCOPES = [DM_KILL_SWITCH_SCOPE, ...DM_INSTANCE_SCOPES] as const;
export type DmSwitchScope = (typeof DM_SWITCH_SCOPES)[number];

/** The kill switch: `on` stops the DM path (section 6's table). */
export const DM_KILL_SWITCH_VALUES = ["on", "off"] as const;
export type DmKillSwitchValue = (typeof DM_KILL_SWITCH_VALUES)[number];

/** Section 8: an instance is `off` or `proposal`, and nothing else. */
export const DM_INSTANCE_MODES = ["off", "proposal"] as const;
export type DmInstanceMode = (typeof DM_INSTANCE_MODES)[number];

/** Every value the store accepts in some scope; the pairing is a second CHECK. */
export const DM_SWITCH_VALUES = ["on", "off", "proposal"] as const;

/** Section 8: a person's change, the validation-failure latch, section 5's cleanup latch. */
export const DM_SWITCH_REASON_CODES = ["operator", "validation_latch", "cleanup_latch"] as const;
export type DmSwitchReasonCode = (typeof DM_SWITCH_REASON_CODES)[number];

export const DM_SWITCH_LATCH_REASONS = ["validation_latch", "cleanup_latch"] as const;
export type DmSwitchLatchReason = (typeof DM_SWITCH_LATCH_REASONS)[number];

export const DM_SWITCH_ACTOR_KINDS = ["human", "system"] as const;
export type DmSwitchActorKind = (typeof DM_SWITCH_ACTOR_KINDS)[number];

/** Section 10's audit actions for the switch store. */
export const DM_SWITCH_AUDIT_ACTIONS = {
  mode: "amux.decision.mode",
  latchRelease: "amux.decision.latch_release",
  latch: "amux.decision.latch",
} as const;

export const DM_SWITCH_AUDIT_TARGET_TYPE = "AmuxDecisionMakerSwitchEvent" as const;

/**
 * Section 10: a latch is recorded by the latched instance's own system actor.
 * The migration's trigger holds the same pairing.
 */
export const DM_SWITCH_LATCH_ACTOR_FOR_INSTANCE = Object.freeze({
  "decision-maker-openai": "amux-decision-maker-openai",
  "decision-maker-anthropic": "amux-decision-maker-anthropic",
} as const);

export const isDmInstanceScope = (value: unknown): value is DmInstanceScope =>
  typeof value === "string" && (DM_INSTANCE_SCOPES as readonly string[]).includes(value);

export const isDmSwitchScope = (value: unknown): value is DmSwitchScope =>
  typeof value === "string" && (DM_SWITCH_SCOPES as readonly string[]).includes(value);

/** The switch state `routeDmQuestion()` reads. `null` means unreadable. */
export type DecisionMakerSwitchState = {
  killSwitch: boolean | null;
  instances: Record<DmInstanceScope, DmInstanceMode | null>;
};

/** Fail-closed: every question goes to the operator as `settings_unreadable`. */
export const unreadableDecisionMakerSwitches = (): DecisionMakerSwitchState => ({
  killSwitch: null,
  instances: { "decision-maker-openai": null, "decision-maker-anthropic": null },
});

/** A scope with no event: kill switch off, both instances `off` (section 8). */
export const defaultDecisionMakerSwitches = (): DecisionMakerSwitchState => ({
  killSwitch: false,
  instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "off" },
});

/**
 * The state from the newest event of each scope, at most one row per scope.
 * A scope with no row keeps its default. A row that is not an object, names a
 * scope outside the list, repeats a scope or holds a value its scope does not
 * accept makes the whole state unreadable: one bad row is not a reason to
 * trust the others, and unreadable already routes every question to the
 * operator.
 */
export const decisionMakerSwitchStateFromRows = (rows: unknown): DecisionMakerSwitchState => {
  if (!Array.isArray(rows)) return unreadableDecisionMakerSwitches();
  const state = defaultDecisionMakerSwitches();
  const seen = new Set<string>();
  for (const row of rows as unknown[]) {
    if (row === null || typeof row !== "object") return unreadableDecisionMakerSwitches();
    const { scope, value } = row as { scope?: unknown; value?: unknown };
    if (!isDmSwitchScope(scope) || seen.has(scope)) return unreadableDecisionMakerSwitches();
    seen.add(scope);
    if (scope === DM_KILL_SWITCH_SCOPE) {
      if (value !== "on" && value !== "off") return unreadableDecisionMakerSwitches();
      state.killSwitch = value === "on";
    } else {
      if (value !== "off" && value !== "proposal") return unreadableDecisionMakerSwitches();
      state.instances[scope] = value;
    }
  }
  return state;
};

/**
 * Where §8's validation count of an instance starts (stage S2-2a4,
 * docs/policy/amux-decision-maker.md §8: "검증 실패(§6)가 연속 3건이면 그
 * 인스턴스를 off로 latch한다. 해제는 운영자만"):
 *
 * - `none`: the instance has no validation latch; every result counts.
 * - `latched`: its newest validation latch has no person's event after it --
 *   the run it latched stands, and nothing is owed until it is released.
 * - `released`: the first person's event after that latch, which the switch
 *   guard requires to be `amux.decision.latch_release`. The count starts at
 *   it: the results admitted under that release or a later switch event of
 *   the instance -- each result records the sequence of its instance's newest
 *   switch event, read by the ledger's guard under the shared switch gate
 *   (`switchSequence`, migration 20261017200000), and those at or above
 *   `releaseSequence` (a decimal string; it is a BIGINT) are counted. The
 *   gate, not the audit chain lock, orders a release and a result (review
 *   r-20261018-012448-8f45bd); a clock and the ledger's own sequence cannot.
 *   A result written before that migration has no number and is placed by
 *   its clock against `releasedAtMs`, a shared millisecond counted.
 *
 * Nothing else moves it: not a person's ordinary mode change -- the same mode
 * saved again, off and back to proposal, a change after the release -- not a
 * cleanup latch and not a cleanup latch's own release. Until stage S2-2a4 the
 * count started at the instance's newest switch event of any kind, so a mode
 * saved between the third failure and its latch dropped the latch without a
 * release.
 */
export type DmValidationCountBoundary =
  | { kind: "none" }
  | { kind: "latched" }
  | { kind: "released"; releaseSequence: string; releasedAtMs: number };

/**
 * What the request ledger's writers read in one statement
 * (docs/policy/amux-decision-maker.md §6, §8): the switch state, and each
 * instance's validation count boundary (`DmValidationCountBoundary`; since
 * stage S2-2a4, in place of its newest event).
 *
 * Since stage S2-2a3 the same statement also carries, per instance, the
 * ledger event id of the `cleanup_unknown` report its newest `cleanup_latch`
 * names (§5): a cleanup latch settles the report it names and no other. Not a
 * person's ordinary mode change (review r-20261017-115136-888d76), and not a
 * clock -- a later report can share a latch's database millisecond (review
 * r-20261017-123200-7609b7).
 */
export type DecisionMakerSwitchRead = {
  state: DecisionMakerSwitchState;
  validationBoundary: Record<DmInstanceScope, DmValidationCountBoundary>;
  cleanupLatchedEventId: Record<DmInstanceScope, string | null>;
};

/**
 * No validation latch on either instance. An unreadable read carries it too:
 * every result counts, the side that latches sooner, and the unreadable state
 * already sends every question to the operator.
 */
const noValidationLatches = (): DecisionMakerSwitchRead["validationBoundary"] => ({
  "decision-maker-openai": { kind: "none" },
  "decision-maker-anthropic": { kind: "none" },
});

const noCleanupLatches = (): DecisionMakerSwitchRead["cleanupLatchedEventId"] => ({
  "decision-maker-openai": null,
  "decision-maker-anthropic": null,
});

const epochClock = (value: unknown): number =>
  typeof value === "bigint" || typeof value === "number" ? Number(value) : Number.NaN;

/** A ledger event id: the request ledger's id format (migration 20261008090100). */
const LEDGER_EVENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isDmLedgerEventId = (value: unknown): value is string =>
  typeof value === "string" && LEDGER_EVENT_ID.test(value);

/** A switch event's sequence as the read returned it (a positive BIGINT), as a decimal string; undefined when it is not one. */
const switchSequenceOf = (value: unknown): string | undefined => {
  if (typeof value === "bigint") return value > BigInt(0) && value <= BigInt("9223372036854775807") ? String(value) : undefined;
  if (typeof value === "number") return Number.isSafeInteger(value) && value > 0 ? String(value) : undefined;
  if (typeof value === "string" && /^[1-9][0-9]{0,18}$/.test(value) && BigInt(value) <= BigInt("9223372036854775807")) return value;
  return undefined;
};

/**
 * One scope's validation count boundary from its row's three columns: the
 * sequence of its newest validation latch, and the sequence and database
 * clock of the first person's event after that latch. Undefined for a
 * combination the read could not have produced: a release without a latch, a
 * release with only one of its two values, a release numbered at or below its
 * latch, or any of them on the kill switch.
 */
const validationBoundaryOf = (row: {
  scope: unknown;
  newestValidationLatchSequence?: unknown;
  validationReleaseSequence?: unknown;
  validationReleasedAtEpochMs?: unknown;
}): DmValidationCountBoundary | undefined => {
  const latch = row.newestValidationLatchSequence;
  const release = row.validationReleaseSequence;
  const releasedAt = row.validationReleasedAtEpochMs;
  if (latch === null) {
    return release === null && releasedAt === null ? { kind: "none" } : undefined;
  }
  const latchSequence = switchSequenceOf(latch);
  if (!isDmInstanceScope(row.scope) || latchSequence === undefined) return undefined;
  if (release === null && releasedAt === null) return { kind: "latched" };
  const releaseSequence = switchSequenceOf(release);
  const releasedAtMs = epochClock(releasedAt);
  if (releaseSequence === undefined || !Number.isSafeInteger(releasedAtMs)) return undefined;
  if (BigInt(releaseSequence) <= BigInt(latchSequence)) return undefined;
  return { kind: "released", releaseSequence, releasedAtMs };
};

/**
 * The state from the newest event of each scope, each instance's validation
 * count boundary (stage S2-2a4), and the report each instance's newest
 * cleanup latch names. Any row the state mapping refuses, or whose boundary
 * or named report the table and its guard could not have produced -- a column
 * missing from the row, a named report that is not a ledger event id, a
 * release without a latch, either on the kill switch -- makes the whole read
 * unreadable: every state field null, every boundary `none` and no cleanup
 * latch, as `decisionMakerSwitchStateFromRows()` does for one bad row.
 */
export const decisionMakerSwitchReadFromRows = (rows: unknown): DecisionMakerSwitchRead => {
  const unreadable = {
    state: unreadableDecisionMakerSwitches(),
    validationBoundary: noValidationLatches(),
    cleanupLatchedEventId: noCleanupLatches(),
  };
  const state = decisionMakerSwitchStateFromRows(rows);
  if (state.killSwitch === null || !Array.isArray(rows)) return unreadable;
  const validationBoundary = noValidationLatches();
  const cleanupLatchedEventId = noCleanupLatches();
  for (const row of rows as Array<{
    scope: unknown;
    newestCleanupLatchEventId?: unknown;
    newestValidationLatchSequence?: unknown;
    validationReleaseSequence?: unknown;
    validationReleasedAtEpochMs?: unknown;
  }>) {
    const boundary = validationBoundaryOf(row);
    if (boundary === undefined) return unreadable;
    const named = row.newestCleanupLatchEventId;
    if (named !== null && (!isDmLedgerEventId(named) || !isDmInstanceScope(row.scope))) return unreadable;
    if (isDmInstanceScope(row.scope)) {
      validationBoundary[row.scope] = boundary;
      cleanupLatchedEventId[row.scope] = named;
    }
  }
  return { state, validationBoundary, cleanupLatchedEventId };
};

/**
 * The two switch inputs of `routeDmQuestion()` for the instance a question
 * would be assigned to. An instance that is not a DM instance (an unverified
 * provider) reads as `null`; the router refuses that question for its provider.
 */
export const dmSwitchRoutingInput = (
  state: DecisionMakerSwitchState,
  instance: string | null,
): { killSwitch: boolean | null; instanceMode: DmInstanceMode | null } => ({
  killSwitch: state.killSwitch,
  instanceMode: isDmInstanceScope(instance) ? state.instances[instance] : null,
});

export type DmOperatorSwitchChange =
  | { scope: typeof DM_KILL_SWITCH_SCOPE; value: DmKillSwitchValue }
  | { scope: DmInstanceScope; value: DmInstanceMode };

/** A person's change, or null when the scope or its value is outside the lists. */
export const parseDmOperatorSwitchChange = (
  scope: unknown,
  value: unknown,
): DmOperatorSwitchChange | null => {
  if (scope === DM_KILL_SWITCH_SCOPE) {
    return value === "on" || value === "off" ? { scope, value } : null;
  }
  if (isDmInstanceScope(scope)) {
    return value === "off" || value === "proposal" ? { scope, value } : null;
  }
  return null;
};

/**
 * A system latch. Since stage S2-2a3 a `cleanup_latch` names the ledger event
 * id of the `cleanup_unknown` report it settles (§5), and no other latch names
 * one; the migration's CHECK holds the same pairing.
 */
export type DmSwitchLatch = { instance: DmInstanceScope; reason: DmSwitchLatchReason; cleanupEventId: string | null };

/**
 * A system latch, or null when the instance or the reason is outside the
 * lists, or the named report is missing from a cleanup latch, malformed, or
 * given with another reason.
 */
export const parseDmSwitchLatch = (instance: unknown, reason: unknown, cleanupEventId: unknown = null): DmSwitchLatch | null => {
  if (!isDmInstanceScope(instance) || typeof reason !== "string" || !(DM_SWITCH_LATCH_REASONS as readonly string[]).includes(reason)) {
    return null;
  }
  if (reason === "cleanup_latch" ? !isDmLedgerEventId(cleanupEventId) : cleanupEventId !== null) return null;
  return { instance, reason: reason as DmSwitchLatchReason, cleanupEventId: reason === "cleanup_latch" ? (cleanupEventId as string) : null };
};

/**
 * Which audit action a person's change is recorded under: the release of a
 * latch when the scope's newest event is the system's, otherwise a mode
 * change. The trigger refuses the event under any other action.
 */
export const dmOperatorSwitchAction = (
  newestActorKind: DmSwitchActorKind | null,
): (typeof DM_SWITCH_AUDIT_ACTIONS)["mode" | "latchRelease"] =>
  newestActorKind === "system" ? DM_SWITCH_AUDIT_ACTIONS.latchRelease : DM_SWITCH_AUDIT_ACTIONS.mode;

/** The only keys a switch audit entry carries. No free text. */
export const DM_SWITCH_AUDIT_METADATA_KEYS = [
  "event_id",
  "scope",
  "value",
  "reason_code",
  "previous_value",
] as const;
export type DmSwitchAuditMetadataKey = (typeof DM_SWITCH_AUDIT_METADATA_KEYS)[number];

const AUDIT_VALUE = /^[a-z0-9_-]{1,64}$/;

export const dmSwitchAuditMetadata = (
  fields: Partial<Record<DmSwitchAuditMetadataKey, string | null>>,
): Record<string, string> => {
  const metadata: Record<string, string> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (!(DM_SWITCH_AUDIT_METADATA_KEYS as readonly string[]).includes(key)) {
      throw new Error(`AMUX Decision Maker switch audit metadata key refused: ${key}`);
    }
    if (value === null || value === undefined) continue;
    if (typeof value !== "string" || !AUDIT_VALUE.test(value)) {
      throw new Error(`AMUX Decision Maker switch audit metadata value refused: ${key}`);
    }
    metadata[key] = value;
  }
  return metadata;
};
