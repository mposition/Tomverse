/**
 * Pure selection check for a server-loaded, owner-approved v4 model catalog.
 * It does not confer permission to spawn a CLI. The app must verify the
 * approval/audit rows and their revisions under its own authority, then check
 * the transfer receipt, current CLI availability, isolation and cost budget.
 * No model name is hardcoded here and an unavailable selection never falls
 * back to a different model or provider.
 */
export type AmuxIdeaFrontierProvider = "openai" | "anthropic";
export type AmuxIdeaReasoningEffort = "low" | "medium" | "high" | "xhigh" | "max" | "ultra";

export type AmuxIdeaFrontierApproval = {
  id: string;
  provider: AmuxIdeaFrontierProvider;
  modelId: string;
  allowedEfforts: readonly AmuxIdeaReasoningEffort[];
  version: number;
  status: "approved" | "revoked";
  approvedAt: Date;
  revokedAt: Date | null;
  approvedByUserId: string;
  approvalAuditLogId: string;
};

export type AmuxIdeaModelSelection = {
  provider: string;
  modelId: string;
  reasoningEffort: string;
};

export type AmuxIdeaFrontierSelectionDecision =
  | { decision: "selection_current"; approvalId: string; approvalVersion: number }
  | { decision: "reject" | "hold"; reason: string };

const PROVIDERS = new Set<string>(["openai", "anthropic"]);
const EFFORTS = new Set<string>(["low", "medium", "high", "xhigh", "max", "ultra"]);
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const ID = /^[A-Za-z0-9_-]{8,100}$/;
const validDate = (value: unknown): value is Date =>
  value instanceof Date && Number.isFinite(value.getTime());

function validApproval(row: AmuxIdeaFrontierApproval): boolean {
  return Boolean(row && ID.test(row.id) && PROVIDERS.has(row.provider) &&
    MODEL_ID.test(row.modelId) && Number.isSafeInteger(row.version) && row.version > 0 &&
    (row.status === "approved" || row.status === "revoked") &&
    validDate(row.approvedAt) && (row.revokedAt === null || validDate(row.revokedAt)) &&
    (row.revokedAt === null || row.revokedAt >= row.approvedAt) &&
    ID.test(row.approvedByUserId) && ID.test(row.approvalAuditLogId) &&
    Array.isArray(row.allowedEfforts) && row.allowedEfforts.length > 0 &&
    row.allowedEfforts.length <= EFFORTS.size &&
    row.allowedEfforts.every((effort) => EFFORTS.has(effort)) &&
    new Set(row.allowedEfforts).size === row.allowedEfforts.length &&
    (row.status === "approved" ? row.revokedAt === null : row.revokedAt !== null));
}

export function checkAmuxIdeaFrontierSelection(
  selected: AmuxIdeaModelSelection,
  approvals: readonly AmuxIdeaFrontierApproval[],
  databaseNow: Date,
): AmuxIdeaFrontierSelectionDecision {
  if (!validDate(databaseNow) || !Array.isArray(approvals) || approvals.length > 256 ||
      approvals.some((row) => !validApproval(row)) ||
      new Set(approvals.map((row) => row.id)).size !== approvals.length) {
    return { decision: "hold", reason: "model_catalog_unverified" };
  }
  if (!selected || !PROVIDERS.has(selected.provider) ||
      !MODEL_ID.test(selected.modelId) || !EFFORTS.has(selected.reasoningEffort)) {
    return { decision: "reject", reason: "model_selection_unsupported" };
  }
  const matches = approvals.filter((row) => row.provider === selected.provider &&
    row.modelId === selected.modelId);
  if (matches.length === 0) return { decision: "reject", reason: "model_not_approved" };
  const ordered = [...matches].sort((left, right) => left.version - right.version);
  const versions = ordered.map((row) => row.version);
  if (new Set(versions).size !== versions.length) {
    return { decision: "hold", reason: "model_catalog_conflict" };
  }
  for (let index = 1; index < ordered.length; index += 1) {
    const previousEffectiveAt = ordered[index - 1].revokedAt ?? ordered[index - 1].approvedAt;
    const nextEffectiveAt = ordered[index].revokedAt ?? ordered[index].approvedAt;
    if (nextEffectiveAt < previousEffectiveAt) {
      return { decision: "hold", reason: "model_catalog_conflict" };
    }
  }
  const approval = ordered.at(-1)!;
  if (approval.status !== "approved" || approval.approvedAt > databaseNow ||
      !approval.allowedEfforts.includes(selected.reasoningEffort as AmuxIdeaReasoningEffort)) {
    return { decision: "reject", reason: "model_not_approved" };
  }
  return {
    decision: "selection_current",
    approvalId: approval.id,
    approvalVersion: approval.version,
  };
}

/** The observed CLI model and effort must match the exact approved selection. */
export function checkAmuxIdeaActualModel(
  selected: AmuxIdeaModelSelection,
  observed: AmuxIdeaModelSelection,
): { decision: "matches" } | { decision: "halt"; reason: "model_substituted" } {
  if (!selected || !observed || !PROVIDERS.has(selected.provider) ||
      !PROVIDERS.has(observed.provider) || !MODEL_ID.test(selected.modelId) ||
      !MODEL_ID.test(observed.modelId) || !EFFORTS.has(selected.reasoningEffort) ||
      !EFFORTS.has(observed.reasoningEffort) ||
      selected.provider !== observed.provider ||
      selected.modelId !== observed.modelId ||
      selected.reasoningEffort !== observed.reasoningEffort) {
    return { decision: "halt", reason: "model_substituted" };
  }
  return { decision: "matches" };
}
