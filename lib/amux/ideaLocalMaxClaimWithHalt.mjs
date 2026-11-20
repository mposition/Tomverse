import { AMUX_V19_MAX_CLAIM_REFUSAL_KINDS, claimAmuxV19MaxShadowBudgetOnce } from
  "./ideaLocalMaxShadowClaimOnce.mjs";
import { localAmuxSessionClaimMarker } from "./ideaLocalSessionClaimMarker.mjs";

/** Answers that prove no claim was written: a local refusal before any
 * network call, or the route's pre-write refusal confirmed absent by the
 * exact readback. */
const NO_CLAIM = new Set(["refused", "auth_unavailable",
  ...AMUX_V19_MAX_CLAIM_REFUSAL_KINDS]);

/** The marker's claim (or none) and, when known, when it was written. */
const recoverFrom = (pending) => ({ kind: "recover", identity: pending.identity,
  ...(Number.isFinite(pending.writtenAtMs)
    ? { writtenAtMs: pending.writtenAtMs } : {}) });

/** Record the claim about to be written in the durable local marker before
 * its first network write. A committed or uncertain claim keeps the marker
 * until the cycle reconciles it with the app; a pre-write refusal clears it at
 * once. A marker left by an earlier tick is not a stop (operator, 2026-11-16):
 * this returns `recover` with the claim it names, and the cycle reconciles
 * that claim before any new one. */
export async function claimAmuxV19MaxShadowBudgetWithHaltOnce(input,
  claimOnce = claimAmuxV19MaxShadowBudgetOnce,
  markerFor = localAmuxSessionClaimMarker) {
  let marker;
  try {
    marker = markerFor(input?.stateDirectory);
    const pending = await marker.read();
    if (pending) return recoverFrom(pending);
    if (!await marker.claim(input?.identity)) {
      const raced = await marker.read();
      return recoverFrom(raced ?? { identity: null });
    }
  } catch { return { kind: "halt_unavailable" }; }

  let result;
  try { result = await claimOnce(input); }
  catch { return { kind: "outcome_unknown", retryWrite: false,
    reason: "claim_threw" }; }
  if (NO_CLAIM.has(result?.kind)) {
    try { await marker.release(); }
    catch { return { kind: "halt_unavailable" }; }
  }
  return result;
}
