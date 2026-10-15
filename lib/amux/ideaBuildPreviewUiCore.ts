import type { AvailableFrontierModel } from "./ideaFrontierCatalogUiCore.ts";
import { isAmuxIdeaRequestId } from "./ideaRequestIdCore.ts";
import { isIdeaSubmissionPrewriteRefusal } from "./ideaSubmissionUiCore.ts";

export type BuildPreviewAnswer =
  | { kind: "saved"; ideaId: string; hasExternalSources: boolean; planReady: boolean; previewMayExist: boolean }
  | { kind: "refused"; code: string }
  | { kind: "verify" };

/** Errors the build route returns before the idea is saved. */
const BUILD_PREWRITE_REFUSALS: Record<string, number> = {
  build_preview_disabled: 503,
  content_type_refused: 415,
  schema_rejected: 400,
  ADMIN_REAUTHENTICATION_REQUIRED: 428,
};
/** The security layer's refusals, raised before the body is read. */
const SECURITY_PREWRITE_REFUSALS: Record<string, number> = {
  API_RATE_LIMITED: 429,
  REQUEST_BODY_TOO_LARGE: 413,
};
const known = (table: Record<string, number>, code: unknown, status: number) =>
  typeof code === "string" && Object.hasOwn(table, code) && table[code] === status;

/**
 * Classifies one build-preview answer. A saved idea keeps a preview receipt
 * only when the preview was prepared or its outcome is unknown; a definite
 * preview refusal keeps none, so a new preview can be prepared. Without a
 * saved idea, only an error known to come before the save is a refusal;
 * everything else, including a lost or malformed answer, is read back.
 */
export function classifyBuildPreviewAnswer(status: number, body: unknown): BuildPreviewAnswer {
  const row = body && typeof body === "object" && !Array.isArray(body) ? body as Record<string, unknown> : {};
  // A submission-step answer naming an idea is still an unknown submission:
  // only the submission read-back confirms it.
  if (typeof row.ideaId === "string" && isAmuxIdeaRequestId(row.ideaId) && row.step !== "submission") {
    const prepared = status === 201 && row.state === "prepared";
    return { kind: "saved", ideaId: row.ideaId, hasExternalSources: row.hasExternalSources === true,
      planReady: prepared || row.step === "preview",
      previewMayExist: prepared || (row.step === "preview" && row.error === "outcome_unknown") };
  }
  if (known(BUILD_PREWRITE_REFUSALS, row.error, status) ||
      (row.step === "submission" && isIdeaSubmissionPrewriteRefusal(row.error, status))) {
    return { kind: "refused", code: row.error as string };
  }
  if (known(SECURITY_PREWRITE_REFUSALS, row.code, status)) return { kind: "refused", code: row.code as string };
  return { kind: "verify" };
}

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
