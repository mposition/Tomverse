import { prepareAmuxV19MaxTrackedCheckouts } from
  "./ideaLocalMaxTrackedCheckoutPreflight.mjs";
import { AmuxTrackedCheckoutHostError,
  runAmuxV19TrackedCheckoutAnalysis } from
  "./ideaTrackedCheckoutHostRunner.mjs";

/** Bind every CLI source root to the exact fresh Max claim and its app-pinned
 * references. A missing reference, stopped claim or uncertain read cannot
 * become a partial model invocation. Result receipts remain a separate step. */
export async function runAmuxV19MaxClaimedTrackedCheckoutOnce(input) {
  let prepared;
  try {
    prepared = await prepareAmuxV19MaxTrackedCheckouts(input);
  } catch { return { kind: "outcome_unknown", cliStarted: false }; }
  if (prepared.kind !== "ready") return {
    kind: prepared.kind === "refused" ? "refused" : "outcome_unknown",
    cliStarted: false,
  };
  try {
    const observed = await runAmuxV19TrackedCheckoutAnalysis({
      references: prepared.references,
      stopCheck: prepared.stopCheck,
      modelId: input.modelId, reasoningEffort: input.reasoningEffort,
      prompt: input.prompt, digestSecret: input.digestSecret,
    });
    return observed.kind === "refused" ? { kind: "refused",
      cliStarted: false } : observed;
  } catch (error) {
    return { kind: "outcome_unknown",
      cliStarted: error instanceof AmuxTrackedCheckoutHostError
        ? error.cliStarted : true };
  }
}
