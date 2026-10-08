import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";

/** Declarative scope preview only: no GitHub collection or model transfer. */
export const AMUX_V4_SOURCE_SCOPE_PREVIEW_ENV = "TOMVERSE_AMUX_V4_SOURCE_SCOPE_PREVIEW";
export const AMUX_V4_SOURCE_SCOPE_PREVIEW_CODE_ENABLED = true;
export const AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES = 20 * 1024;

export type AmuxSourceScopePreviewRequest = {
  schemaVersion: 1;
  ideaId: string;
  scopeJson: string;
};

export type AmuxSourceScopePreviewInspection =
  | { ok: true; request: AmuxSourceScopePreviewRequest }
  | { ok: false; code: "schema_rejected" | "too_large" };

export const sourceScopePreviewPermitted = (value: string | undefined): boolean =>
  AMUX_V4_SOURCE_SCOPE_PREVIEW_CODE_ENABLED && value === "enabled";

export function inspectAmuxSourceScopePreviewRequest(raw: string): AmuxSourceScopePreviewInspection {
  if (typeof raw !== "string") return { ok: false, code: "schema_rejected" };
  if (Buffer.byteLength(raw, "utf8") > AMUX_V4_SOURCE_SCOPE_PREVIEW_ENVELOPE_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, code: "schema_rejected" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const request = parsed as Record<string, unknown>;
  const keys = Object.keys(request);
  if (keys.length !== 3 || !["schemaVersion", "ideaId", "scopeJson"].every((key) =>
    Object.hasOwn(request, key)) || request.schemaVersion !== 1 ||
      typeof request.ideaId !== "string" || !isAmuxIdeaRequestId(request.ideaId) ||
      typeof request.scopeJson !== "string") {
    return { ok: false, code: "schema_rejected" };
  }
  return { ok: true, request: { schemaVersion: 1, ideaId: request.ideaId, scopeJson: request.scopeJson } };
}
