export const dynamic = "force-dynamic";
import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { amuxJsonNoStore, amuxInternalErrorResponse, isAmuxInputError } from "@/lib/amux/internalRoute";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS, withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { amuxV22RecoveryWorkerSchema, amuxV22RecoveryEvidenceSchema, amuxV22TaskRecoveryEnabled,
  AMUX_V22_TASK_RECOVERY_ENABLED_ENV, isAmuxV22RecoveryInspectorAuthorized,
  configuredAmuxV22RecoveryProfile } from
  "@/lib/amux/v22TaskRecoveryCore";
import { pendingAmuxV22RecoveryInspections, reportAmuxV22RecoveryEvidence } from "@/lib/amux/v22TaskRecoveryService";
const RECOVERY_CHECKER_KEY = "amux-fixed-recovery-checker";
// Owner decision 2026-11-07: one bucket per worker. Every inspector timer
// (one per worker, once a minute) shares the dedicated Bearer secret and the
// box's address, so a single fixed key or the IP leg made the workers exhaust
// one daily bucket together. Only a worker named in the recovery profile
// config gets its own bucket, so the bucket count stays bounded by that
// config; any other schema-valid name shares the old fixed bucket. The IP leg
// is skipped because the subject is that bounded worker identity behind the
// inspector secret, not the caller's address.
function consumeRecoveryCheckerLimit(request: Request, workerName: string, scope: string,
  limits: { minute: number; day: number }) {
  const key = configuredAmuxV22RecoveryProfile(workerName) ?
    `${RECOVERY_CHECKER_KEY}:${workerName}` : RECOVERY_CHECKER_KEY;
  return consumeApiRateLimit(request, key, scope, limits, { skipIpBucket: true });
}
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
      await consumeRecoveryCheckerLimit(request, parsed.data.workerName, "amux-recovery-inspection-read", { minute: 30, day: 2_000 });
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
      const body = await readLimitedJson(request, 4_096, amuxV22RecoveryEvidenceSchema);
      await consumeRecoveryCheckerLimit(request, body.workerName, "amux-recovery-inspection-report", { minute: 20, day: 1_000 });
      return amuxJsonNoStore(await reportAmuxV22RecoveryEvidence(body), 200);
    } catch (error) { return failure(error); }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
