import { createAmuxV19MaxClaimIdentityFromQueue } from
  "./ideaLocalMaxClaimIdentityFromQueue.mjs";
import { claimAmuxV19MaxShadowBudgetWithHaltOnce } from
  "./ideaLocalMaxClaimWithHalt.mjs";
import { runAmuxV19MaxSessionQueueEntryOnce } from
  "./ideaLocalMaxSessionQueueEntry.mjs";

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
    kind: claimed?.kind ?? "outcome_unknown", retryWrite: false };
  if (claimed.claimId !== identity.claimId ||
      claimed.requestId !== identity.requestId ||
      claimed.reservationId !== identity.reservationId ||
      claimed.retryWrite !== false) return {
    kind: "outcome_unknown", retryWrite: false };
  return { kind: "claimed", identity,
    reservedMicroUsd: claimed.reservedMicroUsd,
    recovered: claimed.recovered, retryWrite: false };
}

/** One guarded timer tick. Queue discovery is content-free and the only write
 * is the existing exact budget claim with its local halt and readback rules. */
export async function runAmuxV19MaxSessionQueueClaimOnce(input) {
  let selection;
  try { selection = await runAmuxV19MaxSessionQueueEntryOnce(input); }
  catch { return { kind: "unavailable" }; }
  return claimAmuxV19MaxQueueSelectionOnce(selection, input);
}
