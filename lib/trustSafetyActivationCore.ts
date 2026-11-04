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

export type ActivationSuccessorEntry = {
  readonly previousHash: string | null;
  readonly entryHash: string | null;
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

  if (!isMode(input.config.mode)) {
    // A stored value outside the two is not a third mode; it is a row that
    // cannot be believed. The database CHECK should refuse it, so reaching
    // here means the row was written around that constraint.
    return refuse("binding_mismatch");
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
