/**
 * Owner-environment only. Rechecks a complete manifest against an owner-signed
 * confirmation without returning the root, case IDs, labels, or raw content.
 * This is not the app's stage/run admission and never authorizes dispatch.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

import { verifyPromptRefinerVnextOneShotManifestEnvelope } from
  "./promptRefinerQualityEvaluationVnextOneShotManifestEnvelope";
import { canonicalBenchmarkJson, parseBenchmarkJson, strictBenchmarkObject } from
  "./routerDevelopmentBenchmark";

const SHA256 = /^[0-9a-f]{64}$/;
const ATTESTATION_MAX_BYTES = 2048;
const MAX_AGE_MS = 60 * 24 * 60 * 60 * 1000;
const ATTESTATION_KEYS = [
  "version", "ownerId", "confirmedAt", "rootDigest", "preregistrationDigest",
  "independentAuthorshipConfirmed", "semanticLabelsConfirmed",
  "privacyExclusionConfirmed", "hmacSha256",
] as const;

const refuse = (): never => { throw new Error("vnext_one_shot_owner_seal_unavailable"); };

export function verifyPromptRefinerVnextOneShotOwnerSeal(input: Readonly<{
  manifestText: string;
  attestationText: string;
  expectedRootDigest: string;
  expectedPreregistrationDigest: string;
  ownerHmacKey: Uint8Array;
  now: Date;
}>): Readonly<{
  structuralValidation: "pass";
  ownerKeyBindingVerified: true;
  caseCount: 80;
  semanticTruthVerified: false;
  independentAuthorshipVerified: false;
  privacyExclusionVerified: false;
  dispatchAuthorized: false;
}> {
  if (!input || !SHA256.test(input.expectedRootDigest) ||
      !SHA256.test(input.expectedPreregistrationDigest) ||
      !(input.ownerHmacKey instanceof Uint8Array) ||
      input.ownerHmacKey.byteLength < 32 ||
      !(input.now instanceof Date) || !Number.isFinite(input.now.getTime()) ||
      typeof input.attestationText !== "string" ||
      Buffer.byteLength(input.attestationText, "utf8") > ATTESTATION_MAX_BYTES) {
    return refuse();
  }
  let attestation: Record<string, unknown>;
  try {
    attestation = strictBenchmarkObject(
      parseBenchmarkJson(input.attestationText, ATTESTATION_MAX_BYTES),
      ATTESTATION_KEYS, "vnext_one_shot_owner_attestation");
  } catch {
    return refuse();
  }
  const confirmedAt = attestation.confirmedAt;
  if (attestation.version !== "prompt-refiner-vnext-one-shot-owner-seal-v1" ||
      attestation.ownerId !== "mposition" ||
      attestation.rootDigest !== input.expectedRootDigest ||
      attestation.preregistrationDigest !== input.expectedPreregistrationDigest ||
      attestation.independentAuthorshipConfirmed !== true ||
      attestation.semanticLabelsConfirmed !== true ||
      attestation.privacyExclusionConfirmed !== true ||
      typeof confirmedAt !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(confirmedAt) ||
      !SHA256.test(attestation.hmacSha256 as string)) {
    return refuse();
  }
  const confirmedMs = Date.parse(confirmedAt);
  if (!Number.isFinite(confirmedMs) || new Date(confirmedMs).toISOString() !== confirmedAt ||
      confirmedMs > input.now.getTime() ||
      input.now.getTime() - confirmedMs > MAX_AGE_MS) {
    return refuse();
  }
  const { hmacSha256, ...signed } = attestation;
  const actualMac = Buffer.from(hmacSha256 as string, "hex");
  const expectedMac = createHmac("sha256", input.ownerHmacKey)
    .update(canonicalBenchmarkJson(signed), "utf8").digest();
  if (actualMac.length !== expectedMac.length ||
      !timingSafeEqual(actualMac, expectedMac)) return refuse();
  try {
    const structure = verifyPromptRefinerVnextOneShotManifestEnvelope(
      input.manifestText, input.expectedRootDigest,
      input.expectedPreregistrationDigest);
    if (structure.caseCount !== 80 || !structure.manifestShapeClosed ||
        !structure.caseShapeClosed || !structure.duplicateSourceTextRejected) {
      return refuse();
    }
  } catch {
    return refuse();
  }
  return Object.freeze({
    structuralValidation: "pass",
    // The signature proves key possession, not human review of the cases.
    ownerKeyBindingVerified: true,
    caseCount: 80,
    semanticTruthVerified: false,
    independentAuthorshipVerified: false,
    privacyExclusionVerified: false,
    dispatchAuthorized: false,
  });
}

/** Returned bytes are restricted owner material; never log, publish, or send to the app. */
export function createPromptRefinerVnextOneShotOwnerSeal(input: Readonly<{
  manifestText: string;
  expectedRootDigest: string;
  expectedPreregistrationDigest: string;
  ownerHmacKey: Uint8Array;
  now: Date;
  confirmation: string;
}>): string {
  if (input.confirmation !== "I_AM_MPOSITION_AND_VERIFIED_EVERY_LABEL_AND_PRIVACY_EXCLUSION") {
    return refuse();
  }
  const signed = {
    version: "prompt-refiner-vnext-one-shot-owner-seal-v1",
    ownerId: "mposition",
    confirmedAt: input.now.toISOString(),
    rootDigest: input.expectedRootDigest,
    preregistrationDigest: input.expectedPreregistrationDigest,
    independentAuthorshipConfirmed: true,
    semanticLabelsConfirmed: true,
    privacyExclusionConfirmed: true,
  };
  const attestationText = JSON.stringify({
    ...signed,
    hmacSha256: createHmac("sha256", input.ownerHmacKey)
      .update(canonicalBenchmarkJson(signed), "utf8").digest("hex"),
  });
  verifyPromptRefinerVnextOneShotOwnerSeal({
    ...input, attestationText,
  });
  return attestationText;
}
