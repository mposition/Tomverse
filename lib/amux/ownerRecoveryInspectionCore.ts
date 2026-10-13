export const AMUX_RECOVERY_USAGE_DISPLAY_LIMIT = 100;

export type AmuxRecoveryInspectionIdentity = {
  taskId: string;
  taskRevision: number;
  attemptId: string | null;
};

export type AmuxOwnerRecoveryInspection = {
  schemaVersion: 1;
  checkedAt: string;
  task: { id: string; revision: number; status: string };
  attempt: { id: string; taskRevision: number; worker: string;
    outcome: string | null; endedAt: string | null;
    heartbeatAt: string; leaseExpiresAt: string | null } | null;
  result: { state: "not_recorded" | "stored" | "purged";
    sha256: string | null; bodyVerified: false };
  usage: { state: "not_recorded" | "reported_complete" | "incomplete";
    displayedCount: number; displayLimit: number; truncated: boolean;
    inputTokens: string | null; outputTokens: string | null };
  cost: { reservedMaximumMicrousd: string | null;
    confirmed: boolean; settledMicrousd: string | null };
  deliveryStatus: string | null;
  runtime: { state: "not_recorded" | "same_instance" | "different_instance";
    status: string | null; heartbeatAt: string | null;
    leaseExpiresAt: string | null };
  ubuntuProcessVerified: false;
  recoveryAuthorized: false;
};

const decimal = (value: unknown): value is string =>
  typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);

/** Receipt counts describe stored records only. No record is not zero usage,
 * and an incomplete list must never produce a purported complete token sum. */
export function summarizeAmuxRecoveryUsage(rows: Array<{
  completeness: string; inputTokens: string | null; outputTokens: string | null;
}>) {
  const truncated = rows.length > AMUX_RECOVERY_USAGE_DISPLAY_LIMIT;
  const displayed = rows.slice(0, AMUX_RECOVERY_USAGE_DISPLAY_LIMIT);
  const complete = displayed.length > 0 && !truncated && displayed.every((row) =>
    row.completeness === "reported_complete" && decimal(row.inputTokens) &&
    decimal(row.outputTokens));
  const sum = (key: "inputTokens" | "outputTokens") => complete
    ? displayed.reduce((total, row) => total + BigInt(row[key]!), BigInt(0)).toString()
    : null;
  return {
    state: displayed.length === 0 ? "not_recorded" as const : complete
      ? "reported_complete" as const : "incomplete" as const,
    displayedCount: displayed.length, displayLimit: AMUX_RECOVERY_USAGE_DISPLAY_LIMIT,
    truncated, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"),
  };
}

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const nullableString = (value: unknown) => value === null || typeof value === "string";

/** A response belongs to this open review, never to a newer revision or a
 * different attempt. These inspection facts confer no recovery authority. */
export function bindAmuxRecoveryInspection(value: unknown,
  identity: AmuxRecoveryInspectionIdentity): AmuxOwnerRecoveryInspection | null {
  if (!record(value) || value.schemaVersion !== 1 ||
      typeof value.checkedAt !== "string" || !Number.isFinite(Date.parse(value.checkedAt)) ||
      value.ubuntuProcessVerified !== false || value.recoveryAuthorized !== false ||
      !record(value.task) || value.task.id !== identity.taskId ||
      value.task.revision !== identity.taskRevision || typeof value.task.status !== "string") return null;
  if (identity.attemptId === null ? value.attempt !== null :
      !record(value.attempt) || value.attempt.id !== identity.attemptId ||
      !Number.isSafeInteger(value.attempt.taskRevision) ||
      typeof value.attempt.worker !== "string" || !nullableString(value.attempt.outcome) ||
      !nullableString(value.attempt.endedAt) || typeof value.attempt.heartbeatAt !== "string" ||
      !nullableString(value.attempt.leaseExpiresAt)) return null;
  if (!record(value.result) || !["not_recorded", "stored", "purged"].includes(String(value.result.state)) ||
      value.result.bodyVerified !== false || !(value.result.sha256 === null ||
        typeof value.result.sha256 === "string" && /^[a-f0-9]{64}$/.test(value.result.sha256)) ||
      !record(value.usage) || !["not_recorded", "reported_complete", "incomplete"].includes(String(value.usage.state)) ||
      !Number.isSafeInteger(value.usage.displayedCount) ||
      (value.usage.displayedCount as number) < 0 ||
      (value.usage.displayedCount as number) > AMUX_RECOVERY_USAGE_DISPLAY_LIMIT ||
      value.usage.displayLimit !== AMUX_RECOVERY_USAGE_DISPLAY_LIMIT ||
      typeof value.usage.truncated !== "boolean" ||
      !(value.usage.inputTokens === null || decimal(value.usage.inputTokens)) ||
      !(value.usage.outputTokens === null || decimal(value.usage.outputTokens)) ||
      !record(value.cost) || typeof value.cost.confirmed !== "boolean" ||
      !(value.cost.reservedMaximumMicrousd === null || decimal(value.cost.reservedMaximumMicrousd)) ||
      !(value.cost.settledMicrousd === null || decimal(value.cost.settledMicrousd)) ||
      (value.cost.confirmed ? !decimal(value.cost.settledMicrousd) : value.cost.settledMicrousd !== null) ||
      !nullableString(value.deliveryStatus) || !record(value.runtime) ||
      !["not_recorded", "same_instance", "different_instance"].includes(String(value.runtime.state)) ||
      !nullableString(value.runtime.status) || !nullableString(value.runtime.heartbeatAt) ||
      !nullableString(value.runtime.leaseExpiresAt)) return null;
  return value as AmuxOwnerRecoveryInspection;
}
