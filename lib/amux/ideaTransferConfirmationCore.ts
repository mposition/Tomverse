import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";

export const AMUX_V4_TRANSFER_CONFIRM_WRITE_ENV = "TOMVERSE_AMUX_V4_TRANSFER_CONFIRM_WRITE";
export const AMUX_V4_TRANSFER_CONFIRM_READ_ENV = "TOMVERSE_AMUX_V4_TRANSFER_CONFIRM_READ";
export const AMUX_V4_TRANSFER_CONFIRM_WRITE_CODE_ENABLED = true;
export const AMUX_V4_TRANSFER_CONFIRM_READ_CODE_ENABLED = true;
export const AMUX_V4_TRANSFER_CONFIRM_MAX_BYTES = 512;

export const transferConfirmWritePermitted = (value: string | undefined): boolean =>
  AMUX_V4_TRANSFER_CONFIRM_WRITE_CODE_ENABLED && value === "enabled";
export const transferConfirmReadPermitted = (value: string | undefined): boolean =>
  AMUX_V4_TRANSFER_CONFIRM_READ_CODE_ENABLED && value === "enabled";

export type IdeaTransferConfirmationRequest = {
  previewId: string;
  ideaId: string;
  payloadDigest: string;
  payloadDigestKeyId: string;
};

const FIELDS = ["version", "previewId", "ideaId", "payloadDigest", "payloadDigestKeyId"];

export function inspectIdeaTransferConfirmationRequest(raw: string):
  | { ok: true; request: IdeaTransferConfirmationRequest }
  | { ok: false; code: "schema_rejected" | "too_large" } {
  if (Buffer.byteLength(raw, "utf8") > AMUX_V4_TRANSFER_CONFIRM_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: "schema_rejected" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== FIELDS.length ||
      !FIELDS.every((field) => Object.hasOwn(value, field)) ||
      value.version !== 1 ||
      typeof value.previewId !== "string" || !isAmuxIdeaRequestId(value.previewId) ||
      typeof value.ideaId !== "string" || !isAmuxIdeaRequestId(value.ideaId) ||
      typeof value.payloadDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(value.payloadDigest) ||
      typeof value.payloadDigestKeyId !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(value.payloadDigestKeyId)) {
    return { ok: false, code: "schema_rejected" };
  }
  return { ok: true, request: {
    previewId: value.previewId, ideaId: value.ideaId,
    payloadDigest: value.payloadDigest,
    payloadDigestKeyId: value.payloadDigestKeyId,
  } };
}
