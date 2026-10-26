import { AMUX_V19_MAX_CLAIM_REFUSAL_KINDS, claimAmuxV19MaxShadowBudgetOnce } from
  "./ideaLocalMaxShadowClaimOnce.mjs";
import { localAmuxHaltFile } from
  "./ideaLocalRetentionHaltFile.mjs";

/** Answers that prove no claim was written: a local refusal before any
 * network call, or the route's pre-write refusal confirmed absent by the
 * exact readback. */
const NO_CLAIM = new Set(["refused", "auth_unavailable",
  ...AMUX_V19_MAX_CLAIM_REFUSAL_KINDS]);

/** Reserve a durable local stop marker before the first claim write. A
 * committed or uncertain claim retains it until exact result reconciliation;
 * only pre-write refusal can clear it without an operator decision. */
export async function claimAmuxV19MaxShadowBudgetWithHaltOnce(input,
  claimOnce = claimAmuxV19MaxShadowBudgetOnce, haltFile = localAmuxHaltFile) {
  let halt;
  try {
    halt = haltFile(input?.stateDirectory, "analysis");
    if (!await halt.claim()) return { kind: "halted" };
  } catch { return { kind: "halt_unavailable" }; }

  let result;
  try { result = await claimOnce(input); }
  catch { return { kind: "outcome_unknown", retryWrite: false,
    reason: "claim_threw" }; }
  if (NO_CLAIM.has(result?.kind)) {
    try { await halt.release(); }
    catch { return { kind: "halt_unavailable" }; }
  }
  return result;
}
