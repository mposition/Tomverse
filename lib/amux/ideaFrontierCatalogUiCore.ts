export type AvailableFrontierModel = {
  approvalId: string;
  approvalVersion: number;
  provider: "openai" | "anthropic";
  modelId: string;
  allowedEfforts: string[];
};

export type CheckedFrontierSelection = { approvalId: string; approvalVersion: number };

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const APPROVAL_ID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

/** Malformed or transfer-authorizing replies never become visible model choices. */
export function readAvailableFrontierModels(status: number, body: unknown): AvailableFrontierModel[] | null {
  if (status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  if (reply.state !== "available" || reply.transferAuthorized !== false || !Array.isArray(reply.models) ||
      reply.models.length > 256) return null;
  const models: AvailableFrontierModel[] = [];
  const seen = new Set<string>();
  for (const value of reply.models) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const row = value as Record<string, unknown>;
    if (typeof row.approvalId !== "string" || !APPROVAL_ID.test(row.approvalId) ||
        seen.has(row.approvalId) || !Number.isSafeInteger(row.approvalVersion) ||
        Number(row.approvalVersion) < 1 || (row.provider !== "openai" && row.provider !== "anthropic") ||
        typeof row.modelId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/.test(row.modelId) ||
        !Array.isArray(row.allowedEfforts) || row.allowedEfforts.length === 0 ||
        row.allowedEfforts.length > EFFORTS.size ||
        row.allowedEfforts.some((effort) => typeof effort !== "string" || !EFFORTS.has(effort)) ||
        new Set(row.allowedEfforts).size !== row.allowedEfforts.length) return null;
    seen.add(row.approvalId);
    models.push({ approvalId: row.approvalId, approvalVersion: row.approvalVersion as number,
      provider: row.provider, modelId: row.modelId, allowedEfforts: [...row.allowedEfforts] as string[] });
  }
  return models;
}

/** A check is a current observation only, never a transfer receipt. */
export function readCheckedFrontierSelection(
  status: number,
  body: unknown,
  selected: AvailableFrontierModel,
): CheckedFrontierSelection | null {
  if (status !== 200 || !body || typeof body !== "object" || Array.isArray(body)) return null;
  const reply = body as Record<string, unknown>;
  if (reply.state !== "current" || reply.transferAuthorized !== false ||
      reply.approvalId !== selected.approvalId ||
      reply.approvalVersion !== selected.approvalVersion) return null;
  return { approvalId: selected.approvalId, approvalVersion: selected.approvalVersion };
}
