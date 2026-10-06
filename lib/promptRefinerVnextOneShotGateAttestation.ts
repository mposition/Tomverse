/** The owner signer sees restricted inputs; the app receives this closed, content-free envelope. */
import { createHash, createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { z } from "zod";

import { evaluatePromptRefinerVnextOneShotGateSummary,
  promptRefinerVnextOneShotGateSummarySchema } from
  "./promptRefinerVnextOneShotGateSummary";
import { canonicalBenchmarkJson } from "./routerDevelopmentBenchmark";

const id = z.string().min(1).max(128);
const deploymentId = z.string().regex(
  /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/);
const requestId = z.string().regex(
  /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
const bindingSchema = z.object({
  slotIndex: z.number().int().min(0).max(79),
  requestId,
  slotConsumptionAuditLogId: id,
}).strict();
const signedSchema = z.object({
  version: z.literal("prompt-refiner-vnext-one-shot-gate-attestation-v1"),
  stageApprovalAuditLogId: id,
  runApprovalAuditLogId: id,
  shadowAuditLogId: id,
  runtimeDeploymentId: deploymentId,
  gateSourceDigest: z.string().regex(/^[0-9a-f]{64}$/),
  slotBindingDigest: z.string().regex(/^[0-9a-f]{64}$/),
  signedAt: z.string().datetime({ offset: false }),
  summary: promptRefinerVnextOneShotGateSummarySchema,
}).strict();
export const promptRefinerVnextOneShotGateAttestationSchema = signedSchema.extend({
  signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/),
}).strict();

export type PromptRefinerVnextOneShotGateAttestation =
  z.infer<typeof promptRefinerVnextOneShotGateAttestationSchema>;

const refuse = (): never => { throw new Error("vnext_one_shot_gate_attestation_invalid"); };

/** Digest only consumed slot/request/audit identities; no case ID or content enters it. */
export function promptRefinerVnextOneShotSlotBindingDigest(value: unknown): string {
  const parsed = z.array(bindingSchema).max(80).safeParse(value);
  if (!parsed.success ||
      new Set(parsed.data.map((item) => item.slotIndex)).size !== parsed.data.length ||
      new Set(parsed.data.map((item) => item.requestId)).size !== parsed.data.length ||
      new Set(parsed.data.map((item) => item.slotConsumptionAuditLogId)).size !==
        parsed.data.length) return refuse();
  return createHash("sha256").update(canonicalBenchmarkJson({
    version: "prompt-refiner-vnext-one-shot-slot-bindings-v1",
    bindings: [...parsed.data].sort((a, b) => a.slotIndex - b.slotIndex),
  }), "utf8").digest("hex");
}

export function promptRefinerVnextOneShotGatePublicKeyDigest(
  publicKeyDerBase64: string,
): string {
  keyFromBase64(publicKeyDerBase64, "public");
  return createHash("sha256")
    .update(Buffer.from(publicKeyDerBase64, "base64")).digest("hex");
}

function keyFromBase64(value: string, kind: "public" | "private") {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(value) || value.length > 4096) return refuse();
  const der = Buffer.from(value, "base64");
  if (der.length < 32 || der.length > 2048 ||
      der.toString("base64") !== value) return refuse();
  try {
    const key = kind === "public" ? createPublicKey({ key: der, format: "der",
      type: "spki" }) : createPrivateKey({ key: der, format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") return refuse();
    return key;
  } catch { return refuse(); }
}

export function signPromptRefinerVnextOneShotGateAttestation(
  value: unknown, privateKeyDerBase64: string,
): PromptRefinerVnextOneShotGateAttestation {
  const parsed = signedSchema.safeParse(value);
  if (!parsed.success) return refuse();
  evaluatePromptRefinerVnextOneShotGateSummary(parsed.data.summary);
  const bytes = Buffer.from(canonicalBenchmarkJson(parsed.data), "utf8");
  const signature = sign(null, bytes, keyFromBase64(privateKeyDerBase64, "private"))
    .toString("base64url");
  return promptRefinerVnextOneShotGateAttestationSchema.parse({ ...parsed.data, signature });
}

export function verifyPromptRefinerVnextOneShotGateAttestation(
  value: unknown, publicKeyDerBase64: string,
  now: Date = new Date(),
): PromptRefinerVnextOneShotGateAttestation {
  const parsed = promptRefinerVnextOneShotGateAttestationSchema.safeParse(value);
  if (!parsed.success || !Number.isFinite(now.getTime())) return refuse();
  const signedMs = Date.parse(parsed.data.signedAt);
  if (!Number.isFinite(signedMs) || signedMs > now.getTime() ||
      now.getTime() - signedMs > 60 * 24 * 60 * 60 * 1000) return refuse();
  const { signature, ...signed } = parsed.data;
  const signatureBytes = Buffer.from(signature, "base64url");
  if (signatureBytes.length !== 64 ||
      !verify(null, Buffer.from(canonicalBenchmarkJson(signed), "utf8"),
        keyFromBase64(publicKeyDerBase64, "public"), signatureBytes)) return refuse();
  evaluatePromptRefinerVnextOneShotGateSummary(signed.summary);
  return parsed.data;
}
