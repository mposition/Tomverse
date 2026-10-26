import { prepareAmuxV19MaxTrackedCheckouts } from
  "./ideaLocalMaxTrackedCheckoutPreflight.mjs";
import { AmuxTrackedCheckoutHostError,
  runAmuxV19TrackedCheckoutAnalysis } from
  "./ideaTrackedCheckoutHostRunner.mjs";

/** Bind every CLI source root to the exact fresh Max claim and its app-pinned
 * references. A missing reference, stopped claim or uncertain read cannot
 * become a partial model invocation. Result receipts remain a separate step.
 * `prompt` may be a function of the prepared reference count; the prepared
 * ordinals and pins are returned for the receipt step to compare against.
 *
 * `beforeCli: true` marks exactly the answers given before the host runner
 * could start a process: the preflight, the prompt and the host runner's own
 * input refusal, which it returns before any stop read or spawn. Nothing else
 * carries it, so a caller may treat it as proof that no CLI ran. Every
 * answer that is not a result names why in one fixed word (`reason`), such as
 * the preflight's stop or network reason; `diagnostic` adds fixed-vocabulary
 * failure codes and never changes what is decided. */
export async function runAmuxV19MaxClaimedTrackedCheckoutOnce(input) {
  const diagnostic = input?.diagnostic === true;
  const beforeCli = (kind, failureStage, reason = failureStage) => ({ kind,
    reason, cliStarted: false, beforeCli: true,
    ...(diagnostic ? { failureStage } : {}) });
  let prepared;
  try {
    prepared = await prepareAmuxV19MaxTrackedCheckouts(input);
  } catch { return beforeCli("outcome_unknown", "prepare_error"); }
  if (prepared.kind !== "ready") return prepared.kind === "refused"
    ? beforeCli("refused", "prepare_refused")
    : beforeCli("outcome_unknown", "prepare_unavailable",
      typeof prepared.reason === "string" ? prepared.reason
        : "prepare_unavailable");
  const references = prepared.references.map(({ referenceOrdinal,
    commitSha }) => ({ referenceOrdinal, commitSha }));
  let prompt;
  try {
    prompt = typeof input.prompt === "function"
      ? input.prompt(references.length) : input.prompt;
  } catch { prompt = null; }
  if (!Buffer.isBuffer(prompt) || prompt.length === 0) {
    return beforeCli("outcome_unknown", "prompt_unavailable");
  }
  try {
    const observed = await runAmuxV19TrackedCheckoutAnalysis({
      references: prepared.references,
      stopCheck: prepared.stopCheck, provider: input.provider,
      modelId: input.modelId, reasoningEffort: input.reasoningEffort,
      prompt, digestSecret: input.digestSecret, diagnostic,
      // Only a diagnostic run may ask for local-only failure names.
      diagnosticDetail: diagnostic && input.diagnosticDetail === true,
    });
    return observed.kind === "refused"
      ? beforeCli("refused", "analysis_refused")
      : { ...observed, preparedReferences: references };
  } catch (error) {
    return { kind: "outcome_unknown", reason: "host_error_thrown",
      cliStarted: error instanceof AmuxTrackedCheckoutHostError
        ? error.cliStarted : true,
      ...(diagnostic ? { failureStage: "host_error_thrown" } : {}) };
  } finally {
    if (prompt !== input.prompt) prompt.fill(0);
  }
}
