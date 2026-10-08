import { amuxDatabaseDiagnosticCode } from "@/lib/amux/readFailureCore";

/**
 * Content-free description of a failed AMUX recovery sweep.
 *
 * The recover route answers 500 without detail, and before this the failure
 * left nothing behind, so an intermittent 500 seen by the orchestrator could
 * not be traced to a step or an error class. The fields here say which step
 * failed and what kind of error it was. They never carry the error message,
 * a task id, a worker name or any stored text.
 */
export const AMUX_RECOVER_STEPS = [
  "request",
  "quota_sweep",
  "reclaim_executions",
  "reclaim_claims",
] as const;

export type AmuxRecoverStep = (typeof AMUX_RECOVER_STEPS)[number];

const PRISMA_CODE = /^P\d{4}$/;
const BOUNDARY_CODES = new Set([
  "AMUX_DB_DEADLINE_EXCEEDED",
  "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
]);
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

export const amuxRecoverFailureFields = (
  step: AmuxRecoverStep,
  error: unknown,
): { event: "amux_recover_failed"; step: AmuxRecoverStep; error_name: string; error_code: string | null; database_error_code: string | null } => {
  const name =
    error instanceof Error && ERROR_NAME.test(error.name) ? error.name : "unknown";
  const rawCode =
    error && typeof error === "object" && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
  const code =
    typeof rawCode === "string" && (PRISMA_CODE.test(rawCode) || BOUNDARY_CODES.has(rawCode))
      ? rawCode
      : null;
  return {
    event: "amux_recover_failed",
    step,
    error_name: name,
    error_code: code,
    database_error_code: amuxDatabaseDiagnosticCode(error),
  };
};
