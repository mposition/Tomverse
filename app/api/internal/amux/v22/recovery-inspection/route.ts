export const dynamic = "force-dynamic";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore, amuxInternalErrorResponse, isAmuxInputError } from "@/lib/amux/internalRoute";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS, withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { amuxV22RecoveryWorkerSchema, amuxV22RecoveryEvidenceSchema, amuxV22TaskRecoveryEnabled,
  AMUX_V22_TASK_RECOVERY_ENABLED_ENV, isAmuxV22RecoveryInspectorAuthorized } from
  "@/lib/amux/v22TaskRecoveryCore";
import { pendingAmuxV22RecoveryInspections, reportAmuxV22RecoveryEvidence } from "@/lib/amux/v22TaskRecoveryService";
function failure(error: unknown) {
  if (isAmuxInputError(error)) return amuxJsonNoStore({ error: "INVALID_REQUEST" }, 400);
  const security = apiSecurityResponse(error);
  if (security) { security.headers.set("Cache-Control", "private, no-store, max-age=0"); return security; }
  if (error instanceof BoardImportError) return amuxJsonNoStore({ error: error.code, retry: false },
    error.code === "outcome_unknown" ? 503 : error.httpStatus);
  return amuxInternalErrorResponse("v22_recovery_inspection", error);
}
export async function GET(request: Request) {
  if (!isAmuxV22RecoveryInspectorAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!amuxV22TaskRecoveryEnabled(process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]))
    return amuxJsonNoStore({ error: "recovery_disabled", requests: [] }, 409);
  return withAmuxRouteBudget(async () => {
    try {
      const parsed = amuxV22RecoveryWorkerSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
      if (!parsed.success) return amuxJsonNoStore({ error: "INVALID_REQUEST" }, 400);
      await consumeApiRateLimit(request, "amux-fixed-recovery-checker", "amux-recovery-inspection-read", { minute: 30, day: 2_000 });
      return amuxJsonNoStore(await pendingAmuxV22RecoveryInspections(parsed.data.workerName), 200);
    } catch (error) { return failure(error); }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
export async function POST(request: Request) {
  if (!isAmuxV22RecoveryInspectorAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  if (!amuxV22TaskRecoveryEnabled(process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]))
    return amuxJsonNoStore({ error: "recovery_disabled" }, 409);
  return withAmuxRouteBudget(async () => {
    try {
      await consumeApiRateLimit(request, "amux-fixed-recovery-checker", "amux-recovery-inspection-report", { minute: 20, day: 1_000 });
      const body = await readLimitedJson(request, 4_096, amuxV22RecoveryEvidenceSchema);
      return amuxJsonNoStore(await reportAmuxV22RecoveryEvidence(body), 200);
    } catch (error) { return failure(error); }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
