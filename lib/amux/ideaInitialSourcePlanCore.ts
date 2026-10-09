import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";

export const AMUX_V4_INITIAL_PLAN_WRITE_ENV = "TOMVERSE_AMUX_V4_INITIAL_PLAN_WRITE";
export const AMUX_V4_INITIAL_PLAN_READBACK_ENV = "TOMVERSE_AMUX_V4_INITIAL_PLAN_READBACK";
export const AMUX_V4_INITIAL_PLAN_WRITE_CODE_ENABLED = true;
export const AMUX_V4_INITIAL_PLAN_READBACK_CODE_ENABLED = true;
export const AMUX_V4_INITIAL_PLAN_MAX_BYTES = 256;

export const initialPlanWritePermitted = (value: string | undefined): boolean =>
  AMUX_V4_INITIAL_PLAN_WRITE_CODE_ENABLED && value === "enabled";
export const initialPlanReadbackPermitted = (value: string | undefined): boolean =>
  AMUX_V4_INITIAL_PLAN_READBACK_CODE_ENABLED && value === "enabled";

export function inspectInitialPlanRequest(raw: string):
  { ok: true; ideaId: string } | { ok: false; code: "schema_rejected" | "too_large" } {
  if (Buffer.byteLength(raw, "utf8") > AMUX_V4_INITIAL_PLAN_MAX_BYTES) {
    return { ok: false, code: "too_large" };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { return { ok: false, code: "schema_rejected" }; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, code: "schema_rejected" };
  }
  const value = parsed as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || value.version !== 1 ||
      typeof value.ideaId !== "string" || !isAmuxIdeaRequestId(value.ideaId)) {
    return { ok: false, code: "schema_rejected" };
  }
  return { ok: true, ideaId: value.ideaId };
}
