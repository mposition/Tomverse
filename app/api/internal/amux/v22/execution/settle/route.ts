export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { AMUX_MAX_EXPECTED_REVISION, AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema } from "@/lib/amux/claimContract";
import { AMUX_V22_EXECUTION_ROUTE_BUDGET_MS,
  withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { AMUX_V22_CHANGED_PATHS_UNRECORDED,
  settleAmuxV22TaskExecution } from "@/lib/amux/execution";
import { amuxV22NamedChangedPathsSchema } from "@/lib/amux/v22ChangedPathsCore";
import { amuxV22SettlementAllowanceMs,
  resolveAmuxV22NamedChangedPaths } from "@/lib/amux/v22ChangedPathsStore";
import { AMUX_V22_PROXY_BODY_MAX_BYTES } from "@/lib/amux/v22TransferCore";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxInternalErrorResponse, amuxJsonNoStore,
  isAmuxInputError } from "@/lib/amux/internalRoute";

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
  // Counts are bounded by the body (the proxy buffer), not by a number of ours.
  invocation_ids: z.array(z.string().uuid()),
  // A bridge from before the chunked transfer sends the list itself.
  changed_paths: z.array(z.string().max(32 * 1024)).optional(),
  // A current bridge names the list it committed (changed-paths route).
  ...amuxV22NamedChangedPathsSchema,
  read_only_retry: readOnlyRetrySchema.optional(),
  // What the sidecar said about a run with no verified result (owner
  // decision 2026-11-15, lib/amux/infraFailureCore.ts). Codes only.
  failure: z.object({
    code: z.string().regex(/^[a-z0-9_]{1,64}$/),
    cli_started: z.boolean().nullable().optional(),
    exit_code: z.number().int().min(-1_000).max(1_000).nullable().optional(),
    elapsed_ms: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).nullable().optional(),
  }).strict().optional(),
}).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request))
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  let body: z.infer<typeof requestSchema>;
  let allowanceMs: number;
  try {
    // The old inline list is bounded by the proxy buffer only (external).
    body = await readLimitedJson(request, AMUX_V22_PROXY_BODY_MAX_BYTES, requestSchema);
    // The time the patch and the list take grows with them (v22TransferCore.ts).
    allowanceMs = await amuxV22SettlementAllowanceMs(body.attempt_id);
  } catch (error) {
    if (isAmuxInputError(error))
      return amuxJsonNoStore({ error: "Invalid request." }, 400);
    return amuxInternalErrorResponse("v22_execution_settle", error);
  }
  return withAmuxRouteBudget(async () => {
    try {
      // The named list is opened here, outside the settlement's DB boundary.
      const named = await resolveAmuxV22NamedChangedPaths(body.attempt_id, body);
      if (named.kind === "invalid")
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      if (named.kind === "unrecorded")
        return amuxJsonNoStore({ settled: false,
          reason: AMUX_V22_CHANGED_PATHS_UNRECORDED }, 409);
      const changedPaths = named.kind === "paths" ? named.paths : body.changed_paths;
      const result = await settleAmuxV22TaskExecution({
        attemptId: body.attempt_id, worker: body.worker,
        instanceId: body.instance_id, generation: body.generation,
        taskRevision: body.task_revision, outcome: body.outcome,
        invocationIds: body.invocation_ids,
        ...(changedPaths ? { changedPaths } : {}),
        // Only an unverified settlement carries it; any other is judged on its receipt.
        ...(body.failure && body.outcome === "blocked" ? { failure: {
          code: body.failure.code, cliStarted: body.failure.cli_started ?? null,
          exitCode: body.failure.exit_code ?? null,
          elapsedMs: body.failure.elapsed_ms ?? null } } : {}),
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
  }, AMUX_V22_EXECUTION_ROUTE_BUDGET_MS + allowanceMs);
}
