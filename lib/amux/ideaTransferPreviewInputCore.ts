import { isFrontierApprovalId } from "./ideaFrontierCatalogWriteCore.ts";
import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";

export const AMUX_V4_TRANSFER_PREVIEW_WRITE_ENV = "TOMVERSE_AMUX_V4_TRANSFER_PREVIEW_WRITE";
export const AMUX_V4_TRANSFER_PREVIEW_READ_ENV = "TOMVERSE_AMUX_V4_TRANSFER_PREVIEW_READ";
export const AMUX_V4_TRANSFER_PREVIEW_WRITE_CODE_ENABLED = true;
export const AMUX_V4_TRANSFER_PREVIEW_READ_CODE_ENABLED = true;
export const AMUX_V4_TRANSFER_PREVIEW_MAX_BYTES = 1_024;

export const transferPreviewWritePermitted = (value: string | undefined): boolean =>
  AMUX_V4_TRANSFER_PREVIEW_WRITE_CODE_ENABLED && value === "enabled";
export const transferPreviewReadPermitted = (value: string | undefined): boolean =>
  AMUX_V4_TRANSFER_PREVIEW_READ_CODE_ENABLED && value === "enabled";

export type IdeaOnlyTransferPreviewRequest = {
  previewId: string;
  ideaId: string;
  provider: "openai" | "anthropic";
  modelId: string;
  reasoningEffort: "low" | "medium" | "high" | "xhigh" | "max" | "ultra";
  approvalId: string;
  approvalVersion: number;
  /** v1 omitted this field. v2 binds a later, owner-reviewed output page. */
  chunkIndex?: number;
};

const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,119}$/;
const EFFORTS = new Set(["low", "medium", "high", "xhigh", "max", "ultra"]);
const FIELDS = ["version", "previewId", "ideaId", "provider", "modelId",
  "reasoningEffort", "approvalId", "approvalVersion"];
const CONTINUATION_FIELDS = [...FIELDS, "chunkIndex"];

export function inspectIdeaOnlyTransferPreviewRequest(raw: string):
  | { ok: true; request: IdeaOnlyTransferPreviewRequest }
  | { ok: false; code: "schema_rejected" | "too_large" } {
  if (Buffer.byteLength(raw, "utf8") > AMUX_V4_TRANSFER_PREVIEW_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: "schema_rejected" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const value = parsed as Record<string, unknown>;
  const initial = value.version === 1;
  const expected = initial ? FIELDS : CONTINUATION_FIELDS;
  if ((value.version !== 1 && value.version !== 2) ||
      Object.keys(value).length !== expected.length ||
      !expected.every((field) => Object.hasOwn(value, field)) ||
      (!initial && (!Number.isSafeInteger(value.chunkIndex) ||
        Number(value.chunkIndex) < 1 || Number(value.chunkIndex) >= 2_147_483_647)) ||
      typeof value.previewId !== "string" || !isAmuxIdeaRequestId(value.previewId) ||
      typeof value.ideaId !== "string" || !isAmuxIdeaRequestId(value.ideaId) ||
      (value.provider !== "openai" && value.provider !== "anthropic") ||
      typeof value.modelId !== "string" || !MODEL_ID.test(value.modelId) ||
      typeof value.reasoningEffort !== "string" || !EFFORTS.has(value.reasoningEffort) ||
      typeof value.approvalId !== "string" || !isFrontierApprovalId(value.approvalId) ||
      !Number.isSafeInteger(value.approvalVersion) || Number(value.approvalVersion) < 1) {
    return { ok: false, code: "schema_rejected" };
  }
  return { ok: true, request: {
    previewId: value.previewId, ideaId: value.ideaId,
    provider: value.provider, modelId: value.modelId,
    reasoningEffort: value.reasoningEffort as IdeaOnlyTransferPreviewRequest["reasoningEffort"],
    approvalId: value.approvalId, approvalVersion: value.approvalVersion as number,
    chunkIndex: initial ? 0 : value.chunkIndex as number,
  } };
}
