import { z } from "zod";

/** Owner decisions are stored in the app; this contract cannot open a CLI. */
export const AMUX_V4_FRONTIER_CATALOG_WRITE_CODE_LATCH = true;
export const AMUX_V4_FRONTIER_CATALOG_WRITE_ENV = "TOMVERSE_AMUX_V4_FRONTIER_CATALOG_WRITE";
export const frontierCatalogWritePermitted = (value: string | undefined): boolean =>
  AMUX_V4_FRONTIER_CATALOG_WRITE_CODE_LATCH && value === "enabled";
export const AMUX_V4_FRONTIER_CATALOG_READ_CODE_LATCH = true;
export const AMUX_V4_FRONTIER_CATALOG_READ_ENV = "TOMVERSE_AMUX_V4_FRONTIER_CATALOG_READ";
export const frontierCatalogReadPermitted = (value: string | undefined): boolean =>
  AMUX_V4_FRONTIER_CATALOG_READ_CODE_LATCH && value === "enabled";

export const AMUX_V4_FRONTIER_CATALOG_BODY_MAX_BYTES = 2_048;
const effortOrder = ["low", "medium", "high", "xhigh", "max", "ultra"] as const;
const effort = z.enum(effortOrder);
const uuid = z.uuid().regex(/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/);
export const isFrontierApprovalId = (value: string): boolean =>
  uuid.safeParse(value).success;
const modelId = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/);
const naturalVersion = z.number().int().min(0).max(999_999_999);

const approveSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.literal("approve"),
  approvalId: uuid,
  provider: z.enum(["openai", "anthropic"]),
  modelId,
  allowedEfforts: z.array(effort).min(1).max(effortOrder.length),
  expectedPreviousVersion: naturalVersion,
  ownerConfirmedFrontierEligibility: z.literal(true),
}).strict();

const revokeSchema = z.object({
  schemaVersion: z.literal(1),
  action: z.literal("revoke"),
  approvalId: uuid,
  expectedVersion: z.number().int().min(1).max(1_000_000_000),
  ownerConfirmedRevocation: z.literal(true),
}).strict();

type ApproveRequest = z.infer<typeof approveSchema>;
type RevokeRequest = z.infer<typeof revokeSchema>;
export type FrontierCatalogWriteRequest = ApproveRequest | RevokeRequest;
export type FrontierCatalogWriteInspection =
  | { ok: true; request: FrontierCatalogWriteRequest }
  | { ok: false; code: "too_large" | "schema_rejected" };

/** Unknown keys, duplicated efforts, non-v4 IDs and unsupported providers fail. */
export function inspectFrontierCatalogWrite(raw: string): FrontierCatalogWriteInspection {
  if (typeof raw !== "string") return { ok: false, code: "schema_rejected" };
  if (Buffer.byteLength(raw, "utf8") > AMUX_V4_FRONTIER_CATALOG_BODY_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, code: "schema_rejected" };
  }
  const parsed = (value as Record<string, unknown>).action === "approve"
    ? approveSchema.safeParse(value) : revokeSchema.safeParse(value);
  if (!parsed.success) return { ok: false, code: "schema_rejected" };
  if (parsed.data.action === "revoke") return { ok: true, request: parsed.data };
  if (new Set(parsed.data.allowedEfforts).size !== parsed.data.allowedEfforts.length) {
    return { ok: false, code: "schema_rejected" };
  }
  const normalizedEfforts = [...parsed.data.allowedEfforts].sort((a, b) =>
    effortOrder.indexOf(a) - effortOrder.indexOf(b));
  return { ok: true, request: { ...parsed.data, allowedEfforts: normalizedEfforts } };
}

export type FrontierCatalogLatest = { version: number; status: string };
export type FrontierCatalogVersionDecision =
  | { decision: "allow"; nextVersion: number }
  | { decision: "conflict"; reason: "catalog_revision_changed" }
  | { decision: "hold"; reason: "catalog_state_unverified" };

/** Called after the per-model advisory lock and fresh version read. */
export function decideFrontierCatalogApprovalVersion(
  latest: FrontierCatalogLatest | null,
  expectedPreviousVersion: number,
): FrontierCatalogVersionDecision {
  if (!Number.isSafeInteger(expectedPreviousVersion) || expectedPreviousVersion < 0 ||
      expectedPreviousVersion > 999_999_999 ||
      (latest !== null && (!Number.isSafeInteger(latest.version) || latest.version < 1 ||
        latest.version > 1_000_000_000 ||
        !["approved", "revoked"].includes(latest.status)))) {
    return { decision: "hold", reason: "catalog_state_unverified" };
  }
  if ((latest?.version ?? 0) !== expectedPreviousVersion ||
      latest?.status === "approved") {
    return { decision: "conflict", reason: "catalog_revision_changed" };
  }
  return { decision: "allow", nextVersion: expectedPreviousVersion + 1 };
}

export const frontierApprovalAuditMetadata = (
  request: ApproveRequest,
  version: number,
) => ({
  contractVersion: 1,
  provider: request.provider,
  modelId: request.modelId,
  allowedEfforts: [...request.allowedEfforts],
  version,
});

export const frontierRevocationAuditMetadata = (row: {
  id: string; provider: string; modelId: string; version: number;
}) => ({
  contractVersion: 1,
  approvalId: row.id,
  provider: row.provider,
  modelId: row.modelId,
  version: row.version,
});
