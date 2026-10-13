import type { AmuxRecoveryInspectionIdentity } from "./ownerRecoveryInspectionCore";

export type RecoveryAction = "request_inspection" | "request_safe_stop" | "approve_attempt";
export type RecoveryApprovalReceiptBinding = {
  inspectionId: string | null; evidenceId: string | null;
  evidenceDigest: string | null; costDigest: string;
};
export type RecoverySafeStopReceiptBinding = {
  sourceEvidenceId: string; sourceEvidenceDigest: string;
};
export type RecoveryReceiptBinding = RecoveryApprovalReceiptBinding | RecoverySafeStopReceiptBinding;
export type AmuxPendingRecovery = {
  version: 1; identity: AmuxRecoveryInspectionIdentity & { attemptId: string };
  requestId: string; action: RecoveryAction; expectedReceipt: RecoveryReceiptBinding | null;
};
export type AmuxPendingRecoveryLoad =
  | { state: "empty" }
  | { state: "pending"; pending: AmuxPendingRecovery }
  | { state: "blocked"; reason: "invalid" | "unavailable" };
type RecoveryStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;
type StorageAccess = () => RecoveryStorage;
const storage: StorageAccess = () => window.sessionStorage;
const key = (taskId: string) => `amux-task-recovery-pending-v1:${taskId}`;
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const keys = (value: Record<string, unknown>, expected: string) =>
  Object.keys(value).sort().join(",") === expected;
const id = (value: unknown): value is string =>
  typeof value === "string" && /^[A-Za-z0-9:_-]{1,128}$/.test(value);
const uuid = (value: unknown): value is string => typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
const digest = (value: unknown): value is string =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value);

/** Browser metadata is only a same-nonce read fence, never approval evidence. */
export function bindAmuxPendingRecovery(value: unknown, taskId: string): AmuxPendingRecovery | null {
  if (!id(taskId) || !record(value) || !keys(value, "action,expectedReceipt,identity,requestId,version") ||
      value.version !== 1 || !uuid(value.requestId) ||
      !record(value.identity) || !keys(value.identity, "attemptId,taskId,taskRevision") ||
      value.identity.taskId !== taskId || !id(value.identity.attemptId) ||
      !Number.isSafeInteger(value.identity.taskRevision) || Number(value.identity.taskRevision) < 0 ||
      Number(value.identity.taskRevision) > 2_147_483_647) return null;
  if (value.action === "request_inspection") {
    if (value.expectedReceipt !== null) return null;
  } else if (value.action === "request_safe_stop") {
    const receipt = value.expectedReceipt;
    if (!record(receipt) || !keys(receipt, "sourceEvidenceDigest,sourceEvidenceId") ||
        !uuid(receipt.sourceEvidenceId) || !digest(receipt.sourceEvidenceDigest)) return null;
  } else if (value.action === "approve_attempt") {
    const receipt = value.expectedReceipt;
    if (!record(receipt) || !keys(receipt, "costDigest,evidenceDigest,evidenceId,inspectionId") ||
        !uuid(receipt.inspectionId) || !uuid(receipt.evidenceId) ||
        !digest(receipt.evidenceDigest) || !digest(receipt.costDigest)) return null;
  } else return null;
  return value as AmuxPendingRecovery;
}

export function readAmuxPendingRecovery(taskId: string, access = storage): AmuxPendingRecoveryLoad {
  if (!id(taskId)) return { state: "blocked", reason: "invalid" };
  try {
    const raw = access().getItem(key(taskId));
    if (raw === null) return { state: "empty" };
    if (raw.length > 2_048) return { state: "blocked", reason: "invalid" };
    const pending = bindAmuxPendingRecovery(JSON.parse(raw), taskId);
    return pending ? { state: "pending", pending } : { state: "blocked", reason: "invalid" };
  } catch { return { state: "blocked", reason: "unavailable" }; }
}

/** Do not transmit a POST unless the exact fence survived a storage round trip. */
export function saveAmuxPendingRecovery(pending: AmuxPendingRecovery, access = storage): AmuxPendingRecoveryLoad {
  if (!bindAmuxPendingRecovery(pending, pending.identity.taskId)) return { state: "blocked", reason: "invalid" };
  const existing = readAmuxPendingRecovery(pending.identity.taskId, access);
  if (existing.state !== "empty") return existing;
  try {
    const raw = JSON.stringify(pending);
    access().setItem(key(pending.identity.taskId), raw);
    if (access().getItem(key(pending.identity.taskId)) !== raw) return { state: "blocked", reason: "unavailable" };
    return { state: "pending", pending };
  } catch { return { state: "blocked", reason: "unavailable" }; }
}

/** Called only after a server response verified this exact action and receipt. */
export function clearAmuxPendingRecovery(pending: AmuxPendingRecovery, access = storage): boolean {
  const existing = readAmuxPendingRecovery(pending.identity.taskId, access);
  if (existing.state !== "pending" || JSON.stringify(existing.pending) !== JSON.stringify(pending)) return false;
  try {
    access().removeItem(key(pending.identity.taskId));
    return access().getItem(key(pending.identity.taskId)) === null;
  } catch { return false; }
}
