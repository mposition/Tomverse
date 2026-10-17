import { recordAmuxV19VerifiedCheckoutReceipts } from
  "./ideaLocalCheckoutEvidenceReceipt.mjs";
import { AMUX_V4_ANALYSIS_APP_ORIGIN_ENV } from "./ideaLocalQueuePoll.mjs";
import { AmuxTrackedCheckoutHostError,
  runAmuxV19TrackedCheckoutAnalysis } from
  "./ideaTrackedCheckoutHostRunner.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function validReceiptBinding(input) {
  try {
    const origin = new URL(input?.origin);
    const configured = new URL(process.env[AMUX_V4_ANALYSIS_APP_ORIGIN_ENV] ?? "");
    return origin.protocol === "https:" && !origin.username &&
      !origin.password && origin.pathname === "/" && !origin.search &&
      !origin.hash && origin.toString() === configured.toString() &&
      typeof input.ideaId === "string" && UUID.test(input.ideaId) &&
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
  if (!validReceiptBinding(input)) return { kind: "refused" };
  let observed;
  try { observed = await runAmuxV19TrackedCheckoutAnalysis(input); }
  catch (error) {
    return { kind: "outcome_unknown",
      cliStarted: error instanceof AmuxTrackedCheckoutHostError
        ? error.cliStarted : true };
  }
  return finishAmuxV19TrackedCheckoutWithReceipts(input, observed);
}
