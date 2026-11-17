import { isAmuxIdeaRequestId } from "./ideaSubmissionCore.ts";

export const AMUX_V4_INITIAL_PLAN_MAX_BYTES = 256;

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
