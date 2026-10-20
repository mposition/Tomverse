import { confirmAmuxV19Continue, createAmuxV19StopContact } from
  "./ideaLocalAppRequest.mjs";
import { readAmuxV19SessionBudgetClaimReceipt } from
  "./ideaLocalSessionBudgetClaimReceiptRead.mjs";
import { readAmuxV19MaxCheckoutReference } from
  "./ideaLocalSessionCheckoutReferenceRead.mjs";
import { resolveAmuxV19ClaimCheckoutPath } from
  "./ideaLocalSessionCheckoutPath.mjs";
import { checkAmuxV19MaxSessionAnalysisStop } from
  "./ideaLocalSessionAnalysisStopPoll.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SECRET = /^[A-Za-z0-9_-]{32,256}$/;
const word = (value, fallback) => typeof value === "string" &&
  /^[a-z_]{1,40}$/.test(value) ? value : fallback;

/** Read-only fence between a newly committed Max claim and checkout. A lost
 * claim response, inactive claim, stop request or changed pin never authorizes
 * the CLI; each such answer names why (`reason`). A stop read passes only on
 * the app's explicit continue, and one that goes unanswered is asked again
 * until the stop contact limit. The returned stopCheck (false, true or
 * "unreachable") must still be polled during the invocation. */
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
      receipt.claimStatus !== "in_flight") return { kind: "unavailable",
    reason: receipt.kind === "committed" ? "claim_inactive"
      : word(receipt.reason, "claim_unavailable") };

  const stopCheck = (signal) => checkAmuxV19MaxSessionAnalysisStop({
    origin, claimId, reservationId, ideaId,
    fetchImpl, signal });
  const contact = createAmuxV19StopContact();
  const before = await confirmAmuxV19Continue(stopCheck, contact);
  if (before) return { kind: "unavailable", reason: before };
  const reference = await readAmuxV19MaxCheckoutReference({ origin,
    claimId, reservationId, ideaId, referenceOrdinal, fetchImpl });
  if (reference.kind === "unavailable") return { kind: "unavailable",
    reason: word(reference.reason, "reference_unavailable") };
  const repositoryPath = await resolveAmuxV19ClaimCheckoutPath(
    reference.repository);
  if (!repositoryPath) return { kind: "unavailable",
    reason: "checkout_path_unavailable" };
  const after = await confirmAmuxV19Continue(stopCheck, contact);
  if (after) return { kind: "unavailable", reason: after };
  return { kind: "ready", repositoryPath,
    commitSha: reference.pinnedCommitSha,
    referenceCount: reference.referenceCount, stopCheck };
}

/** Resolve every immutable intake reference before a multi-reference Max
 * attempt. A partial set, changing count, lost claim or stop never grants the
 * caller a checkout list. Each ordinal must fit the DB's signed int32. */
export async function prepareAmuxV19MaxTrackedCheckouts(input) {
  const first = await prepareAmuxV19MaxTrackedCheckout({
    ...input, referenceOrdinal: 0,
  });
  if (first.kind !== "ready") return first;
  const count = first.referenceCount;
  // v19 session intake has no v4 repository/PR item ceiling. Only the DB's
  // signed ordinal representation bounds a single manifest traversal.
  if (!Number.isSafeInteger(count) || count < 1 ||
      count > 2_147_483_647) {
    return { kind: "unavailable", reason: "reference_count_invalid" };
  }
  const references = [{ referenceOrdinal: 0,
    repositoryPath: first.repositoryPath, commitSha: first.commitSha }];
  for (let referenceOrdinal = 1; referenceOrdinal < count;
    referenceOrdinal += 1) {
    const next = await prepareAmuxV19MaxTrackedCheckout({
      ...input, referenceOrdinal,
    });
    if (next.kind !== "ready" || next.referenceCount !== count) {
      return { kind: "unavailable", reason: next.kind === "ready"
        ? "reference_count_changed"
        : word(next.reason, "reference_unavailable") };
    }
    references.push({ referenceOrdinal,
      repositoryPath: next.repositoryPath, commitSha: next.commitSha });
  }
  const last = await confirmAmuxV19Continue(first.stopCheck,
    createAmuxV19StopContact());
  if (last) return { kind: "unavailable", reason: last };
  return { kind: "ready", references, stopCheck: first.stopCheck };
}
