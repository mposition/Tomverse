// How one evaluation moves each page key, and which message kind a move owes.
//
// docs/policy/sre-ops.md §1 and §5 are the contract. A key opens after its
// signal's consecutive-bad threshold, recovers after two consecutive good
// evaluations, and an open key whose band gets worse owes a worsening. An
// opening is a *new open* only if the key has not newly opened earlier on the
// same owner date and did not recover within the last 24 hours; otherwise it is
// a *reopen*. The date rule is what keeps "one new open per key per owner date"
// true on a 25-hour daylight-saving day, where the 24-hour rule alone would not.
//
// An `unknown` observation changes nothing: a failed or skipped evaluation must
// not advance a streak, so detection can be late but never invented.
//
// Pure: the caller passes `now` (epoch ms) and `ownerDate` (YYYY-MM-DD in the
// owner's time zone) so the same inputs always give the same result.

export const STREAK_MAX = 3;
export const RECOVERY_STREAK = 2;
export const REOPEN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * The S2 page keys (policy §1). `openAfter` is the consecutive-bad count that
 * opens the key; `bands` are its bad bands in increasing severity, so a move
 * to a later band is a worsening.
 */
export const S2_PAGE_SIGNALS = Object.freeze([
  signal("P1a", ["database", "securityEnvironment"], 3, ["false"]),
  signal("P1b", ["providerBudgets"], 3, ["false"]),
  signal("P1c", ["emailSnapshotKeyring", "emailSendingIdentity"], 3, ["false"]),
  signal("P1u", ["snapshot"], 3, ["failed"]),
  signal("P3", ["credit_reservation_reconciliation"], 1, ["delayed", "stuck"]),
  signal("P-D", ["standard_email_drain"], 1, ["failures_3_plus"]),
]);

function signal(id, scopes, openAfter, bands) {
  return Object.freeze({ id, scopes: Object.freeze(scopes), openAfter, bands: Object.freeze(bands) });
}

/** `signal#scope` for every S2 page key, in declaration order. */
export const S2_PAGE_KEYS = Object.freeze(
  S2_PAGE_SIGNALS.flatMap((s) => s.scopes.map((scope) => `${s.id}#${scope}`)),
);

/** The state a key starts from after a genesis. */
export function initialKeyState() {
  return { status: "closed", streak: 0, openedAt: null, lastBand: null, recoveredAt: null, newOpenOwnerDate: null };
}

/**
 * Evaluate one key.
 *
 * `observation` is `"ok"`, `"unknown"`, or one of the signal's bad bands.
 * Returns `{ state, message }` where `message` is `null` or one of
 * `new_open` / `reopen` / `worsening` / `recovery`.
 */
export function evaluateKey(signalDef, previous, observation, { now, ownerDate }) {
  assertSignal(signalDef);
  assertState(previous);
  if (!Number.isSafeInteger(now)) throw new Error("ops_observer_now_invalid");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ownerDate ?? "")) throw new Error("ops_observer_owner_date_invalid");

  if (observation === "unknown") return { state: { ...previous }, message: null };
  const badIndex = signalDef.bands.indexOf(observation);
  if (observation !== "ok" && badIndex === -1) throw new Error("ops_observer_band_unknown");
  const bad = badIndex !== -1;

  if (previous.status === "closed") {
    if (!bad) return { state: { ...previous, streak: 0 }, message: null };
    const streak = Math.min(previous.streak + 1, STREAK_MAX);
    if (streak < signalDef.openAfter) return { state: { ...previous, streak }, message: null };
    const isReopen =
      previous.newOpenOwnerDate === ownerDate ||
      (previous.recoveredAt !== null && now - previous.recoveredAt < REOPEN_WINDOW_MS);
    return {
      state: {
        ...previous,
        status: "open",
        streak: 0,
        openedAt: now,
        lastBand: observation,
        newOpenOwnerDate: isReopen ? previous.newOpenOwnerDate : ownerDate,
      },
      message: isReopen ? "reopen" : "new_open",
    };
  }

  // open: `streak` counts consecutive good evaluations toward recovery.
  if (bad) {
    const worse = badIndex > signalDef.bands.indexOf(previous.lastBand);
    return {
      state: { ...previous, streak: 0, lastBand: worse ? observation : previous.lastBand },
      message: worse ? "worsening" : null,
    };
  }
  const streak = Math.min(previous.streak + 1, STREAK_MAX);
  if (streak < RECOVERY_STREAK) return { state: { ...previous, streak }, message: null };
  return {
    state: { ...previous, status: "closed", streak: 0, lastBand: null, recoveredAt: now },
    message: "recovery",
  };
}

function assertSignal(s) {
  if (!s || !Array.isArray(s.bands) || s.bands.length === 0 || !Number.isInteger(s.openAfter)) {
    throw new Error("ops_observer_signal_invalid");
  }
  if (s.openAfter < 1 || s.openAfter > STREAK_MAX) throw new Error("ops_observer_signal_invalid");
}

function assertState(s) {
  if (!s || (s.status !== "open" && s.status !== "closed")) throw new Error("ops_observer_state_invalid");
  if (!Number.isInteger(s.streak) || s.streak < 0 || s.streak > STREAK_MAX) {
    throw new Error("ops_observer_state_invalid");
  }
}
