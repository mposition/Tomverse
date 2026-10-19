import { prepareAmuxV19MaxTrackedCheckouts } from
  "./ideaLocalMaxTrackedCheckoutPreflight.mjs";
import { AmuxTrackedCheckoutHostError,
  runAmuxV19TrackedCheckoutAnalysis } from
  "./ideaTrackedCheckoutHostRunner.mjs";

/** Bind every CLI source root to the exact fresh Max claim and its app-pinned
 * references. A missing reference, stopped claim or uncertain read cannot
 * become a partial model invocation. Result receipts remain a separate step.
 * `prompt` may be a function of the prepared reference count; the prepared
 * ordinals and pins are returned for the receipt step to compare against. */
export async function runAmuxV19MaxClaimedTrackedCheckoutOnce(input) {
  let prepared;
  try {
    prepared = await prepareAmuxV19MaxTrackedCheckouts(input);
  } catch { return { kind: "outcome_unknown", cliStarted: false }; }
  if (prepared.kind !== "ready") return {
    kind: prepared.kind === "refused" ? "refused" : "outcome_unknown",
    cliStarted: false,
  };
  const references = prepared.references.map(({ referenceOrdinal,
    commitSha }) => ({ referenceOrdinal, commitSha }));
  let prompt;
  try {
    prompt = typeof input.prompt === "function"
      ? input.prompt(references.length) : input.prompt;
  } catch { prompt = null; }
  if (!Buffer.isBuffer(prompt) || prompt.length === 0) {
    return { kind: "outcome_unknown", cliStarted: false };
  }
  try {
    const observed = await runAmuxV19TrackedCheckoutAnalysis({
      references: prepared.references,
      stopCheck: prepared.stopCheck,
      modelId: input.modelId, reasoningEffort: input.reasoningEffort,
      prompt, digestSecret: input.digestSecret,
    });
    return observed.kind === "refused" ? { kind: "refused",
      cliStarted: false } : { ...observed, preparedReferences: references };
  } catch (error) {
    return { kind: "outcome_unknown",
      cliStarted: error instanceof AmuxTrackedCheckoutHostError
        ? error.cliStarted : true };
  } finally {
    if (prompt !== input.prompt) prompt.fill(0);
  }
}
