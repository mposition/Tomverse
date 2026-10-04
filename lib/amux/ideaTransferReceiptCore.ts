import { timingSafeEqual } from "node:crypto";

/**
 * A necessary, read-only check for claiming one v4 transfer preview. It is not
 * permission to call a model. The app must load and lock the preview, idea,
 * source approval and human audit in one transaction; re-collect selected
 * GitHub bytes; recompute the keyed payload digest; check model eligibility,
 * isolation, switches and the Agent budget; then conditionally consume this
 * exact row with canonical audit before handing anything to the local Agent.
 * Neither a browser nor an LLM may construct `current` for a live call.
 */
export type AmuxIdeaTransferReceipt = {
  id: string;
  ideaId: string;
  sourceScopeApprovalId: string | null;
  chunkIndex: number;
  attempt: number;
  state: "prepared" | "confirmed" | "in_flight" | "completed" |
    "owner_rejected" | "provider_failed" | "expired" | "outcome_unknown";
  modelId: string;
  payloadDigest: string;
  payloadDigestKeyId: string;
  expiresAt: Date;
  confirmedAt: Date | null;
  confirmExpiresAt: Date | null;
  confirmedByUserId: string | null;
  confirmationAuditLogId: string | null;
  consumedAt: Date | null;
  outcomeUnknownAt: Date | null;
  payloadPurgedAt: Date | null;
};

export type AmuxIdeaTransferCurrent = {
  previewId: string;
  ideaId: string;
  sourceScopeApprovalId: string | null;
  chunkIndex: number;
  attempt: number;
  actorUserId: string;
  modelId: string;
  /** Recomputed by the app from its decrypted, freshly verified payload. */
  payloadDigest: string;
  payloadDigestKeyId: string;
  /** SELECT clock_timestamp() inside the claim transaction. */
  databaseNow: Date;
};

export type AmuxIdeaTransferReceiptDecision =
  | { decision: "receipt_current" }
  | { decision: "reject" | "reconfirm" | "halt"; reason: string };

const DIGEST = /^[a-f0-9]{64}$/;
const validText = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0 && value === value.trim();
const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());
const sameDigest = (left: string, right: string) =>
  DIGEST.test(left) && DIGEST.test(right) &&
  timingSafeEqual(Buffer.from(left, "hex"), Buffer.from(right, "hex"));

export function checkAmuxIdeaTransferReceipt(
  receipt: AmuxIdeaTransferReceipt,
  current: AmuxIdeaTransferCurrent,
): AmuxIdeaTransferReceiptDecision {
  if (!receipt || !current || !validDate(current.databaseNow) ||
      !validDate(receipt.expiresAt)) {
    return { decision: "halt", reason: "receipt_or_clock_unavailable" };
  }
  if (receipt.state === "outcome_unknown" || receipt.outcomeUnknownAt !== null) {
    return { decision: "halt", reason: "outcome_unknown" };
  }
  if (receipt.state !== "confirmed" || receipt.consumedAt !== null) {
    return { decision: "reject", reason: "receipt_not_claimable" };
  }
  if (![receipt.id, receipt.ideaId, receipt.modelId, receipt.payloadDigestKeyId,
    receipt.confirmedByUserId, receipt.confirmationAuditLogId,
    current.previewId, current.ideaId, current.actorUserId, current.modelId,
    current.payloadDigestKeyId].every(validText) ||
      !Number.isSafeInteger(receipt.chunkIndex) || receipt.chunkIndex < 0 ||
      !Number.isSafeInteger(current.chunkIndex) || current.chunkIndex < 0 ||
      !Number.isSafeInteger(receipt.attempt) || receipt.attempt < 1 ||
      !Number.isSafeInteger(current.attempt) || current.attempt < 1 ||
      (receipt.sourceScopeApprovalId !== null && !validText(receipt.sourceScopeApprovalId)) ||
      (current.sourceScopeApprovalId !== null && !validText(current.sourceScopeApprovalId)) ||
      !DIGEST.test(receipt.payloadDigest) || !DIGEST.test(current.payloadDigest)) {
    return { decision: "halt", reason: "receipt_malformed" };
  }
  if (receipt.id !== current.previewId || receipt.ideaId !== current.ideaId ||
      receipt.chunkIndex !== current.chunkIndex || receipt.attempt !== current.attempt ||
      receipt.confirmedByUserId !== current.actorUserId) {
    return { decision: "reject", reason: "identity_mismatch" };
  }
  if (!validDate(receipt.confirmedAt) || !validDate(receipt.confirmExpiresAt) ||
      receipt.confirmedAt >= receipt.confirmExpiresAt ||
      receipt.confirmExpiresAt > receipt.expiresAt ||
      current.databaseNow < receipt.confirmedAt) {
    return { decision: "halt", reason: "receipt_clock_anomaly" };
  }
  if (current.databaseNow >= receipt.confirmExpiresAt ||
      current.databaseNow >= receipt.expiresAt) {
    return { decision: "reconfirm", reason: "receipt_expired" };
  }
  if (receipt.payloadPurgedAt !== null) {
    return { decision: "halt", reason: "payload_unavailable" };
  }
  // Null on both sides is legitimate for an idea-only transfer. A transfer
  // containing GitHub excerpts requires a separately locked, valid scope row;
  // this receipt check cannot infer that from a null/non-null ID alone.
  if (receipt.sourceScopeApprovalId !== current.sourceScopeApprovalId ||
      receipt.modelId !== current.modelId ||
      receipt.payloadDigestKeyId !== current.payloadDigestKeyId ||
      !sameDigest(receipt.payloadDigest, current.payloadDigest)) {
    return { decision: "reconfirm", reason: "preview_changed" };
  }
  return { decision: "receipt_current" };
}
