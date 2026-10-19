import { isAmuxIdeaAnalysisProvider } from "./ideaAnalysisChannelCore.ts";
import { AMUX_V19_SESSION_ANALYSIS_APP_ORIGIN_ENV } from
  "./ideaLocalSessionAnalysisQueuePoll.mjs";
import { validAmuxTrackedCheckoutReadPath } from
  "./ideaTrackedCheckoutReadManifestCore.ts";
import { shouldStopAmuxV19MaxSessionAnalysis } from
  "./ideaLocalSessionAnalysisStopPoll.mjs";
import { recordAmuxV19MaxLocalCheckoutEvidence } from
  "./ideaLocalCheckoutEvidenceReceipt.mjs";
import { recordAmuxV19MaxLocalReadManifest } from
  "./ideaLocalReadManifestReceipt.mjs";
import { recordAmuxV19MaxSessionResultOnce } from
  "./ideaLocalMaxSessionResultOnce.mjs";

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

/** The CLI sees one read-only root per pinned reference. Keep its prefixed
 * paths confined to that root and record every claim-bound receipt before the
 * answer may be sent to the app. A partial receipt set is never retried. */
export async function finishAmuxV19MaxTrackedCheckoutsWithReceipts(input,
  observed) {
  const references = input?.references;
  if (!Array.isArray(references) || references.length < 1 ||
      !references.every((reference, ordinal) =>
        reference?.referenceOrdinal === ordinal &&
        SHA.test(reference.commitSha ?? "")) ||
      !validBinding({ ...input, referenceOrdinal: 0,
        commitSha: references[0].commitSha })) return { kind: "refused" };
  if (observed?.kind !== "verified_success") return {
    kind: observed?.kind === "refused" ? "refused" : "outcome_unknown",
    cliStarted: observed?.cliStarted === true,
  };
  const checked = observed.references;
  if (observed.cliStarted !== true || !Array.isArray(checked) ||
      checked.length !== references.length ||
      !Array.isArray(observed.readFiles) ||
      !references.every((reference, ordinal) =>
        checked[ordinal]?.referenceOrdinal === ordinal &&
        checked[ordinal].commitSha === reference.commitSha)) return {
    kind: "outcome_unknown", cliStarted: observed.cliStarted === true,
  };
  const readFiles = references.map(() => []);
  const seenPaths = new Set();
  for (const path of observed.readFiles) {
    if (typeof path !== "string") return {
      kind: "outcome_unknown", cliStarted: true };
    const match = /^reference-(0|[1-9][0-9]*)\/(.+)$/.exec(path);
    const ordinal = match && Number(match[1]);
    const relative = match?.[2];
    if (!match || !Number.isSafeInteger(ordinal) ||
        ordinal >= references.length ||
        !validAmuxTrackedCheckoutReadPath(relative) ||
        seenPaths.has(path)) return {
      kind: "outcome_unknown", cliStarted: true };
    seenPaths.add(path);
    readFiles[ordinal].push(relative);
  }
  let first;
  for (let ordinal = 0; ordinal < references.length; ordinal += 1) {
    const checkedReference = checked[ordinal];
    const finished = await finishAmuxV19MaxTrackedCheckoutWithReceipts({
      ...input, referenceOrdinal: ordinal,
      commitSha: references[ordinal].commitSha,
    }, { kind: "verified_success", cliStarted: true,
      commitSha: checkedReference.commitSha,
      excludedCount: checkedReference.excludedCount,
      excludedPathDigest: checkedReference.excludedPathDigest,
      excludedReasons: checkedReference.excludedReasons,
      readFiles: readFiles[ordinal],
      rawModelOutput: observed.rawModelOutput,
      inputTokens: observed.inputTokens,
      outputTokens: observed.outputTokens });
    if (finished.kind !== "verified_success" ||
        !UUID.test(finished.evidenceId ?? "") ||
        !UUID.test(finished.readManifestId ?? "")) return {
      kind: "outcome_unknown", cliStarted: true,
      receiptStage: finished.receiptStage ?? "reference_receipt",
    };
    if (ordinal === 0) first = finished;
  }
  return first;
}

/** The runner's record of how the answer was produced: the claim's channel,
 * whether that CLI named the answering model, and the staged CLI's sha256. */
export function validAmuxV19CliAttestation(value, provider) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 3 && isAmuxIdeaAnalysisProvider(provider) &&
    value.provider === provider &&
    (value.modelAttestation === "served" || value.modelAttestation === "requested") &&
    typeof value.cliSha256 === "string" && /^[a-f0-9]{64}$/.test(value.cliSha256);
}

/** The only success path from a completed subscription CLI observation to the
 * app: exact checkout receipts first, then one result-and-budget transaction.
 * The CLI already ran, so a missing channel attestation is an unknown outcome. */
export async function finalizeAmuxV19MaxSessionResultWithReceipts(
  input, observed) {
  if (observed?.kind === "verified_success" &&
      !validAmuxV19CliAttestation(observed.cliAttestation,
        input?.provider ?? "anthropic")) {
    return { kind: "outcome_unknown", retryWrite: false };
  }
  const multiple = Array.isArray(input?.references) ||
    Array.isArray(observed?.references);
  const finished = multiple
    ? await finishAmuxV19MaxTrackedCheckoutsWithReceipts(input, observed)
    : await finishAmuxV19MaxTrackedCheckoutWithReceipts(input, observed);
  if (finished.kind !== "verified_success" ||
      !UUID.test(finished.evidenceId ?? "") ||
      !UUID.test(finished.readManifestId ?? "")) {
    return { kind: finished.kind === "refused" ? "refused" :
      "outcome_unknown", retryWrite: false };
  }
  if (await shouldStopAmuxV19MaxSessionAnalysis({
    origin: input.origin, claimId: input.identity.claimId,
    reservationId: input.identity.reservationId,
    ideaId: input.identity.ideaId, fetchImpl: input.fetchImpl,
  })) return { kind: "outcome_unknown", retryWrite: false };
  const result = await recordAmuxV19MaxSessionResultOnce({
    origin: input.origin, fetchImpl: input.fetchImpl,
    input: { ...input.identity,
      referenceOrdinal: multiple ? 0 : input.referenceOrdinal,
      evidenceId: finished.evidenceId,
      manifestId: finished.readManifestId,
      rawModelOutput: finished.rawModelOutput,
      inputTokens: finished.inputTokens,
      outputTokens: finished.outputTokens,
      cliAttestation: { ...observed.cliAttestation } },
  });
  return result.kind === "recorded" ? result : {
    kind: "outcome_unknown", retryWrite: false,
  };
}
