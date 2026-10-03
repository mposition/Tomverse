import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";

/** Dark collector claim. The queue is only a hint; this request is rechecked. */
export const AMUX_V4_COLLECTION_CLAIM_CODE_LATCH = false;
export const AMUX_V4_COLLECTION_CLAIM_ENV = "TOMVERSE_AMUX_V4_COLLECTION_CLAIM";
export const AMUX_V4_COLLECTION_CLAIM_MAX_BYTES = 256;
export const AMUX_V4_COLLECTION_LEASE_MS = 2 * 60_000;
export const collectionClaimEnabled = (value: string | undefined): boolean =>
  AMUX_V4_COLLECTION_CLAIM_CODE_LATCH && value === "enabled";

export const collectionClaimRequestSchema = z.object({
  collectionRequestId: z.uuid(),
}).strict();
export type AmuxV4CollectionClaimRequest = z.infer<typeof collectionClaimRequestSchema>;

type Binding = {
  requestId: string; previewId: string; ideaId: string;
  sourceScopeApprovalId: string; sourceIndex: number; sourceKind: string;
  sourceByteLimit: number; frontierApprovalId: string; frontierVersion: number;
  provider: string; modelId: string; reasoningEffort: string; attempt: number;
};
const SHA256 = /^[a-f0-9]{64}$/;

/** The request writer's canonical HMAC input, reconstructed from locked DB
 * identity. Never use a worker-supplied digest as proof of source approval. */
export function collectionRequestDigest(row: Binding, ideaDigest: string,
  scopeDigest: string, digestKey: Buffer): string {
  const canonical = JSON.stringify({
    schemaVersion: 1, requestId: row.requestId, previewId: row.previewId,
    ideaId: row.ideaId, ideaDigest,
    scopeApprovalId: row.sourceScopeApprovalId, scopeDigest,
    sourceIndex: row.sourceIndex, sourceKind: row.sourceKind,
    sourceByteLimit: row.sourceByteLimit,
    frontierApprovalId: row.frontierApprovalId,
    frontierVersion: row.frontierVersion, provider: row.provider,
    modelId: row.modelId, reasoningEffort: row.reasoningEffort,
    attempt: row.attempt,
  });
  return createHmac("sha256", digestKey).update("amux-v4\0collection_request\0")
    .update(row.requestId).update("\0").update(canonical).digest("hex");
}

export function sameCollectionDigest(expected: string, actual: string): boolean {
  return SHA256.test(expected) && SHA256.test(actual) &&
    timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(actual, "hex"));
}
