export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import {
  AMUX_PRISMA_INT_MAX,
  amuxMachineIdSchema,
} from "@/lib/amux/claimContract";
import {
  AMUX_LIFECYCLE_ROUTE_BUDGET_MS,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import {
  amuxInternalErrorResponse,
  amuxJsonNoStore,
  isAmuxInputError,
} from "@/lib/amux/internalRoute";
import { pullAmuxWorkDelivery,
  type AmuxV22ReadOnlyDeliveryBinding } from "@/lib/amux/delivery";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";

const requestSchema = z
  .object({
    worker: amuxMachineIdSchema,
    instance_id: z.string().uuid(),
    generation: z.number().int().min(1).max(AMUX_PRISMA_INT_MAX),
  })
  .strict();

const serializeReadOnlyRetry = (binding: AmuxV22ReadOnlyDeliveryBinding) => {
  const common = {
    version: binding.version,
    launch_binding_id: binding.launchBindingId,
    risk_acceptance_digest: binding.riskAcceptanceDigest,
    safe_stop_evidence_digest: binding.safeStopEvidenceDigest,
    launch_proof_digest: binding.launchProofDigest,
    launch_scope_digest: binding.launchScopeDigest,
    launcher_config_digest: binding.launcherConfigDigest,
    brief_digest: binding.briefDigest,
    provider: binding.provider,
    model_id: binding.modelId,
    route_id: binding.routeId,
    route_policy_digest: binding.routePolicyDigest,
    catalog_approval_id: binding.catalogApprovalId,
    catalog_version: binding.catalogVersion,
    pricing_version: binding.pricingVersion,
    cost_receipt_digest: binding.costReceiptDigest,
    additional_cap_microusd: binding.additionalCapMicroUsd,
    worst_exposure_microusd: binding.worstExposureMicroUsd,
    role: binding.role,
  };
  return "executorKind" in binding ? { ...common,
    executor_kind: binding.executorKind,
    api_execution_frame: binding.apiExecutionFrame,
    api_execution_frame_digest: binding.apiExecutionFrameDigest,
  } : { ...common,
    launcher_policy_version: binding.launcherPolicyVersion,
    fixed_argv_digest: binding.fixedArgvDigest,
    tool_policy_digest: binding.toolPolicyDigest,
    profile_config_digest: binding.profileConfigDigest,
  };
};

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  if (!isAmuxExecutionApiEnabled()) {
    return Response.json(
      {
        available: false,
        reason: "execution_api_disabled",
      },
      {
        status: 409,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 2 * 1_024, requestSchema);

      const outcome = await pullAmuxWorkDelivery({
        worker: body.worker,
        instanceId: body.instance_id,
        generation: body.generation,
      });

      if (!outcome.available) {
        return Response.json(outcome, {
          status: outcome.reason === "runtime_not_ready" ? 409 : 200,
          headers: {
            "Cache-Control": "no-store",
          },
        });
      }

      return Response.json(
        {
          available: true,
          delivery: {
            attempt_id: outcome.delivery.attemptId,
            ...(outcome.delivery.assignmentId ?
              { assignment_id: outcome.delivery.assignmentId } : {}),
            ...(outcome.delivery.recoveryApprovalId ?
              { recovery_approval_id: outcome.delivery.recoveryApprovalId } : {}),
            ...(outcome.delivery.v22Execution ? { v22_execution: {
              model_id: outcome.delivery.v22Execution.modelId,
              role: outcome.delivery.v22Execution.role,
              budget_microusd: outcome.delivery.v22Execution.budgetMicrousd,
              ...(outcome.delivery.v22Execution.gradeGuard ?
                { grade_guard: true,
                  execution_grade: outcome.delivery.v22Execution.executionGrade,
                  ...(outcome.delivery.v22Execution.reviewScope ? {
                     review_author: outcome.delivery.v22Execution.reviewAuthor,
                    review_author_vendor:
                      outcome.delivery.v22Execution.reviewAuthorVendor,
                    review_scope: outcome.delivery.v22Execution.reviewScope,
                    ...(outcome.delivery.v22Execution.reviewFeedbackJobId ? {
                      review_feedback_job_id:
                        outcome.delivery.v22Execution.reviewFeedbackJobId,
                    } : {}),
                  } : {}),
                } : {}),
              ...(outcome.delivery.v22Execution.readOnlyRetry ? {
                read_only_retry: serializeReadOnlyRetry(
                  outcome.delivery.v22Execution.readOnlyRetry),
              } : {}),
            } } : {}),
            task_id: outcome.delivery.taskId,
            worker: outcome.delivery.worker,
            task_revision: outcome.delivery.taskRevision,
            prompt: outcome.delivery.prompt,
            receipt_id: outcome.delivery.receiptId,
            lease_expires_at: outcome.delivery.leaseExpiresAt.toISOString(),
          },
        },
        {
          headers: {
            "Cache-Control": "no-store",
          },
        },
      );
    } catch (error) {
      if (isAmuxInputError(error)) {
        return amuxJsonNoStore({ error: "Invalid request." }, 400);
      }
      return amuxInternalErrorResponse("delivery_pull", error);
    }
  }, AMUX_LIFECYCLE_ROUTE_BUDGET_MS);
}
