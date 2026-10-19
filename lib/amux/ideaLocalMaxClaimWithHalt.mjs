import { claimAmuxV19MaxShadowBudgetOnce } from
  "./ideaLocalMaxShadowClaimOnce.mjs";
import { localAmuxHaltFile } from
  "./ideaLocalRetentionHaltFile.mjs";

/** Reserve a durable local stop marker before the first claim write. A
 * committed or uncertain claim retains it until exact result reconciliation;
 * only pre-write refusal can clear it without an operator decision. */
export async function claimAmuxV19MaxShadowBudgetWithHaltOnce(input) {
  let halt;
  try {
    halt = localAmuxHaltFile(input?.stateDirectory, "analysis");
    if (!await halt.claim()) return { kind: "halted" };
  } catch { return { kind: "halt_unavailable" }; }

  let result;
  try { result = await claimAmuxV19MaxShadowBudgetOnce(input); }
  catch { return { kind: "outcome_unknown", retryWrite: false }; }
  if (result.kind === "refused" || result.kind === "auth_unavailable") {
    try { await halt.release(); }
    catch { return { kind: "halt_unavailable" }; }
  }
  return result;
}
