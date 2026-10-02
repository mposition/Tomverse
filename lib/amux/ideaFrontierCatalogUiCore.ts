export type AvailableFrontierModel = {
  approvalId: string;
  approvalVersion: number;
  provider: "openai" | "anthropic";
  modelId: string;
  allowedEfforts: string[];
};

const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);

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
    if (typeof row.approvalId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(row.approvalId) ||
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
