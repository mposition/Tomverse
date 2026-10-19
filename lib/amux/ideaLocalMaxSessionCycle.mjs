import { createHmac } from "node:crypto";

import { buildAmuxV19SessionAnalysisPrompt } from
  "./ideaSessionAnalysisPromptCore.ts";
import { runAmuxV19MaxClaimedTrackedCheckoutOnce } from
  "./ideaLocalMaxClaimedTrackedCheckoutOnce.mjs";
import { readAmuxV19MaxClaimedIdeaOnce } from "./ideaLocalMaxIdeaRead.mjs";
import { runAmuxV19MaxSessionQueueClaimOnce } from
  "./ideaLocalMaxSessionQueueClaimOnce.mjs";
import { finalizeAmuxV19MaxSessionResultWithReceipts } from
  "./ideaLocalMaxTrackedCheckoutReceipts.mjs";
import { localAmuxHaltFile } from "./ideaLocalRetentionHaltFile.mjs";

export const AMUX_V19_MAX_SESSION_CYCLE_ENV =
  "TOMVERSE_AMUX_V19_MAX_SESSION_CYCLE";
/** Excluded-path digests are keyed by the launcher secret per claim, so the
 * operator can recompute one without another runner secret. */
export const AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID =
  "amux-v19-launcher-claim-hmac-v1";
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

const defaultSteps = Object.freeze({
  claim: runAmuxV19MaxSessionQueueClaimOnce,
  readIdea: readAmuxV19MaxClaimedIdeaOnce,
  analyse: runAmuxV19MaxClaimedTrackedCheckoutOnce,
  finalize: finalizeAmuxV19MaxSessionResultWithReceipts,
  haltFile: localAmuxHaltFile,
});

/** One timer tick of the v19 session analysis (amux-intake v19 item 4):
 * discover, claim, read, prompt, analyse, receipts, result. Every step after
 * the claim either records the result or stops with the claim and the local
 * halt marker in place; nothing here is retried, and an unknown outcome is
 * for the operator. Only a recorded result releases the marker. */
export async function runAmuxV19MaxSessionCycleOnce(input,
  steps = defaultSteps) {
  if (process.env[AMUX_V19_MAX_SESSION_CYCLE_ENV] !== "enabled") {
    return { kind: "disabled" };
  }
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!SECRET.test(secret ?? "")) return { kind: "refused" };
  const { origin, fetchImpl, stateDirectory } = input ?? {};
  let claimed;
  try { claimed = await steps.claim({ origin, fetchImpl, stateDirectory }); }
  catch { return { kind: "outcome_unknown", stage: "claim" }; }
  if (claimed?.kind !== "claimed") {
    return { kind: claimed?.kind ?? "outcome_unknown", stage: "claim" };
  }
  const { identity } = claimed;
  const stop = (stage) => ({ kind: "outcome_unknown", stage,
    claimId: identity.claimId });
  let idea;
  try { idea = await steps.readIdea({ origin, selection: claimed, fetchImpl }); }
  catch { return stop("idea_read"); }
  if (idea?.kind !== "ready") return stop("idea_read");
  let promptHold = false;
  const prompt = (referenceCount) => {
    const built = buildAmuxV19SessionAnalysisPrompt({
      claimId: identity.claimId, idea: idea.idea, referenceCount });
    if (built.status !== "prompt_candidate") {
      promptHold = true;
      return null;
    }
    return Buffer.from(built.prompt, "utf8");
  };
  const digestSecret = createHmac("sha256", secret)
    .update(`amux-v19-excluded-path-digest\0${identity.claimId}`)
    .digest("hex");
  let observed;
  try {
    observed = await steps.analyse({ origin, fetchImpl, identity,
      claim: claimed.claim, modelId: identity.modelId,
      reasoningEffort: identity.reasoningEffort, prompt, digestSecret });
  } catch { return stop("analysis"); }
  if (promptHold) return stop("prompt");
  if (observed?.kind !== "verified_success" ||
      !Array.isArray(observed.preparedReferences)) return stop("analysis");
  let result;
  try {
    result = await steps.finalize({ origin, fetchImpl,
      identity: { claimId: identity.claimId, requestId: identity.requestId,
        reservationId: identity.reservationId, ideaId: identity.ideaId,
        invocationOrdinal: identity.invocationOrdinal },
      references: observed.preparedReferences,
      excludedPathDigestKeyId: AMUX_V19_EXCLUDED_PATH_DIGEST_KEY_ID,
    }, observed);
  } catch { return stop("result"); }
  if (result?.kind !== "recorded") return stop("result");
  try { await steps.haltFile(stateDirectory, "analysis").release(); }
  catch { return { kind: "recorded", claimId: identity.claimId,
    haltReleased: false, planState: result.planState ?? null,
    registrationState: result.registrationState ?? null }; }
  return { kind: "recorded", claimId: identity.claimId, haltReleased: true,
    planState: result.planState ?? null,
    registrationState: result.registrationState ?? null };
}
