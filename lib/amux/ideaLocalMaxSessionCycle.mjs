import { createHmac } from "node:crypto";

import { amuxV19SessionPromptForClaim } from
  "./ideaSessionAnalysisPromptCore.ts";
import { runAmuxV19MaxClaimedTrackedCheckoutOnce } from
  "./ideaLocalMaxClaimedTrackedCheckoutOnce.mjs";
import { readAmuxV19MaxClaimedIdeaOnce } from "./ideaLocalMaxIdeaRead.mjs";
import { runAmuxV19MaxSessionQueueClaimOnce } from
  "./ideaLocalMaxSessionQueueClaimOnce.mjs";
import { settleAmuxV19MaxShadowResultOnce } from
  "./ideaLocalMaxShadowResultOnce.mjs";
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
/** The only text a cycle reason may carry: a lowercase code. IDs, prices,
 * paths and model names all contain a digit, a hyphen, a dot or a slash. */
export const AMUX_V19_SESSION_CYCLE_WORD = /^[a-z_]{1,40}$/;

const word = (value) => typeof value === "string" &&
  AMUX_V19_SESSION_CYCLE_WORD.test(value) ? value : null;
const bounded = (value, min, max) => Number.isSafeInteger(value) &&
  value >= min && value <= max ? value : null;

/** Why one analysis did not verify, from the diagnostic observation, as
 * lowercase codes and bounded counts only. The parser's reported usage model
 * names, stderr text and model output are never copied. */
export function amuxV19SessionAnalysisFailure(observed) {
  const parser = observed?.parserReason;
  const cliError = observed?.cliError;
  return Object.freeze({
    reason: word(observed?.kind) ?? "unavailable",
    cliStarted: typeof observed?.cliStarted === "boolean"
      ? observed.cliStarted : null,
    beforeCli: observed?.beforeCli === true,
    failure: word(observed?.failureStage),
    parser: word(parser?.code),
    trace: word(parser?.traceReason),
    stderr: word(observed?.stderrClass),
    cliError: word(cliError?.assistantError),
    terminal: word(cliError?.terminalReason),
    apiStatus: bounded(cliError?.apiErrorStatus, 100, 599),
    exit: bounded(observed?.childExitCode, 0, 255),
    approved: bounded(observed?.approvedConnects, 0, 1_000_000),
    denied: bounded(observed?.deniedConnects, 0, 1_000_000),
  });
}

const defaultSteps = Object.freeze({
  claim: runAmuxV19MaxSessionQueueClaimOnce,
  readIdea: readAmuxV19MaxClaimedIdeaOnce,
  analyse: runAmuxV19MaxClaimedTrackedCheckoutOnce,
  finalize: finalizeAmuxV19MaxSessionResultWithReceipts,
  reportUnknown: settleAmuxV19MaxShadowResultOnce,
  haltFile: localAmuxHaltFile,
});

/** One timer tick of the v19 session analysis (amux-intake v19 item 4):
 * discover, claim, read the page prompt, analyse, receipts, result. A later
 * page of the same idea is simply the next claim the queue offers. Every step after
 * the claim either records the result or stops with the claim and the local
 * halt marker in place; nothing here is retried, and an unknown outcome is
 * for the operator. Only a recorded result releases the marker.
 *
 * An analysis that did not verify may still have used the subscription, so
 * unless the CLI provably never started (`beforeCli`), its claim is held once
 * as outcome_unknown through the existing unknown route, whose lost answer is
 * only read back, never resent. The operator then resolves that claim in
 * Admin and removes the marker by hand. */
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
  const analysisStopped = async (observed) => {
    const analysis = amuxV19SessionAnalysisFailure(observed);
    if (analysis.beforeCli) return { ...stop("analysis"), analysis,
      unknownReport: "not_sent_before_cli" };
    let unknownReport = "unconfirmed";
    let receipt = null;
    try {
      const reported = await steps.reportUnknown({ origin, fetchImpl,
        input: { claimId: identity.claimId, requestId: identity.requestId,
          reservationId: identity.reservationId, ideaId: identity.ideaId,
          invocationOrdinal: identity.invocationOrdinal,
          outcome: "outcome_unknown", inputTokens: null, outputTokens: null } });
      if (reported?.kind === "recorded" &&
          reported.status === "outcome_unknown") {
        unknownReport = reported.recovered === true ? "read_back" : "recorded";
      } else if (reported?.kind === "refused") unknownReport = "refused";
      receipt = word(reported?.receiptStatus);
    } catch { /* The write may have landed: leave it to the receipt read. */ }
    return { ...stop("analysis"), analysis, unknownReport,
      ...(receipt ? { receipt } : {}) };
  };
  let idea;
  try { idea = await steps.readIdea({ origin, selection: claimed, fetchImpl }); }
  catch { return stop("idea_read"); }
  if (idea?.kind !== "ready") return stop("idea_read");
  let promptHold = false;
  const prompt = (referenceCount) => {
    const text = amuxV19SessionPromptForClaim({ claimId: identity.claimId,
      pagePrompt: idea.prompt, referenceCount, provider: identity.provider });
    if (text === null) {
      promptHold = true;
      return null;
    }
    return Buffer.from(text, "utf8");
  };
  const digestSecret = createHmac("sha256", secret)
    .update(`amux-v19-excluded-path-digest\0${identity.claimId}`)
    .digest("hex");
  let observed;
  try {
    // Diagnostic mode only adds fixed failure codes to a failed observation
    // (and file-tool counts to a verified one, which the receipt step does
    // not copy); stderr is classified, never kept.
    observed = await steps.analyse({ origin, fetchImpl, identity,
      claim: claimed.claim, provider: identity.provider,
      modelId: identity.modelId,
      reasoningEffort: identity.reasoningEffort, prompt, digestSecret,
      diagnostic: true });
  } catch { return analysisStopped({ kind: "analysis_threw" }); }
  if (promptHold) return stop("prompt");
  if (observed?.kind !== "verified_success") return analysisStopped(observed);
  if (!Array.isArray(observed.preparedReferences)) {
    return analysisStopped({ ...observed, kind: "references_missing" });
  }
  let result;
  try {
    result = await steps.finalize({ origin, fetchImpl,
      identity: { claimId: identity.claimId, requestId: identity.requestId,
        reservationId: identity.reservationId, ideaId: identity.ideaId,
        invocationOrdinal: identity.invocationOrdinal },
      provider: identity.provider,
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
