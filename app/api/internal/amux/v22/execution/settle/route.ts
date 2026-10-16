export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { settleAmuxV22TaskExecution } from "@/lib/amux/execution";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore,
  isAmuxInputError } from "@/lib/amux/internalRoute";
import { AMUX_V22_TASK_EXECUTION_CODE_LATCH } from
  "@/lib/amux/v22TaskExecutionCore";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const readOnlyRetryBase = {
  version: z.literal(1), launch_binding_id: z.string().uuid(),
  launch_proof_digest: digest, launch_scope_digest: digest,
};
const readOnlyRetrySchema = z.union([
  z.object(readOnlyRetryBase).strict(),
  z.object({ ...readOnlyRetryBase,
    executor_kind: z.literal("read_only_api_retry_v1"),
    launcher_config_digest: digest,
    api_execution_frame_digest: digest,
    api_execution_receipt: z.unknown(),
  }).strict(),
]);

const requestSchema = z.object({ attempt_id: z.string().uuid(),
  worker: amuxMachineIdSchema, instance_id: z.string().uuid(),
  generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
  task_revision: z.number().int().min(0).max(AMUX_MAX_EXPECTED_REVISION),
  outcome: z.enum(["succeeded", "failed", "blocked"]),
  invocation_ids: z.array(z.string().uuid()).max(128),
  changed_paths: z.array(z.string().max(32 * 1024)).max(4_096).optional(),
  read_only_retry: readOnlyRetrySchema.optional(),
}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  // An environment kill switch closes admission, not settlement of an
  // existing fenced attempt. A code-latch-off build stays dark.
  if (!AMUX_V22_TASK_EXECUTION_CODE_LATCH)
    return amuxJsonNoStore({ settled: false,
      reason: "v22_execution_disabled" }, 409);
  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 64 * 1_024, requestSchema);
      const result = await settleAmuxV22TaskExecution({
        attemptId: body.attempt_id, worker: body.worker,
        instanceId: body.instance_id, generation: body.generation,
        taskRevision: body.task_revision, outcome: body.outcome,
        invocationIds: body.invocation_ids,
        ...(body.changed_paths ? { changedPaths: body.changed_paths } : {}),
        readOnlyRetry: body.read_only_retry ? {
          version: body.read_only_retry.version,
          launchBindingId: body.read_only_retry.launch_binding_id,
          launchProofDigest: body.read_only_retry.launch_proof_digest,
          launchScopeDigest: body.read_only_retry.launch_scope_digest,
          ...("executor_kind" in body.read_only_retry ? {
            executorKind: body.read_only_retry.executor_kind,
            launcherConfigDigest: body.read_only_retry.launcher_config_digest,
            apiExecutionFrameDigest:
              body.read_only_retry.api_execution_frame_digest,
            apiExecutionReceipt: body.read_only_retry.api_execution_receipt,
          } : {}) } : undefined,
      });
      return amuxJsonNoStore(result, result.settled ? 200 : 409);
    } catch (error) {
      if (isAmuxInputError(error))
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      return amuxInternalErrorResponse("v22_execution_settle", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
