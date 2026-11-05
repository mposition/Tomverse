/**
 * Deriving the observer's activation state (docs/policy/trust-safety-compliance-agent.md §6).
 *
 * Pure. The seven checks §6 lists are decided here; the HMAC verification that
 * two of them need is an **input**, because verifying a signature reads the
 * audit integrity key and a module that reads a secret cannot be a pure core
 * the tests drive directly.
 *
 * §6's sentence this exists for: "observer는 설정 행만 믿지 않는다" — the mode is
 * derived from the newest audit entry for that action and target, and believed
 * only when all seven checks pass. That is what stops a replayed historical
 * tuple from turning observation on.
 *
 * The six configuration faults are not five plus "off". Five of them mean the
 * mode cannot be believed at all, so no count is computed and no ping is sent.
 * The sixth (on, but no ping URL) still computes the count and withholds only
 * the ping. Collapsing them would either hide a broken chain behind "off" or
 * stop counting over a missing environment variable.
 */

/** The exact audit action §6 names. */
export const TRUST_SAFETY_ACTIVATION_ACTION = "trust_safety.observer_activation_changed";

/** §6: the only two values, and the only two transitions. */
export const TRUST_SAFETY_MODES = ["off", "on"] as const;
export type TrustSafetyMode = (typeof TRUST_SAFETY_MODES)[number];

/**
 * The five faults that make the mode unbelievable, plus the sixth that only
 * withholds the ping. §6 fixes the count at six; a seventh value here would be
 * a fault the policy does not describe.
 */
export const TRUST_SAFETY_CONFIG_FAULTS = [
  "config_row_missing",
  "signature_unverified",
  "binding_mismatch",
  "unhashed_entry_present",
  "chain_broken",
  "ping_url_missing",
] as const;
export type TrustSafetyConfigFault = (typeof TRUST_SAFETY_CONFIG_FAULTS)[number];

/** The faults that stop the count, not only the ping. */
const FAULTS_THAT_STOP_COUNTING: readonly TrustSafetyConfigFault[] = [
  "config_row_missing",
  "signature_unverified",
  "binding_mismatch",
  "unhashed_entry_present",
  "chain_broken",
];

export type ActivationAuditEntry = {
  readonly id: string;
  /** `metadata.toMode` of that entry. */
  readonly toMode: string | null;
  /** `metadata.version` of that entry. */
  readonly version: number | null;
  readonly entryHash: string | null;
  /**
   * Whether the entry's own HMAC verified. `null` means it could not be
   * checked, which §6 treats the same as failing: an unverifiable signature is
   * not a verified one.
   */
  readonly hmacValid: boolean | null;
};

/**
 * The entry chained after the bound one.
 *
 * Only `previousHash` and `hmacValid` are read, and the type says so: an
 * `entryHash` field here would look like part of check 7 without being used,
 * and the next reader would have to work out that it is not.
 */
export type ActivationSuccessorEntry = {
  readonly previousHash: string | null;
  readonly hmacValid: boolean | null;
};

export type ActivationInput = {
  /** The single config row, or null when it does not exist. */
  readonly config: { readonly mode: string; readonly version: number } | null;
  /** The newest entry for this action and target, or null when there is none. */
  readonly newestEntry: ActivationAuditEntry | null;
  /** Whether any entry for this action and target has no `entryHash`. */
  readonly unhashedEntryExists: boolean;
  /**
   * The largest `metadata.version` across this action and target, or null when
   * there are no entries. Check 5 requires the newest entry to hold it.
   */
  readonly maxEntryVersion: number | null;
  /** The entry chained after the newest one, when one exists (check 7). */
  readonly successor: ActivationSuccessorEntry | null;
  /** Whether `TRUST_SAFETY_OBSERVER_PING_URL` is set (fault 6). */
  readonly pingUrlPresent: boolean;
};

export type ActivationState = {
  /** The believed mode, or null whenever a counting fault applies. */
  readonly mode: TrustSafetyMode | null;
  readonly fault: TrustSafetyConfigFault | null;
  /** Whether the DSR counts may be computed this round. */
  readonly countPermitted: boolean;
  /** Whether the dead-man ping may be sent this round (§8). */
  readonly pingPermitted: boolean;
};

const isMode = (value: string): value is TrustSafetyMode =>
  (TRUST_SAFETY_MODES as readonly string[]).includes(value);

const refuse = (fault: TrustSafetyConfigFault): ActivationState => ({
  mode: null,
  fault,
  countPermitted: !FAULTS_THAT_STOP_COUNTING.includes(fault),
  pingPermitted: false,
});

/**
 * Runs §6's seven checks in order and returns what this round may do.
 *
 * Fail-closed throughout: anything undecidable is a fault, never "off". §6
 * distinguishes the two, and reporting a broken chain as "off" would make a
 * tampered switch look like a deliberate one.
 */
export const deriveTrustSafetyActivation = (input: ActivationInput): ActivationState => {
  // 1. the config row exists
  if (input.config === null) return refuse("config_row_missing");

  // 2. the newest entry exists, and 3. its signature verifies. A missing entry
  // is grouped with an unverified signature because there is nothing to verify:
  // either way the mode has no audited origin.
  const entry = input.newestEntry;
  if (entry === null || entry.hmacValid !== true || entry.entryHash === null) {
    return refuse("signature_unverified");
  }

  // A stored mode outside the two is judged here, before the chain checks. It
  // is a row written around the database CHECK, not a broken chain, and
  // reporting it as `chain_broken` would send someone to look at the audit
  // log for a fault that is in the config row.
  if (!isMode(input.config.mode)) return refuse("binding_mismatch");

  // 4. binding: the entry's toMode and version are the config row's, and
  // 5. the newest entry holds the largest version.
  if (
    entry.toMode !== input.config.mode ||
    entry.version === null ||
    entry.version !== input.config.version ||
    input.maxEntryVersion === null ||
    input.maxEntryVersion !== entry.version
  ) {
    return refuse("binding_mismatch");
  }

  // 6. no entry for this action and target lacks a hash. An unhashed entry
  // means the chain cannot be walked past it, so nothing after it is evidence.
  if (input.unhashedEntryExists) return refuse("unhashed_entry_present");

  // 7. if an entry is chained after this one, it must point at it and verify
  // itself. Checking only the bound entry would accept a chain that was cut
  // immediately after it.
  if (input.successor !== null) {
    const { previousHash, hmacValid } = input.successor;
    if (previousHash !== entry.entryHash || hmacValid !== true) {
      return refuse("chain_broken");
    }
  }

  // The mode is believed. The sixth fault applies only when it is on: an
  // observer that is off sends no ping anyway, so a missing URL is not a fault
  // for it to report.
  if (input.config.mode === "on" && !input.pingUrlPresent) {
    return { mode: "on", fault: "ping_url_missing", countPermitted: true, pingPermitted: false };
  }

  return {
    mode: input.config.mode,
    fault: null,
    countPermitted: input.config.mode === "on",
    pingPermitted: input.config.mode === "on",
  };
};

/**
 * §6: the only allowed transitions are `off → on` and `on → off`. Anything
 * else, including re-requesting the current mode, is refused and writes
 * nothing. Shared so the activation route (E3) and its tests use one rule.
 */
export const activationTransitionAllowed = ({
  fromMode,
  toMode,
}: {
  readonly fromMode: string;
  readonly toMode: string;
}): boolean =>
  isMode(fromMode) && isMode(toMode) && fromMode !== toMode;

/** Why an activation request writes nothing. A closed set; §6 answers 409. */
export const ACTIVATION_REFUSALS = [
  /** The requested mode is not one of the two. */
  "mode_unknown",
  /** The stored row holds a mode outside the two; a person has to look at it. */
  "stored_mode_unknown",
  /** The same mode again, which §6 names explicitly. */
  "not_a_transition",
] as const;

export type ActivationRefusal = (typeof ACTIVATION_REFUSALS)[number];

/**
 * Every code the activation route can answer with, and the closed set the
 * section will show.
 *
 * The route says its codes are closed sets rather than free text; the query
 * parameter it redirects back with has to be held to the same thing, or a
 * hand-written `?refused=<anything>` renders a stranger's text in the panel.
 * Independent review named that.
 */
export const TRUST_SAFETY_REFUSAL_CODES = [
  ...ACTIVATION_REFUSALS,
  "integrity_key_missing",
  "reauthentication_required",
  "stale",
  "late",
  "body_too_large",
  "invalid_request",
  "internal",
] as const;

/** Whether a value is one of the codes the route emits. */
export const isTrustSafetyRefusalCode = (value: unknown): boolean =>
  typeof value === "string" && (TRUST_SAFETY_REFUSAL_CODES as readonly string[]).includes(value);

/** What the activation write will record, or why there is nothing to record. */
export type ActivationWrite =
  | { readonly refusal: ActivationRefusal }
  | {
      readonly refusal: null;
      /** null the first time, when no row exists yet (§14's single `on` step). */
      readonly fromMode: TrustSafetyMode | null;
      readonly toMode: TrustSafetyMode;
      readonly version: number;
    };

/**
 * Decides one activation write from the stored row and the requested mode.
 *
 * §6 allows `off → on` and `on → off` and nothing else, and refuses the same
 * mode again without writing anything. The row does not exist before the first
 * write -- no migration seeds it, and §14's order has the operator go straight
 * to `on` -- so a first write is allowed and records `fromMode: null` rather
 * than inventing a previous mode it never had.
 *
 * `version` is monotonic because §6's check 5 reads the largest
 * `metadata.version` across this action's entries and requires the newest
 * entry to hold it. The row's trigger refuses a version that does not move
 * forward; this is the application half of that pair.
 */
export const nextActivationWrite = ({
  current,
  requested,
}: {
  readonly current: { readonly mode: string; readonly version: number } | null;
  readonly requested: string;
}): ActivationWrite => {
  if (!isMode(requested)) return { refusal: "mode_unknown" };
  if (current === null) {
    return { refusal: null, fromMode: null, toMode: requested, version: 1 };
  }
  // A stored mode outside the two is not a transition to judge: that row was
  // written around the database CHECK, and §6 reports it as its own fault
  // rather than letting the next write paper over it.
  if (!isMode(current.mode)) return { refusal: "stored_mode_unknown" };
  if (!activationTransitionAllowed({ fromMode: current.mode, toMode: requested })) {
    return { refusal: "not_a_transition" };
  }
  return {
    refusal: null,
    fromMode: current.mode,
    toMode: requested,
    version: current.version + 1,
  };
};
