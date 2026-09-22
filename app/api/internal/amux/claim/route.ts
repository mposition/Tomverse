export const dynamic = "force-dynamic";

import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import {
  amuxClaimRequestSchema,
  type AmuxClaimRequest,
  type AmuxRoutingEvidence,
} from "@/lib/amux/claimContract";
import {
  AMUX_CLAIM_ROUTE_BUDGET_MS,
  anchorAmuxClaimDeadline,
} from "@/lib/amux/claimDeadline";
import { withAmuxRouteBudget } from "@/lib/amux/dbBoundary";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { buildAmuxRoutingSnapshot } from "@/lib/amux/routing";
import {
  scoreAmuxWorkers,
  type AmuxRoutingScoreResult,
} from "@/lib/amux/workerRouterCore";
import { claimUnownedTodo, recordAmuxClaimRefusal } from "@/lib/amux/store";
import { amuxInternalErrorResponse } from "@/lib/amux/internalRoute";

const noStoreHeaders = { "Cache-Control": "no-store" } as const;

const jsonNoStore = (body: unknown, status: number = 200) =>
  Response.json(body, { status, headers: noStoreHeaders });

const isClaimInputError = (error: unknown): error is ApiSecurityError =>
  error instanceof ApiSecurityError &&
  ["INVALID_JSON", "INVALID_REQUEST", "REQUEST_BODY_TOO_LARGE"].includes(
    error.code,
  );

const scoreEqual = (left: number, right: number) =>
  Math.abs(left - right) <= 1e-12;

const workerNameCompare = (
  left: { worker_name: string },
  right: { worker_name: string },
) =>
  left.worker_name < right.worker_name
    ? -1
    : left.worker_name > right.worker_name
      ? 1
      : 0;

const validateRoutingEvidence = (
  worker: string,
  routing: AmuxRoutingEvidence,
) => {
  const names = routing.candidates.map((candidate) => candidate.worker_name);

  if (new Set(names).size !== names.length) {
    return false;
  }

  for (const candidate of routing.candidates) {
    const breakdown = candidate.breakdown;

    for (const metric of [
      breakdown.predicted_success,
      breakdown.quota_remaining,
      breakdown.expected_speed,
      breakdown.low_rework,
      breakdown.low_human_attention,
      breakdown.cost_efficiency,
    ]) {
      if (!metric.observed && !scoreEqual(metric.value, 0.5)) {
        return false;
      }
    }

    if (
      breakdown.provider_exhausted &&
      (!breakdown.quota_remaining.observed ||
        !scoreEqual(breakdown.quota_remaining.value, 0))
    ) {
      return false;
    }

    if (
      breakdown.selected_eligible &&
      (!breakdown.operationally_allowed || breakdown.provider_exhausted)
    ) {
      return false;
    }
  }

  const preferred = [...routing.candidates]
    .filter((candidate) => candidate.breakdown.operationally_allowed)
    .sort(
      (left, right) =>
        right.breakdown.intrinsic_score - left.breakdown.intrinsic_score ||
        workerNameCompare(left, right),
    )[0];

  if (!preferred) {
    if (routing.preferred_worker !== null || routing.preferred_score !== null) {
      return false;
    }
  } else if (
    routing.preferred_worker !== preferred.worker_name ||
    routing.preferred_score === null ||
    !scoreEqual(routing.preferred_score, preferred.breakdown.intrinsic_score)
  ) {
    return false;
  }

  const selected = [...routing.candidates]
    .filter((candidate) => candidate.breakdown.selected_eligible)
    .sort(
      (left, right) =>
        right.breakdown.selected_score - left.breakdown.selected_score ||
        workerNameCompare(left, right),
    )[0];

  if (
    !selected ||
    routing.selected_worker !== worker ||
    routing.selected_worker !== selected.worker_name ||
    routing.selected_score === null ||
    !scoreEqual(routing.selected_score, selected.breakdown.selected_score)
  ) {
    return false;
  }

  return true;
};

const routingMatchesAuthoritative = (
  client: AmuxRoutingEvidence,
  authoritative: AmuxRoutingScoreResult,
) => {
  if (
    client.preferred_worker !== authoritative.preferred_worker ||
    client.selected_worker !== authoritative.selected_worker
  ) {
    return false;
  }

  if (
    (client.preferred_score === null) !==
      (authoritative.preferred_score === null) ||
    (client.selected_score === null) !== (authoritative.selected_score === null)
  ) {
    return false;
  }

  if (
    client.preferred_score !== null &&
    authoritative.preferred_score !== null &&
    !scoreEqual(client.preferred_score, authoritative.preferred_score)
  ) {
    return false;
  }

  if (
    client.selected_score !== null &&
    authoritative.selected_score !== null &&
    !scoreEqual(client.selected_score, authoritative.selected_score)
  ) {
    return false;
  }

  if (client.candidates.length !== authoritative.candidates.length) {
    return false;
  }

  for (let index = 0; index < authoritative.candidates.length; index += 1) {
    const left = client.candidates[index];
    const right = authoritative.candidates[index];

    if (!left || !right) {
      return false;
    }

    if (
      left.worker_name !== right.worker_name ||
      left.provider !== right.provider
    ) {
      return false;
    }

    const a = left.breakdown;
    const b = right.breakdown;

    if (
      a.task_fit.large_task !== b.task_fit.large_task ||
      !scoreEqual(a.task_fit.role_fit, b.task_fit.role_fit) ||
      !scoreEqual(a.task_fit.provider_fit, b.task_fit.provider_fit) ||
      !scoreEqual(a.task_fit.combined, b.task_fit.combined) ||
      !scoreEqual(a.selected_score, b.selected_score) ||
      !scoreEqual(a.intrinsic_score, b.intrinsic_score) ||
      a.operationally_allowed !== b.operationally_allowed ||
      a.provider_exhausted !== b.provider_exhausted ||
      a.selected_eligible !== b.selected_eligible
    ) {
      return false;
    }

    const metricPairs = [
      [a.predicted_success, b.predicted_success],
      [a.quota_remaining, b.quota_remaining],
      [a.expected_speed, b.expected_speed],
      [a.low_rework, b.low_rework],
      [a.low_human_attention, b.low_human_attention],
      [a.cost_efficiency, b.cost_efficiency],
    ] as const;

    for (const [clientMetric, serverMetric] of metricPairs) {
      if (
        clientMetric.observed !== serverMetric.observed ||
        !scoreEqual(clientMetric.value, serverMetric.value)
      ) {
        return false;
      }
    }
  }

  return true;
};

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return jsonNoStore({ error: "Unauthorized" }, 401);
  }

  return withAmuxRouteBudget(async () => {
    try {
      await anchorAmuxClaimDeadline();
      if (!isAmuxExecutionApiEnabled()) {
        await recordAmuxClaimRefusal("execution_api_disabled");

        return jsonNoStore(
          { claimed: false, reason: "execution_api_disabled" },
          409,
        );
      }

      let body: AmuxClaimRequest;
      try {
        body = await readLimitedJson(
          request,
          256 * 1_024,
          amuxClaimRequestSchema,
        );
      } catch (error) {
        if (!isClaimInputError(error)) {
          throw error;
        }

        // Do not retain body bytes or parser/schema detail in the audit row.
        await recordAmuxClaimRefusal("invalid_request");
        return jsonNoStore({ error: "Invalid request." }, 400);
      }

      const scheduler = body.decision.signals.scheduler;

      if (scheduler.dependent_weight !== scheduler.dependents * 5) {
        await recordAmuxClaimRefusal("dependent_weight_mismatch", {
          taskId: body.task_id,
          worker: body.worker,
          expectedRevision: body.expected_revision,
        });

        return jsonNoStore({ error: "Invalid request." }, 400);
      }

      const recomputedSchedulerScore =
        scheduler.pin +
        scheduler.age_hours +
        scheduler.type_weight +
        scheduler.priority_weight +
        scheduler.dependent_weight +
        scheduler.drag;

      if (recomputedSchedulerScore !== body.decision.scheduler_score) {
        await recordAmuxClaimRefusal("scheduler_score_mismatch", {
          taskId: body.task_id,
          worker: body.worker,
          expectedRevision: body.expected_revision,
        });

        return jsonNoStore({ error: "Invalid request." }, 400);
      }

      /*
       * Re-read server-owned task/catalog facts immediately before ownership.
       * The later store mutation performs the authoritative revision CAS again.
       */
      const authoritativeSnapshot = await buildAmuxRoutingSnapshot(
        body.task_id,
        body.expected_revision,
      );

      if (!authoritativeSnapshot.eligible) {
        await recordAmuxClaimRefusal(authoritativeSnapshot.reason, {
          taskId: body.task_id,
          worker: body.worker,
          expectedRevision: body.expected_revision,
        });

        return jsonNoStore(
          {
            claimed: false,
            reason: authoritativeSnapshot.reason,
          },
          409,
        );
      }

      const authoritativeRouting = scoreAmuxWorkers(
        authoritativeSnapshot.task,
        authoritativeSnapshot.candidates,
      );

      if (authoritativeRouting.selected_worker === null) {
        await recordAmuxClaimRefusal("no_authoritative_worker", {
          taskId: body.task_id,
          worker: body.worker,
          expectedRevision: body.expected_revision,
        });

        return jsonNoStore(
          {
            claimed: false,
            reason: "no_authoritative_worker",
          },
          409,
        );
      }

      if (authoritativeRouting.selected_worker !== body.worker) {
        await recordAmuxClaimRefusal("authoritative_worker_mismatch", {
          taskId: body.task_id,
          worker: body.worker,
          expectedRevision: body.expected_revision,
        });

        return jsonNoStore(
          {
            claimed: false,
            reason: "authoritative_worker_mismatch",
          },
          409,
        );
      }

      if (
        !validateRoutingEvidence(body.worker, body.decision.signals.routing) ||
        !routingMatchesAuthoritative(
          body.decision.signals.routing,
          authoritativeRouting,
        )
      ) {
        await recordAmuxClaimRefusal("invalid_routing_evidence", {
          taskId: body.task_id,
          worker: body.worker,
          expectedRevision: body.expected_revision,
        });

        return jsonNoStore(
          {
            claimed: false,
            reason: "invalid_routing_evidence",
          },
          409,
        );
      }

      /*
       * Critical pre-lifecycle guard.
       *
       * A stopped worker is intentionally scoreable for upstream parity, but
       * Tomverse must not leave ownership on it until startup + delivery +
       * execution-attempt lifecycle actually exists.
       */
      if (!authoritativeSnapshot.execution_ready) {
        await recordAmuxClaimRefusal("execution_lifecycle_unavailable", {
          taskId: body.task_id,
          worker: body.worker,
          expectedRevision: body.expected_revision,
        });

        return jsonNoStore(
          {
            claimed: false,
            reason: "execution_lifecycle_unavailable",
          },
          409,
        );
      }

      const claim = await claimUnownedTodo({
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
        schedulerScore: body.decision.scheduler_score,
        scoringVersion: body.decision.scoring_version,
        signals: {
          scheduler: body.decision.signals.scheduler,
          routing: {
            scoring_version: "amux-worker-router-v1",
            ...authoritativeRouting,
          },
        },
      });

      return jsonNoStore(
        claim
          ? {
              claimed: true,
              revision: claim.revision,
              decision_id: claim.decisionId,
            }
          : { claimed: false },
      );
    } catch (error) {
      return amuxInternalErrorResponse("claim", error);
    }
  }, AMUX_CLAIM_ROUTE_BUDGET_MS);
}
