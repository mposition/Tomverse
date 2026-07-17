import { createHmac } from "node:crypto";

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, canonical(nested)])
    );
  }
  return value;
};

export type AdminAuditHashInput = {
  previousHash: string | null;
  actorUserId: string | null;
  actorEmail: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  summary: string;
  metadata: unknown;
  ipAddress: string | null;
  userAgent: string | null;
  createdAt: string;
};

export const computeAdminAuditEntryHash = (
  input: AdminAuditHashInput,
  secret: string
) =>
  createHmac("sha256", secret)
    .update(JSON.stringify(canonical(input)))
    .digest("hex");
