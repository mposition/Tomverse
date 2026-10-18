import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";
import { shouldStopAmuxV19MaxSessionAnalysis } from
  "./ideaLocalSessionAnalysisStopPoll.mjs";
import { recordAmuxV19MaxLocalCheckoutEvidence } from
  "./ideaLocalCheckoutEvidenceReceipt.mjs";
import { recordAmuxV19MaxLocalReadManifest } from
  "./ideaLocalReadManifestReceipt.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

function validBinding(input) {
  try {
    const origin = new URL(input?.origin);
    const sessionOrigin = new URL(process.env[
      AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV]);
    return origin.protocol === "https:" && !origin.username &&
      !origin.password && origin.pathname === "/" && !origin.search &&
      !origin.hash && origin.toString() === sessionOrigin.toString() &&
      input.identity && typeof input.identity === "object" &&
      ["claimId", "requestId", "reservationId", "ideaId"].every((key) =>
        UUID.test(input.identity[key])) &&
      Number.isSafeInteger(input.identity.invocationOrdinal) &&
      input.identity.invocationOrdinal >= 0 &&
      input.identity.invocationOrdinal <= 2_147_483_647 &&
      Number.isSafeInteger(input.referenceOrdinal) &&
      input.referenceOrdinal >= 0 && input.referenceOrdinal <= 2_147_483_647 &&
      SHA.test(input.commitSha) &&
      KEY_ID.test(input.excludedPathDigestKeyId) &&
      typeof input.fetchImpl === "function" &&
      SECRET.test(process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET ?? "");
  } catch { return false; }
}

/** Release the model output only after the exact active Max claim owns both
 * checkout receipts. No failed or uncertain write is repeated. */
export async function finishAmuxV19MaxTrackedCheckoutWithReceipts(input,
  observed) {
  if (!validBinding(input)) return { kind: "refused" };
  if (observed?.kind !== "verified_success") return {
    kind: observed?.kind === "refused" ? "refused" : "outcome_unknown",
    cliStarted: observed?.cliStarted === true,
  };
  if (observed.commitSha !== input.commitSha) {
    return { kind: "outcome_unknown", cliStarted: true };
  }
  const { claimId, requestId, reservationId, ideaId,
    invocationOrdinal } = input.identity;
  const stopped = () => shouldStopAmuxV19MaxSessionAnalysis({
    origin: input.origin, claimId, reservationId, ideaId,
    fetchImpl: input.fetchImpl,
  });
  if (await stopped()) return { kind: "outcome_unknown", cliStarted: true };
  const agentSecret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  const maxClaim = { claimId, requestId, reservationId, invocationOrdinal };
  let evidence;
  try {
    evidence = await recordAmuxV19MaxLocalCheckoutEvidence({
      origin: input.origin, agentSecret, maxClaim, ideaId,
      referenceOrdinal: input.referenceOrdinal,
      excludedPathDigestKeyId: input.excludedPathDigestKeyId,
      observed, fetchImpl: input.fetchImpl,
    });
  } catch { return { kind: "outcome_unknown", cliStarted: true,
    receiptStage: "checkout_evidence" }; }
  if (evidence.kind !== "recorded") return {
    kind: "outcome_unknown", cliStarted: true,
    receiptStage: "checkout_evidence", receiptOutcome: evidence.kind,
  };
  if (await stopped()) return { kind: "outcome_unknown", cliStarted: true,
    evidenceId: evidence.evidenceId };
  let manifest;
  try {
    manifest = await recordAmuxV19MaxLocalReadManifest({
      origin: input.origin, agentSecret, maxClaim, ideaId,
      referenceOrdinal: input.referenceOrdinal,
      pinnedCommitSha: input.commitSha, observed, fetchImpl: input.fetchImpl,
    });
  } catch { return { kind: "outcome_unknown", cliStarted: true,
    evidenceId: evidence.evidenceId, receiptStage: "read_manifest" }; }
  if (manifest.kind !== "recorded") return {
    kind: "outcome_unknown", cliStarted: true,
    evidenceId: evidence.evidenceId, receiptStage: "read_manifest",
    receiptOutcome: manifest.kind,
    ...(manifest.manifestId ? { readManifestId: manifest.manifestId } : {}),
  };
  if (await stopped()) return { kind: "outcome_unknown", cliStarted: true,
    evidenceId: evidence.evidenceId, readManifestId: manifest.manifestId };
  return { ...observed, cliStarted: true,
    evidenceId: evidence.evidenceId, readManifestId: manifest.manifestId };
}
