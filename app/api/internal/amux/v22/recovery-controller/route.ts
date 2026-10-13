export const dynamic = "force-dynamic";

import { apiSecurityResponse, consumeApiRateLimit, readLimitedJson } from "@/lib/apiSecurity";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS, withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { amuxJsonNoStore, amuxInternalErrorResponse, isAmuxInputError } from
  "@/lib/amux/internalRoute";
import { AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV,
  AMUX_V22_TASK_RECOVERY_ENABLED_ENV, amuxV22LegacySafeStopEnabled,
  amuxV22RecoveryControllerReportSchema, amuxV22TaskRecoveryEnabled,
  isAmuxV22RecoveryControllerAuthorized } from "@/lib/amux/v22TaskRecoveryCore";
import { pendingAmuxV22LegacySafeStops,
  reportAmuxV22LegacySafeStopEvidence, reportAmuxV22ReadOnlyLaunchProof } from
  "@/lib/amux/v22TaskRecoveryService";

function capabilityFailure() {
  if (!amuxV22TaskRecoveryEnabled(process.env[AMUX_V22_TASK_RECOVERY_ENABLED_ENV]))
    return amuxJsonNoStore({ error: "recovery_disabled", requests: [] }, 409);
  if (!amuxV22LegacySafeStopEnabled(
      process.env[AMUX_V22_LEGACY_SAFE_STOP_ENABLED_ENV]))
    return amuxJsonNoStore({ error: "safe_stop_disabled", requests: [] }, 409);
  return null;
}
function failure(error: unknown) {
  if (isAmuxInputError(error)) return amuxJsonNoStore({ error: "INVALID_REQUEST" }, 400);
  const security = apiSecurityResponse(error);
  if (security) {
    security.headers.set("Cache-Control", "private, no-store, max-age=0");
    return security;
  }
  if (error instanceof BoardImportError)
    return amuxJsonNoStore({ error: error.code, retry: false },
      error.code === "outcome_unknown" ? 503 : error.httpStatus);
  return amuxInternalErrorResponse("v22_recovery_controller", error);
}

export async function GET(request: Request) {
  if (!isAmuxV22RecoveryControllerAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const disabled = capabilityFailure();
  if (disabled) return disabled;
  return withAmuxRouteBudget(async () => {
    try {
      if ([...new URL(request.url).searchParams].length)
        return amuxJsonNoStore({ error: "INVALID_REQUEST" }, 400);
      await consumeApiRateLimit(request, "amux-v22-recovery-controller",
        "amux-recovery-safe-stop-read", { minute: 30, day: 2_000 });
      return amuxJsonNoStore(await pendingAmuxV22LegacySafeStops(), 200);
    } catch (error) { return failure(error); }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}

export async function POST(request: Request) {
  if (!isAmuxV22RecoveryControllerAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  const disabled = capabilityFailure();
  if (disabled) return disabled;
  return withAmuxRouteBudget(async () => {
    try {
      await consumeApiRateLimit(request, "amux-v22-recovery-controller",
        "amux-recovery-safe-stop-report", { minute: 20, day: 1_000 });
      const body = await readLimitedJson(request, 8_192,
        amuxV22RecoveryControllerReportSchema);
      return amuxJsonNoStore(body.requestKind === "safe_stop" ?
        await reportAmuxV22LegacySafeStopEvidence(body) :
        await reportAmuxV22ReadOnlyLaunchProof(body), 200);
    } catch (error) { return failure(error); }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
