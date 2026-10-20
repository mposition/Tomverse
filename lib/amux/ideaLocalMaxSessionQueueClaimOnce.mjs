import { createAmuxV19MaxClaimIdentityFromQueue } from
  "./ideaLocalMaxClaimIdentityFromQueue.mjs";
import { claimAmuxV19MaxShadowBudgetWithHaltOnce } from
  "./ideaLocalMaxClaimWithHalt.mjs";
import { runAmuxV19MaxSessionQueueEntryOnce } from
  "./ideaLocalMaxSessionQueueEntry.mjs";

const USD_MICRO = /^[1-9][0-9]{0,18}$/;
const REASON = /^[a-z_]{1,40}$/;

/** Accept only one fresh queue/price pair. An unknown claim result retains the
 * durable halt marker; the caller must never retry it with another identity. */
export async function claimAmuxV19MaxQueueSelectionOnce(selection, input,
  claimOnce = claimAmuxV19MaxShadowBudgetWithHaltOnce) {
  if (selection?.kind !== "discovered") return {
    kind: selection?.kind ?? "unavailable" };
  const prepared = createAmuxV19MaxClaimIdentityFromQueue(selection);
  if (prepared.kind !== "ready") return { kind: "refused" };
  const identity = prepared.identity;
  let claimed;
  try {
    claimed = await claimOnce({ ...input, identity });
  } catch { return { kind: "outcome_unknown", retryWrite: false }; }
  if (claimed?.kind !== "claimed") return {
    kind: claimed?.kind ?? "outcome_unknown", retryWrite: false,
    ...(["absent", "partial"].includes(claimed?.receiptStatus)
      ? { receiptStatus: claimed.receiptStatus } : {}),
    // A pre-write refusal's fixed code, e.g. budget_hold's monthly_shadow_reached.
    ...(typeof claimed?.reason === "string" && REASON.test(claimed.reason)
      ? { reason: claimed.reason } : {}),
  };
  if (claimed.claimId !== identity.claimId ||
      claimed.requestId !== identity.requestId ||
      claimed.reservationId !== identity.reservationId ||
      claimed.retryWrite !== false || claimed.recovered !== false ||
      !USD_MICRO.test(claimed.reservedMicroUsd ?? "")) return {
    kind: "outcome_unknown", retryWrite: false };
  return { kind: "claimed", identity, claim: claimed,
    retryWrite: false };
}

/** One guarded timer tick. Queue discovery is content-free and the only write
 * is the existing exact budget claim with its local halt and readback rules. */
export async function runAmuxV19MaxSessionQueueClaimOnce(input) {
  let selection;
  try { selection = await runAmuxV19MaxSessionQueueEntryOnce(input); }
  catch { return { kind: "unavailable" }; }
  return claimAmuxV19MaxQueueSelectionOnce(selection, input);
}
