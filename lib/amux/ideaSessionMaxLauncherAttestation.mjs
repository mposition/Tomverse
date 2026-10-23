import { createHash, createHmac, timingSafeEqual } from "node:crypto";

// v2 binds the CLI channel whose subscription sign-in the launcher checked
// (owner decision 2026-10-20); the app records the claim on that channel.
const FIELDS = ["claimId", "requestId", "reservationId", "ideaId",
  "invocationOrdinal", "priceVersionId", "provider", "modelId",
  "reasoningEffort"];
const HEX = /^[a-f0-9]{64}$/;

function payload(identity, authVerifiedAt) {
  return JSON.stringify(["amux-v19-max-shadow-claim-v2", authVerifiedAt,
    ...FIELDS.map((field) => identity[field])]);
}

/** Called only after the fixed Ubuntu launcher verifies the channel's
 * subscription sign-in metadata. */
export function signAmuxV19MaxClaimAttestation(secret, identity, authVerifiedAt) {
  return createHmac("sha256", secret).update(payload(identity, authVerifiedAt))
    .digest("hex");
}

export function verifyAmuxV19MaxClaimAttestation(secret, identity,
  authVerifiedAt, proof, now = new Date()) {
  if (typeof authVerifiedAt !== "string" || typeof proof !== "string" ||
      !HEX.test(proof) || !Number.isFinite(now.getTime()) ||
      typeof identity?.provider !== "string") return null;
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
