import { createHash } from "node:crypto";
import type { AdminPermission } from "@/lib/adminAuthCore";

export const canonicalizeApprovalPayload = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonicalizeApprovalPayload);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonicalizeApprovalPayload(nested)])
    );
  }
  return value;
};

export const approvalPayloadHash = (value: unknown) =>
  createHash("sha256")
    .update(JSON.stringify(canonicalizeApprovalPayload(value ?? null)))
    .digest("hex");

export const approvalPermissionForAction = (
  action: string
): AdminPermission => {
  if (
    action.startsWith("refund.") ||
    action.startsWith("credit_purchase.refund") ||
    action.startsWith("user.plan_adjust") ||
    action.startsWith("billing_risk.")
  ) {
    return "billing:write";
  }
  if (action === "user.delete") return "user:delete";
  return "ops:write";
};

export const approvalTtlMinutes = (value: string | undefined) => {
  const parsed = Number(value || 30);
  if (!Number.isFinite(parsed)) return 30;
  return Math.min(1_440, Math.max(5, Math.trunc(parsed)));
};

export const refundApprovalThresholdCents = (value: string | undefined) => {
  const parsed = Number(value || 10_000);
  if (!Number.isFinite(parsed)) return 10_000;
  return Math.min(100_000_000, Math.max(0, Math.trunc(parsed)));
};

export const canReviewAdminApproval = ({
  requestedById,
  reviewerId,
  status,
  expiresAt,
  now = new Date(),
}: {
  requestedById: string | null;
  reviewerId: string;
  status: string;
  expiresAt: Date;
  now?: Date;
}) =>
  Boolean(requestedById) &&
  requestedById !== reviewerId &&
  status === "pending" &&
  expiresAt > now;
