import { amuxAnalysisTextSafe } from "./ideaAnalysisChunkCore.ts";

export const AMUX_V4_NODE_CREATE_WRITE_ENV = "TOMVERSE_AMUX_V4_NODE_CREATE_WRITE";
export const AMUX_V4_NODE_CREATE_READ_ENV = "TOMVERSE_AMUX_V4_NODE_CREATE_READ";
export const AMUX_V4_NODE_CREATE_WRITE_CODE_LATCH = false;
export const AMUX_V4_NODE_CREATE_READ_CODE_LATCH = false;
export const amuxV4NodeCreateWritePermitted = (value: string | undefined) =>
  AMUX_V4_NODE_CREATE_WRITE_CODE_LATCH && value === "enabled";
export const amuxV4NodeCreateReadPermitted = (value: string | undefined) =>
  AMUX_V4_NODE_CREATE_READ_CODE_LATCH && value === "enabled";

export const AMUX_V4_NODE_CREATE_BODY_MAX_BYTES = 2_048;
const ID = /^[A-Za-z0-9:_-]{1,128}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const DIGEST = /^[a-f0-9]{64}$/;

export type AmuxRootNodeRequest =
  | { stage: "prepare"; ideaId: string; draftUnitId: string;
      decisionId: string; prepareRequestId: string; nodeId: string;
      reason: string }
  | { stage: "consume"; ideaId: string; draftUnitId: string;
      decisionId: string; prepareRequestId: string; nodeId: string;
      reason: string; consumeRequestId: string; confirmationDigest: string }
  | { stage: "confirm_no_commit"; decisionId: string;
      prepareRequestId: string };

const exact = (value: Record<string, unknown>, names: readonly string[]) =>
  Object.keys(value).sort().join("\0") === [...names].sort().join("\0");

export function inspectAmuxRootNodeRequest(raw: string): AmuxRootNodeRequest | null {
  if (typeof raw !== "string" ||
      Buffer.byteLength(raw, "utf8") > AMUX_V4_NODE_CREATE_BODY_MAX_BYTES) return null;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const data = value as Record<string, unknown>;
  if (data.stage === "confirm_no_commit") {
    if (!exact(data, ["stage", "decisionId", "prepareRequestId"]) ||
        typeof data.decisionId !== "string" || !UUID.test(data.decisionId) ||
        typeof data.prepareRequestId !== "string" ||
        !UUID.test(data.prepareRequestId) ||
        data.decisionId === data.prepareRequestId) return null;
    return data as AmuxRootNodeRequest & { stage: "confirm_no_commit" };
  }
  const isPrepare = data.stage === "prepare";
  if (!isPrepare && data.stage !== "consume") return null;
  const required = ["stage", "ideaId", "draftUnitId", "decisionId",
    "prepareRequestId", "nodeId", "reason"];
  if (!exact(data, isPrepare ? required : [...required,
    "consumeRequestId", "confirmationDigest"]) ||
      typeof data.ideaId !== "string" || !ID.test(data.ideaId) ||
      typeof data.draftUnitId !== "string" || !ID.test(data.draftUnitId) ||
      typeof data.decisionId !== "string" || !UUID.test(data.decisionId) ||
      typeof data.prepareRequestId !== "string" ||
      !UUID.test(data.prepareRequestId) ||
      typeof data.nodeId !== "string" || !UUID.test(data.nodeId) ||
      new Set([data.decisionId, data.prepareRequestId, data.nodeId]).size !== 3 ||
      typeof data.reason !== "string" ||
      data.reason !== data.reason.trim() ||
      data.reason !== data.reason.normalize("NFC") ||
      Buffer.byteLength(data.reason, "utf8") > 1_000 ||
      (data.reason.length > 0 && !amuxAnalysisTextSafe(data.reason))) return null;
  if (isPrepare) return data as AmuxRootNodeRequest & { stage: "prepare" };
  if (typeof data.consumeRequestId !== "string" ||
      !UUID.test(data.consumeRequestId) ||
      [data.prepareRequestId, data.decisionId, data.nodeId].includes(
        data.consumeRequestId) ||
      typeof data.confirmationDigest !== "string" ||
      !DIGEST.test(data.confirmationDigest)) return null;
  return data as AmuxRootNodeRequest & { stage: "consume" };
}

export const amuxRootNodeErrorStatus = (code: string): number =>
  code === "not_found" ? 404 :
    ["reconfirm", "already_prepared", "not_ready"].includes(code) ? 409 : 503;

export const amuxRootNodeErrorBody = (code: string,
  recovery?: { decisionId: string; prepareRequestId: string }) =>
  code === "outcome_unknown"
    ? { error: code, retryWrite: false, ...recovery }
    : { error: code };

export const amuxRootNodeNeedsCommitReadback = (callbackReturned: boolean) =>
  callbackReturned === true;

/** Prisma's P2034 reports an aborted Serializable transaction, not an
 * uncertain COMMIT. All other post-callback errors still need read-back. */
export const amuxRootNodeKnownRollbackCode = (code: string | undefined) =>
  code === "P2034";

export const amuxRootNodeReadbackProvesExpiry = (status: {
  state: string; decisionId?: string; draftUnitId?: string;
}, choice: { decisionId: string; draftUnitId: string }) =>
  status.state === "expired" && status.decisionId === choice.decisionId &&
    status.draftUnitId === choice.draftUnitId;

/** Expiry may follow a clean prepared decision or an owner-confirmed
 * no-commit. An unresolved unknown can never look like an ordinary expiry. */
export function amuxRootNodeExpiredUnknownShapeValid(row: {
  outcomeUnknownAt: Date | null;
  outcomeUnknownAuditLogId: string | null;
  outcomeUnknownConsumeRequestId: string | null;
  outcomeUnknownResolvedAt: Date | null;
  outcomeUnknownResolution: string | null;
  outcomeUnknownResolvedAuditLogId: string | null;
}, noCommitAuditId: unknown): boolean {
  if (row.outcomeUnknownAt === null) {
    return row.outcomeUnknownAuditLogId === null &&
      row.outcomeUnknownConsumeRequestId === null &&
      row.outcomeUnknownResolvedAt === null &&
      row.outcomeUnknownResolution === null &&
      row.outcomeUnknownResolvedAuditLogId === null &&
      noCommitAuditId === null;
  }
  return row.outcomeUnknownResolvedAt instanceof Date &&
    row.outcomeUnknownResolution === "no_commit" &&
    typeof row.outcomeUnknownAuditLogId === "string" &&
    typeof row.outcomeUnknownConsumeRequestId === "string" &&
    typeof row.outcomeUnknownResolvedAuditLogId === "string" &&
    noCommitAuditId === row.outcomeUnknownResolvedAuditLogId;
}
