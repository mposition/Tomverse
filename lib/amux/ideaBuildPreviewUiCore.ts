import type { AvailableFrontierModel } from "./ideaFrontierCatalogUiCore.ts";

/**
 * The preview half of a build-preview attempt, recorded before the request
 * and keyed by its submission request id (amux-intake.md v18 item 1). If the
 * answer is lost, the idea is recovered by its submission read-back, and
 * this record then tells which exact preview to read back for that idea.
 */
export type AmuxBuildPreviewReceipt = { previewId: string; model: AvailableFrontierModel; effort: string };

const key = (operatorId: string, requestId: string) => `amux-v4-build-preview:${operatorId}:${requestId}`;

export function reserveBuildPreviewReceipt(storage: Storage | null, operatorId: string,
  requestId: string, receipt: AmuxBuildPreviewReceipt): boolean {
  if (!storage) return false;
  try {
    const value = JSON.stringify(receipt);
    storage.setItem(key(operatorId, requestId), value);
    return storage.getItem(key(operatorId, requestId)) === value;
  } catch { return false; }
}

/** Reads and removes the record; null when absent or unreadable. */
export function takeBuildPreviewReceipt(storage: Storage | null, operatorId: string,
  requestId: string): AmuxBuildPreviewReceipt | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(key(operatorId, requestId));
    storage.removeItem(key(operatorId, requestId));
    const value: unknown = raw ? JSON.parse(raw) : null;
    if (!value || typeof value !== "object") return null;
    const row = value as AmuxBuildPreviewReceipt;
    const model = row.model as Partial<AvailableFrontierModel> | undefined;
    return typeof row.previewId === "string" && typeof row.effort === "string" && model &&
      typeof model.approvalId === "string" && typeof model.provider === "string" &&
      typeof model.modelId === "string" && Number.isSafeInteger(model.approvalVersion) &&
      Array.isArray(model.allowedEfforts) ? row : null;
  } catch { return null; }
}
