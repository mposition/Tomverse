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

export type DmSwitchLatch = { instance: DmInstanceScope; reason: DmSwitchLatchReason };

/** A system latch, or null when the instance or the reason is outside the lists. */
export const parseDmSwitchLatch = (instance: unknown, reason: unknown): DmSwitchLatch | null =>
  isDmInstanceScope(instance) &&
  typeof reason === "string" &&
  (DM_SWITCH_LATCH_REASONS as readonly string[]).includes(reason)
    ? { instance, reason: reason as DmSwitchLatchReason }
    : null;

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
