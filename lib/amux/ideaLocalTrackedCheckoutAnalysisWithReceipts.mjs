import { recordAmuxV19VerifiedCheckoutReceipts } from
  "./ideaLocalCheckoutEvidenceReceipt.mjs";
import { AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from "./ideaLocalQueuePoll.mjs";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";
import { readAmuxV19SessionBudgetClaimReceipt } from
  "./ideaLocalSessionBudgetClaimReceiptRead.mjs";
import { shouldStopAmuxV19SessionAnalysis } from
  "./ideaLocalSessionAnalysisStopPoll.mjs";
import { readAmuxV19SessionCheckoutReference } from
  "./ideaLocalSessionCheckoutReferenceRead.mjs";
import { resolveAmuxV19ClaimCheckoutPath } from
  "./ideaLocalSessionCheckoutPath.mjs";
import { AmuxTrackedCheckoutHostError,
  AMUX_V19_TRACKED_CHECKOUT_CLI_ENV, runAmuxV19TrackedCheckoutAnalysis } from
  "./ideaTrackedCheckoutHostRunner.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function validReceiptBinding(input) {
  try {
    const origin = new URL(input?.origin);
    const configured = new URL(process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] ?? "");
    const sessionConfigured = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV] ?? "");
    return origin.protocol === "https:" && !origin.username &&
      !origin.password && origin.pathname === "/" && !origin.search &&
      !origin.hash && origin.toString() === configured.toString() &&
      origin.toString() === sessionConfigured.toString() &&
      typeof input.ideaId === "string" && UUID.test(input.ideaId) &&
      typeof input.claimId === "string" && UUID.test(input.claimId) &&
      typeof input.reservationId === "string" && UUID.test(input.reservationId) &&
      typeof input.requestId === "string" && UUID.test(input.requestId) &&
      Number.isSafeInteger(input.invocationOrdinal) &&
      input.invocationOrdinal >= 0 &&
      input.invocationOrdinal <= 2_147_483_647 &&
      Number.isSafeInteger(input.referenceOrdinal) &&
      input.referenceOrdinal >= 0 && input.referenceOrdinal <= 2_147_483_647 &&
      typeof input.commitSha === "string" && SHA.test(input.commitSha) &&
      typeof input.agentSecret === "string" &&
      SECRET.test(input.agentSecret) &&
      typeof input.excludedPathDigestKeyId === "string" &&
      KEY_ID.test(input.excludedPathDigestKeyId) &&
      typeof input.fetchImpl === "function";
  } catch { return false; }
}

/** The exact claim owns the stop poll. A caller-supplied stopCheck cannot
 * bypass a cancelled claim or an unavailable app read. */
export function bindAmuxV19ClaimStopCheck(input) {
  if (!validReceiptBinding(input)) return null;
  const { origin, agentSecret, claimId, reservationId, ideaId,
    fetchImpl } = input;
  return (signal) => shouldStopAmuxV19SessionAnalysis({
    origin, agentSecret, claimId, reservationId, ideaId, fetchImpl, signal,
  });
}

/** Do not release a verified CLI result until both checkout evidence and
 * the exact read manifest have durable receipts. Raw output stays local on
 * uncertainty; the caller must halt rather than replay the invocation. */
export async function finishAmuxV19TrackedCheckoutWithReceipts(input, observed) {
  if (!validReceiptBinding(input)) return { kind: "refused" };
  if (observed?.kind !== "verified_success") {
    return { kind: observed?.kind === "refused" ? "refused" : "outcome_unknown",
      cliStarted: observed?.cliStarted === true };
  }
  if (observed.commitSha !== input.commitSha) {
    return { kind: "outcome_unknown", cliStarted: true };
  }
  let receipt;
  try {
    receipt = await recordAmuxV19VerifiedCheckoutReceipts({
      origin: input.origin, agentSecret: input.agentSecret,
      ideaId: input.ideaId, referenceOrdinal: input.referenceOrdinal,
      excludedPathDigestKeyId: input.excludedPathDigestKeyId,
      observed, fetchImpl: input.fetchImpl,
    });
  } catch { return { kind: "outcome_unknown", cliStarted: true }; }
  if (receipt.kind !== "recorded") {
    return { kind: "outcome_unknown", cliStarted: true,
      receiptStage: receipt.stage, receiptOutcome: receipt.kind,
      ...(receipt.evidenceId ? { evidenceId: receipt.evidenceId } : {}),
      ...(receipt.manifestId ? { readManifestId: receipt.manifestId } : {}) };
  }
  return { ...observed, cliStarted: true, evidenceId: receipt.evidenceId,
    readManifestId: receipt.manifestId };
}

/** One approved Linux tracked-checkout attempt and its two app receipts.
 * The existing host switch, admission, budget and stop checks still apply. */
export async function runAmuxV19TrackedCheckoutAnalysisWithReceipts(input) {
  const stopCheck = bindAmuxV19ClaimStopCheck(input);
  if (!stopCheck) return { kind: "refused" };
  let repositoryPath = input.repositoryPath;
  // Preserve the closed host's no-network behavior. When enabled, an exact
  // in-flight claim must resolve its sealed-intake checkout target before any
  // checkout or CLI. The returned SHA is the only commit accepted downstream.
  if (process.platform === "linux" &&
      process.env[AMUX_V19_TRACKED_CHECKOUT_CLI_ENV] === "enabled") {
    const budget = await readAmuxV19SessionBudgetClaimReceipt(input);
    if (budget.kind !== "committed" ||
        budget.claimId !== input.claimId ||
        budget.claimStatus !== "in_flight") {
      return { kind: "outcome_unknown", cliStarted: false };
    }
    const target = await readAmuxV19SessionCheckoutReference(input);
    if (target.kind === "unavailable" ||
        target.pinnedCommitSha !== input.commitSha) {
      return { kind: "outcome_unknown", cliStarted: false };
    }
    repositoryPath = await resolveAmuxV19ClaimCheckoutPath(target.repository);
    if (!repositoryPath) return { kind: "outcome_unknown", cliStarted: false };
  }
  let observed;
  try { observed = await runAmuxV19TrackedCheckoutAnalysis({
    ...input, repositoryPath, stopCheck,
  }); }
  catch (error) {
    return { kind: "outcome_unknown",
      cliStarted: error instanceof AmuxTrackedCheckoutHostError
        ? error.cliStarted : true };
  }
  return finishAmuxV19TrackedCheckoutWithReceipts(input, observed);
}
