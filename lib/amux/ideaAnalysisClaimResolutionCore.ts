import { createHash } from "node:crypto";

export const AMUX_V4_CLAIM_RESOLUTION_DISPOSITIONS = [
  "not_started_proven",
  "evidence_insufficient",
] as const;

export type AmuxIdeaAnalysisClaimResolutionDisposition =
  typeof AMUX_V4_CLAIM_RESOLUTION_DISPOSITIONS[number];

export type AmuxIdeaAnalysisClaimReadback = {
  holdId: string;
  previewId: string;
  ideaId: string;
  chunkIndex: number;
  leaseGeneration: number;
  reservedMicroUsd: string;
  holdStatus: "in_flight" | "outcome_unknown";
  claimRequestId: string;
  payloadDigest: string;
  resultRequestId: string | null;
  resultDigest: string | null;
};

/** Content-free digest shown to the owner before a terminal disposition. */
export function amuxIdeaAnalysisClaimReadbackDigest(
  readback: AmuxIdeaAnalysisClaimReadback,
): string {
  return createHash("sha256").update(JSON.stringify({
    version: 1,
    policy: "amux-intake-v13",
    holdId: readback.holdId,
    previewId: readback.previewId,
    ideaId: readback.ideaId,
    chunkIndex: readback.chunkIndex,
    leaseGeneration: readback.leaseGeneration,
    reservedMicroUsd: readback.reservedMicroUsd,
    holdStatus: readback.holdStatus,
    claimRequestId: readback.claimRequestId,
    payloadDigest: readback.payloadDigest,
    resultRequestId: readback.resultRequestId,
    resultDigest: readback.resultDigest,
  })).digest("hex");
}
