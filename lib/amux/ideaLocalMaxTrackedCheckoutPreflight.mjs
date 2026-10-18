import { readAmuxV19SessionBudgetClaimReceipt } from
  "./ideaLocalSessionBudgetClaimReceiptRead.mjs";
import { readAmuxV19MaxCheckoutReference } from
  "./ideaLocalSessionCheckoutReferenceRead.mjs";
import { resolveAmuxV19ClaimCheckoutPath } from
  "./ideaLocalSessionCheckoutPath.mjs";
import { shouldStopAmuxV19MaxSessionAnalysis } from
  "./ideaLocalSessionAnalysisStopPoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;

/** Read-only fence between a newly committed Max claim and checkout. A lost
 * claim response, inactive claim, stop request or changed pin never authorizes
 * the CLI. The returned stopCheck must still be polled during the invocation. */
export async function prepareAmuxV19MaxTrackedCheckout(input) {
  const { origin, identity, claim, referenceOrdinal,
    fetchImpl = fetch } = input ?? {};
  const secret = process.env.TOMVERSE_AMUX_V19_MAX_LAUNCHER_SECRET;
  if (!SECRET.test(secret ?? "") || typeof fetchImpl !== "function" ||
      !identity || !UUID.test(identity.claimId ?? "") ||
      !UUID.test(identity.requestId ?? "") ||
      !UUID.test(identity.reservationId ?? "") ||
      !UUID.test(identity.ideaId ?? "") ||
      !Number.isSafeInteger(identity.invocationOrdinal) ||
      identity.invocationOrdinal < 0 ||
      identity.invocationOrdinal > 2_147_483_647 ||
      !Number.isSafeInteger(referenceOrdinal) || referenceOrdinal < 0 ||
      referenceOrdinal > 2_147_483_647 ||
      claim?.kind !== "claimed" || claim.recovered !== false ||
      claim.claimId !== identity.claimId ||
      claim.requestId !== identity.requestId ||
      claim.reservationId !== identity.reservationId) {
    return { kind: "refused" };
  }
  const { claimId, requestId, reservationId, ideaId,
    invocationOrdinal } = identity;
  const receipt = await readAmuxV19SessionBudgetClaimReceipt({ origin,
    requestId, reservationId, invocationOrdinal,
    agentSecret: secret, agentId: "amux-intake-max", fetchImpl });
  if (receipt.kind !== "committed" ||
      receipt.claimId !== claimId ||
      receipt.claimStatus !== "in_flight") return { kind: "unavailable" };

  const stopCheck = (signal) => shouldStopAmuxV19MaxSessionAnalysis({
    origin, claimId, reservationId, ideaId,
    fetchImpl, signal });
  if (await stopCheck()) return { kind: "unavailable" };
  const reference = await readAmuxV19MaxCheckoutReference({ origin,
    claimId, reservationId, ideaId, referenceOrdinal, fetchImpl });
  if (reference.kind === "unavailable") return { kind: "unavailable" };
  const repositoryPath = await resolveAmuxV19ClaimCheckoutPath(
    reference.repository);
  if (!repositoryPath || await stopCheck()) return { kind: "unavailable" };
  return { kind: "ready", repositoryPath,
    commitSha: reference.pinnedCommitSha, stopCheck };
}
