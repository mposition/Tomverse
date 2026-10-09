/**
 * Restricted owner evidence for the provider-free A17 runner preflight.
 * The root crosses the owner-only POST boundary transiently; it is never an
 * audit field, readback field, log value, or public artifact.
 */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";

import { canonicalBenchmarkJson } from "./routerDevelopmentBenchmark";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const commit = z.string().regex(/^[0-9a-f]{40}$/);
const id = z.string().min(1).max(128);
const deploymentId = z.string().regex(
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);

export const PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT = Object.freeze({
  preflight: "passed", caseCount: 80, syntheticTransportCalls: 80,
  dispatchAuthorized: false,
});

export const PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST =
  createHash("sha256").update(canonicalBenchmarkJson(
    PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT), "utf8").digest("hex");

export const promptRefinerVnextOneShotShadowTargetSchema = z.object({
  stageApprovalAuditLogId: id,
  runApprovalAuditLogId: id,
  sourceCommitSha: commit,
  sourceManifestDigest: sha256,
  runnerDigest: sha256,
  runtimeDeploymentId: deploymentId,
  runtimeCommitSha: commit,
  pricePinDigest: sha256,
  perRequestCostMicroUsd: z.literal(29_918),
  costCeilingMicroUsd: z.literal(2_393_440),
  slotCount: z.literal(80),
  reservedSlots: z.literal(80),
  consumedSlots: z.literal(0),
}).strict();

const signedSchema = promptRefinerVnextOneShotShadowTargetSchema.extend({
  version: z.literal("prompt-refiner-vnext-one-shot-shadow-proof-v1"),
  manifestRoot: sha256,
  runnerPreflightDigest: z.literal(
    PROMPT_REFINER_VNEXT_ONE_SHOT_RUNNER_PREFLIGHT_DIGEST),
  cacheWriteInputTokens: z.literal(0),
  providerCalls: z.literal(0),
  slotConsumeCalls: z.literal(0),
  signedAt: z.string().datetime({ offset: false }),
}).strict();

export const promptRefinerVnextOneShotShadowProofSchema = signedSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();

export type PromptRefinerVnextOneShotShadowProof =
  z.infer<typeof promptRefinerVnextOneShotShadowProofSchema>;
export type PromptRefinerVnextOneShotShadowTarget =
  z.infer<typeof promptRefinerVnextOneShotShadowTargetSchema>;

const refuse = (): never => { throw new Error("vnext_one_shot_shadow_proof_invalid"); };

function keyFromBase64(value: string, kind: "public" | "private") {
  if (typeof value !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(value) ||
      value.length > 4096) return refuse();
  const der = Buffer.from(value, "base64");
  if (der.length < 32 || der.length > 2048 || der.toString("base64") !== value) {
    return refuse();
  }
  try {
    const key = kind === "public" ? createPublicKey({ key: der, format: "der",
      type: "spki" }) : createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") return refuse();
    return key;
  } catch { return refuse(); }
}

export function promptRefinerVnextOneShotShadowPublicKeyDigest(
  publicKeyDerBase64: string,
): string {
  keyFromBase64(publicKeyDerBase64, "public");
  return createHash("sha256")
    .update(Buffer.from(publicKeyDerBase64, "base64")).digest("hex");
}

export function signPromptRefinerVnextOneShotShadowProof(
  value: unknown, privateKeyDerBase64: string,
): PromptRefinerVnextOneShotShadowProof {
  const parsed = signedSchema.safeParse(value);
  if (!parsed.success) return refuse();
  const signature = sign(null,
    Buffer.from(canonicalBenchmarkJson(parsed.data), "utf8"),
    keyFromBase64(privateKeyDerBase64, "private")).toString("base64url");
  return promptRefinerVnextOneShotShadowProofSchema.parse({
    ...parsed.data, signature,
  });
}

export function verifyPromptRefinerVnextOneShotShadowProof(
  value: unknown, publicKeyDerBase64: string, now: Date = new Date(),
): PromptRefinerVnextOneShotShadowProof {
  const parsed = promptRefinerVnextOneShotShadowProofSchema.safeParse(value);
  if (!parsed.success || !(now instanceof Date) || !Number.isFinite(now.getTime())) {
    return refuse();
  }
  const signedMs = Date.parse(parsed.data.signedAt);
  if (!Number.isFinite(signedMs) ||
      new Date(signedMs).toISOString() !== parsed.data.signedAt ||
      signedMs > now.getTime() || now.getTime() - signedMs > 10 * 60_000) {
    return refuse();
  }
  const { signature, ...signed } = parsed.data;
  const bytes = Buffer.from(signature, "base64url");
  if (bytes.length !== 64 || !verify(null,
    Buffer.from(canonicalBenchmarkJson(signed), "utf8"),
    keyFromBase64(publicKeyDerBase64, "public"), bytes)) return refuse();
  return parsed.data;
}
