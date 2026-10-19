import { randomUUID } from "node:crypto";

import { inspectAmuxV19MaxShadowClaimIdentity } from
  "./ideaLocalMaxShadowClaimPreflight.mjs";

const UTC_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** Turn one content-free queue and price selection into a fresh claim identity.
 * The app still rechecks scope, model, price, expiry and budget at claim time. */
export function createAmuxV19MaxClaimIdentityFromQueue(selection,
  { newId = randomUUID, now = Date.now() } = {}) {
  const candidate = selection?.candidate;
  const price = selection?.price;
  if (selection?.kind !== "discovered" || price?.kind !== "ready" ||
      !candidate || candidate.modelId !== price.modelId ||
      typeof candidate.expiresAt !== "string" ||
      !UTC_ISO.test(candidate.expiresAt) ||
      !Number.isSafeInteger(now) ||
      !Number.isFinite(Date.parse(candidate.expiresAt)) ||
      new Date(candidate.expiresAt).toISOString() !== candidate.expiresAt ||
      Date.parse(candidate.expiresAt) <= now ||
      typeof newId !== "function") return { kind: "refused" };
  let claimId;
  let requestId;
  try { claimId = newId(); requestId = newId(); }
  catch { return { kind: "refused" }; }
  if (claimId === requestId || claimId === candidate.reservationId ||
      requestId === candidate.reservationId ||
      claimId === candidate.ideaId || requestId === candidate.ideaId) {
    return { kind: "refused" };
  }
  const identity = inspectAmuxV19MaxShadowClaimIdentity({
    claimId, requestId, reservationId: candidate.reservationId,
    ideaId: candidate.ideaId,
    invocationOrdinal: candidate.nextInvocationOrdinal,
    priceVersionId: price.priceVersionId,
    modelId: price.modelId, reasoningEffort: price.reasoningEffort,
  });
  return identity ? { kind: "ready", identity } : { kind: "refused" };
}
