import { createHash, createHmac, timingSafeEqual } from "node:crypto";

const FIELDS = ["claimId", "requestId", "reservationId", "ideaId",
  "invocationOrdinal", "priceVersionId", "modelId", "reasoningEffort"];
const HEX = /^[a-f0-9]{64}$/;

function payload(identity, authVerifiedAt) {
  return JSON.stringify(["amux-v19-max-shadow-claim-v1", authVerifiedAt,
    ...FIELDS.map((field) => identity[field])]);
}

/** Called only after the fixed Ubuntu launcher verifies Max OAuth metadata. */
export function signAmuxV19MaxClaimAttestation(secret, identity, authVerifiedAt) {
  return createHmac("sha256", secret).update(payload(identity, authVerifiedAt))
    .digest("hex");
}

export function verifyAmuxV19MaxClaimAttestation(secret, identity,
  authVerifiedAt, proof, now = new Date()) {
  if (typeof authVerifiedAt !== "string" || typeof proof !== "string" ||
      !HEX.test(proof) || !Number.isFinite(now.getTime())) return null;
  const verifiedAt = new Date(authVerifiedAt);
  if (!Number.isFinite(verifiedAt.getTime()) ||
      verifiedAt.toISOString() !== authVerifiedAt ||
      verifiedAt.getTime() > now.getTime() + 30_000 ||
      now.getTime() - verifiedAt.getTime() > 5 * 60_000) return null;
  const expected = signAmuxV19MaxClaimAttestation(secret, identity,
    authVerifiedAt);
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(proof, "hex")))
    return null;
  return createHash("sha256").update(proof, "hex").digest("hex");
}
