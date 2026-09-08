// What state a mobile auth ring key is in, as one judgement two callers share.
//
// `check-mobile-auth-keyring.mjs` asks this before a deploy and turns some of
// the states into a failed exit. A standing report asks the same question of a
// configuration that is already deployed and turns none of them into one. They
// have to agree: a report that called a key healthy while the pre-deploy check
// called it undeclared would send an operator looking for a difference that is
// only in the code.
//
// Pure, and takes milliseconds rather than reading a clock, so both callers can
// be tested against a fixed instant.

/** Every state a ring entry can be in. Nothing outside this list exists. */
export const MOBILE_RING_KEY_STATES = [
  /** The key that signs, or computes digests, right now. */
  "active",
  /** In the ring, neither active nor retired. Verifies nothing. */
  "undeclared",
  /** Retired at an instant that has not arrived. Verifies nothing. */
  "retirement_in_future",
  /** Retired, and still inside the approved window. */
  "retired_in_grace",
  /** Retired, window spent. Verifies nothing, and is safe to leave. */
  "retired_grace_over",
];

/**
 * One entry's state.
 *
 * The order matters and matches `lib/mobileAuthKeyring.ts`: active first,
 * because an active key that also carries a retirement line is a contradiction
 * the caller reports rather than a retirement; then the absence of a
 * retirement; then whether the retirement has arrived; then the window.
 */
export const classifyMobileRingKey = ({
  keyId,
  activeKeyId,
  retiredAtMs,
  graceSeconds,
  nowMs,
}) => {
  if (keyId === activeKeyId) {
    return {
      keyId,
      state: "active",
      // Reported so a caller can say "active and also retired" without
      // re-reading the retirement map.
      alsoRetired: retiredAtMs !== undefined && retiredAtMs !== null,
      retiredAtMs: retiredAtMs ?? null,
      expiresAtMs: null,
      remainingSeconds: null,
    };
  }
  if (retiredAtMs === undefined || retiredAtMs === null) {
    return {
      keyId,
      state: "undeclared",
      alsoRetired: false,
      retiredAtMs: null,
      expiresAtMs: null,
      remainingSeconds: null,
    };
  }
  if (retiredAtMs > nowMs) {
    return {
      keyId,
      state: "retirement_in_future",
      alsoRetired: true,
      retiredAtMs,
      expiresAtMs: null,
      remainingSeconds: null,
    };
  }
  const expiresAtMs = retiredAtMs + graceSeconds * 1000;
  if (nowMs >= expiresAtMs) {
    return {
      keyId,
      state: "retired_grace_over",
      alsoRetired: true,
      retiredAtMs,
      expiresAtMs,
      remainingSeconds: 0,
    };
  }
  return {
    keyId,
    state: "retired_in_grace",
    alsoRetired: true,
    retiredAtMs,
    expiresAtMs,
    remainingSeconds: Math.round((expiresAtMs - nowMs) / 1000),
  };
};

/** Every entry of one ring, in ring order. */
export const classifyMobileRing = ({
  ring,
  retirements,
  activeKeyId,
  graceSeconds,
  nowMs,
}) =>
  [...ring.keys()].map((keyId) =>
    classifyMobileRingKey({
      keyId,
      activeKeyId,
      retiredAtMs: retirements.get(keyId),
      graceSeconds,
      nowMs,
    })
  );

/**
 * Retirement lines naming an id the ring does not hold.
 *
 * The other half of a mistyped retirement: the id that was meant to be retired
 * is left undeclared, and the id that was typed points at nothing. Either half
 * alone reads as ordinary tidying, which is why both are reported.
 */
export const unmatchedMobileRetirements = ({ ring, rawRetirements }) => {
  const found = [];
  for (const entry of (rawRetirements ?? "").split(",")) {
    const trimmed = entry.trim();
    if (trimmed === "") continue;
    const keyId = trimmed.slice(0, trimmed.indexOf("@"));
    if (keyId && !ring.has(keyId)) found.push(keyId);
  }
  return found;
};

/**
 * Every fault one ring can be in, as codes rather than sentences.
 *
 * The classifier above answers "what state is this key in". That is only part
 * of what the pre-deploy check refuses over, and for a while it was the only
 * part the standing report shared -- so a configuration the check rejected
 * (active id naming nothing, an active key that cannot sign, two ids holding
 * one key) came back from the report as "nothing wants attention". Sharing
 * half a diagnosis is worse than sharing none: it reads as agreement.
 *
 * So the findings are shared and the *consequence* is not. The check turns
 * these into a non-zero exit; the report prints them and exits 0.
 *
 * `signsAndVerifies` is injected because it needs crypto and this module is
 * pure. Pass `null` for a ring where signing is not the question -- pepper
 * material is an HMAC key, not a signer -- and the check is skipped rather
 * than assumed to pass.
 */
export const mobileRingFindings = ({
  ring,
  retirements,
  rawRetirements,
  activeKeyId,
  graceSeconds,
  nowMs,
  signsAndVerifies = null,
  materialIdentity = null,
}) => {
  const findings = [];

  if (!activeKeyId) {
    findings.push({ code: "no_active_key_named" });
  } else if (!ring.has(activeKeyId)) {
    findings.push({ code: "active_key_not_in_ring", keyId: activeKeyId });
  }

  for (const key of classifyMobileRing({
    ring,
    retirements,
    activeKeyId,
    graceSeconds,
    nowMs,
  })) {
    if (key.state === "active") {
      if (key.alsoRetired) {
        findings.push({ code: "active_key_also_retired", keyId: key.keyId });
      }
      if (signsAndVerifies && !signsAndVerifies(ring.get(key.keyId))) {
        findings.push({ code: "active_key_cannot_sign", keyId: key.keyId });
      }
      continue;
    }
    if (key.state === "undeclared") {
      findings.push({ code: "undeclared", keyId: key.keyId });
      continue;
    }
    if (key.state === "retirement_in_future") {
      findings.push({
        code: "retirement_in_future",
        keyId: key.keyId,
        retiredAtMs: key.retiredAtMs,
      });
      continue;
    }
    if (key.state === "retired_grace_over") {
      findings.push({
        code: "grace_over",
        keyId: key.keyId,
        retiredAtMs: key.retiredAtMs,
      });
    }
  }

  for (const keyId of unmatchedMobileRetirements({ ring, rawRetirements })) {
    findings.push({ code: "retirement_names_nothing", keyId });
  }

  if (materialIdentity) {
    // Two ids, one key. Renaming is not rotating, and after a leak the leaked
    // material would still be the material in use.
    const seen = new Map();
    for (const [keyId, secret] of ring.entries()) {
      const identity = materialIdentity(secret);
      if (identity === null || identity === undefined) continue;
      const earlier = seen.get(identity);
      if (earlier === undefined) {
        seen.set(identity, keyId);
        continue;
      }
      findings.push({ code: "duplicate_material", keyId, otherKeyId: earlier });
    }
  }

  return findings;
};

/**
 * Whether a deployment is configured for mobile auth at all.
 *
 * Three answers rather than a boolean, because the middle one is the dangerous
 * state: every mobile endpoint answers 503 and none of them says which
 * variable is missing.
 */
export const mobileAuthConfigurationState = ({ required, optional, isSet }) => {
  const missing = required.filter((name) => !isSet(name));
  if (missing.length === 0) return { state: "configured", missing };
  if (missing.length === required.length && !optional.some((name) => isSet(name))) {
    return { state: "unconfigured", missing };
  }
  return { state: "partial", missing };
};
