export const dynamic = "force-dynamic";

import { z } from "zod";
import { ApiSecurityError, readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxExecutionApiEnabled } from "@/lib/amux/executionGate";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import {
  compareAmuxRoutingRank,
  decideAmuxClaimEvidence,
  isSelectedAmuxWorkerOwnershipReady,
} from "@/lib/amux/claimEvidenceCore";
import { buildAmuxRoutingSnapshot } from "@/lib/amux/routing";
import {
  scoreAmuxWorkers,
  type AmuxRoutingScoreResult,
} from "@/lib/amux/workerRouterCore";
import { scoreAmuxScheduler } from "@/lib/amux/schedulerScoreCore";
import {
  AMUX_GLOBAL_PRIORITY_VERSION,
  AMUX_WORKER_ROUTER_VERSION,
} from "@/lib/amux/planningCore";
import {
  claimUnownedTodo,
  getAuthoritativeSchedulerFacts,
  recordAmuxClaimRefusal,
} from "@/lib/amux/store";

const schedulerSignalsSchema = z
  .object({
    pin: z.number().int().min(0).max(10_000),
    age_hours: z.number().int().min(0).max(1_000_000),
    type_weight: z.number().int().min(0).max(40),
    priority_weight: z.number().int().min(0).max(40),
    dependents: z.number().int().min(0).max(1_000_000),
    dependent_weight: z.number().int().min(0).max(5_000_000),
    drag: z.number().int().min(0).max(8),
  })
  .strict();

const schedulerV2SignalsSchema = schedulerSignalsSchema.extend({
  urgency: z.number().int().min(0).max(240),
  capacity_weight: z.number().int().min(0).max(20),
  incident_bonus: z.number().int().min(0).max(80),
  total: z.number().int().optional(),
});

const unitScore = z.number().min(0).max(1);

const metricSchema = z
  .object({
    value: unitScore,
    observed: z.boolean(),
  })
  .strict();

const taskFitSchema = z
  .object({
    role_fit: unitScore,
    provider_fit: unitScore,
    combined: unitScore,
    large_task: z.boolean(),
  })
  .strict();

const candidateSchema = z
  .object({
    worker_name: z
      .string()
      .trim()
      .min(1)
      .max(120)
      .regex(/^[A-Za-z0-9._:-]+$/),
    provider: z.string().trim().min(1).max(80),
    breakdown: z
      .object({
        task_fit: taskFitSchema,
        predicted_success: metricSchema,
        quota_remaining: metricSchema,
        expected_speed: metricSchema,
        low_rework: metricSchema,
        low_human_attention: metricSchema,
        cost_efficiency: metricSchema,
        selected_score: unitScore,
        intrinsic_score: unitScore,
        operationally_allowed: z.boolean(),
        provider_exhausted: z.boolean(),
        selected_eligible: z.boolean(),
      })
      .strict(),
  })
  .strict();

const routingEvidenceSchema = z
  .object({
    // Accept the previous client version during a rolling deployment. The
    // persisted decision is always recomputed and stamped with the current
    // server version below.
    scoring_version: z.enum(["amux-worker-router-v1", "amux-worker-router-v2"]),
    preferred_worker: z.string().trim().min(1).max(120).nullable(),
    selected_worker: z.string().trim().min(1).max(120).nullable(),
    preferred_score: unitScore.nullable(),
    selected_score: unitScore.nullable(),
    candidates: z.array(candidateSchema).min(1).max(128),
  })
  .strict();

const signalsSchema = z
  .object({
    scheduler: z.union([schedulerSignalsSchema, schedulerV2SignalsSchema]),
    routing: routingEvidenceSchema,
  })
  .strict();

const requestSchema = z
  .object({
    task_id: z.string().trim().min(1).max(120),
    worker: z.string().trim().min(1).max(120),
    expected_revision: z.number().int().min(0),
    decision: z
      .object({
        scheduler_score: z.number().int(),
        scoring_version: z.enum([
          "amux-global-priority-v1",
          "amux-global-priority-v2",
        ]),
        signals: signalsSchema,
      })
      .strict(),
  })
  .strict();

// Rust and JavaScript both persist the server-authoritative full precision,
// but caller parity is compared as basis points. Cross-language floating-point
// noise must not reject an otherwise identical decision, and differences too
// small to survive the recorded confidence model are not meaningful evidence.
const routingBasisPoints = (value: number) => Math.round(value * 10_000);
const scoreEqual = (left: number, right: number) =>
  routingBasisPoints(left) === routingBasisPoints(right);

const validateRoutingEvidence = (
  worker: string,
  routing: z.infer<typeof routingEvidenceSchema>,
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
    .sort((left, right) =>
      compareAmuxRoutingRank({
        left_worker: left.worker_name,
        left_score: left.breakdown.intrinsic_score,
        right_worker: right.worker_name,
        right_score: right.breakdown.intrinsic_score,
      }),
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
    .sort((left, right) =>
      compareAmuxRoutingRank({
        left_worker: left.worker_name,
        left_score: left.breakdown.selected_score,
        right_worker: right.worker_name,
        right_score: right.breakdown.selected_score,
      }),
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
  client: z.infer<typeof routingEvidenceSchema>,
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
    return Response.json(
      { error: "Unauthorized" },
      {
        status: 401,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }

  try {
    if (!isAmuxExecutionApiEnabled()) {
      await recordAmuxClaimRefusal("execution_api_disabled");
      return Response.json(
        { claimed: false, reason: "execution_api_disabled" },
        { status: 409, headers: { "Cache-Control": "no-store" } },
      );
    }

    let body: z.infer<typeof requestSchema>;
    try {
      body = await readLimitedJson(request, 256 * 1_024, requestSchema);
    } catch (error) {
      if (
        !(error instanceof ApiSecurityError) ||
        !["INVALID_JSON", "INVALID_REQUEST", "REQUEST_BODY_TOO_LARGE"].includes(
          error.code,
        )
      ) {
        throw error;
      }
      await recordAmuxClaimRefusal("invalid_request");
      return Response.json(
        { error: "Invalid request." },
        {
          status: error.status,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const scheduler = body.decision.signals.scheduler;

    if (scheduler.dependent_weight !== scheduler.dependents * 5) {
      await recordAmuxClaimRefusal("dependent_weight_mismatch", {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        { error: "Invalid decision signals." },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const recomputedSchedulerScore =
      scheduler.pin +
      scheduler.age_hours +
      scheduler.type_weight +
      scheduler.priority_weight +
      scheduler.dependent_weight +
      scheduler.drag +
      ("urgency" in scheduler ? scheduler.urgency : 0) +
      ("capacity_weight" in scheduler ? scheduler.capacity_weight : 0) +
      ("incident_bonus" in scheduler ? scheduler.incident_bonus : 0);

    if (
      recomputedSchedulerScore !== body.decision.scheduler_score ||
      ("total" in scheduler &&
        scheduler.total !== undefined &&
        scheduler.total !== recomputedSchedulerScore)
    ) {
      await recordAmuxClaimRefusal("scheduler_score_mismatch", {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        { error: "Invalid scheduler score." },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    /*
     * Re-read server-owned task/catalog facts immediately before ownership.
     * The later store mutation performs the authoritative revision CAS again.
     */
    const schedulerObservedAt = new Date();
    const [authoritativeSnapshot, schedulerFacts] = await Promise.all([
      buildAmuxRoutingSnapshot(body.task_id, body.expected_revision),
      getAuthoritativeSchedulerFacts(body.task_id, body.expected_revision),
    ]);

    if (!schedulerFacts) {
      await recordAmuxClaimRefusal("not_eligible", {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        {
          claimed: false,
          reason: "not_eligible",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const authoritativeScheduler = scoreAmuxScheduler({
      ...schedulerFacts,
      now: schedulerObservedAt,
    });
    const authoritativeSchedulerSignals = authoritativeScheduler;
    const schedulerMatchesAuthority =
      scheduler.pin === authoritativeScheduler.pin &&
      scheduler.age_hours === authoritativeScheduler.age_hours &&
      scheduler.type_weight === authoritativeScheduler.type_weight &&
      scheduler.priority_weight === authoritativeScheduler.priority_weight &&
      scheduler.dependents === authoritativeScheduler.dependents &&
      scheduler.dependent_weight === authoritativeScheduler.dependent_weight &&
      scheduler.drag === authoritativeScheduler.drag &&
      "urgency" in scheduler &&
      scheduler.urgency === authoritativeScheduler.urgency &&
      scheduler.capacity_weight === authoritativeScheduler.capacity_weight &&
      scheduler.incident_bonus === authoritativeScheduler.incident_bonus;

    if (
      body.decision.scheduler_score !== authoritativeScheduler.total ||
      !schedulerMatchesAuthority
    ) {
      console.info(
        JSON.stringify({
          subsystem: "amux",
          event: "scheduler_evidence_recomputed",
          task_id: body.task_id,
          expected_revision: body.expected_revision,
          scoring_version: body.decision.scoring_version,
          proposed_score: body.decision.scheduler_score,
          authoritative_score: authoritativeScheduler.total,
          observed_at: schedulerObservedAt.toISOString(),
        }),
      );
    }

    if (!authoritativeSnapshot.eligible) {
      await recordAmuxClaimRefusal(authoritativeSnapshot.reason, {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        {
          claimed: false,
          reason: authoritativeSnapshot.reason,
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
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
      return Response.json(
        {
          claimed: false,
          reason: "no_authoritative_worker",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    if (authoritativeRouting.selected_worker !== body.worker) {
      await recordAmuxClaimRefusal("authoritative_worker_mismatch", {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        {
          claimed: false,
          reason: "authoritative_worker_mismatch",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    if (
      !isSelectedAmuxWorkerOwnershipReady(
        authoritativeSnapshot.candidates,
        body.worker,
      )
    ) {
      await recordAmuxClaimRefusal("no_authoritative_worker", {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        {
          claimed: false,
          reason: "no_authoritative_worker",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const evidenceDecision = decideAmuxClaimEvidence({
      internally_consistent: validateRoutingEvidence(
        body.worker,
        body.decision.signals.routing,
      ),
      matches_claim_time_authority: routingMatchesAuthoritative(
        body.decision.signals.routing,
        authoritativeRouting,
      ),
    });
    if (!evidenceDecision.allowed) {
      await recordAmuxClaimRefusal("invalid_routing_evidence", {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        {
          claimed: false,
          reason: "invalid_routing_evidence",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    /*
     * Historical and quota metrics are time-dependent. The routing snapshot
     * fetched by the orchestrator and this claim-time snapshot cannot be
     * byte-for-byte equal even when both are honest. The selected worker was
     * already checked against the claim-time authoritative result above, and
     * only that authoritative result is persisted below. Caller drift is
     * diagnostic evidence, never an admission failure.
     */
    if (evidenceDecision.record_drift) {
      console.info(
        JSON.stringify({
          subsystem: "amux",
          event: "routing_evidence_recomputed",
          task_id: body.task_id,
          expected_revision: body.expected_revision,
          proposed_worker: body.decision.signals.routing.selected_worker,
          authoritative_worker: authoritativeRouting.selected_worker,
          observed_at: schedulerObservedAt.toISOString(),
        }),
      );
    }

    // Do not claim unless the lifecycle has at least one live specialist path.
    if (!authoritativeSnapshot.execution_ready) {
      await recordAmuxClaimRefusal("execution_lifecycle_unavailable", {
        taskId: body.task_id,
        worker: body.worker,
        expectedRevision: body.expected_revision,
      });
      return Response.json(
        {
          claimed: false,
          reason: "execution_lifecycle_unavailable",
        },
        {
          status: 409,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }

    const claim = await claimUnownedTodo({
      taskId: body.task_id,
      worker: body.worker,
      expectedRevision: body.expected_revision,
      schedulerScore: authoritativeScheduler.total,
      scoringVersion: AMUX_GLOBAL_PRIORITY_VERSION,
      signals: {
        scheduler: authoritativeSchedulerSignals,
        planning: {
          deadline: schedulerFacts.deadline
            ? {
                due_at: schedulerFacts.deadline.due_at,
                precision: schedulerFacts.deadline.precision,
                source: schedulerFacts.deadline.source,
              }
            : null,
          capacity_weight: schedulerFacts.capacityWeight,
        },
        routing: {
          scoring_version: AMUX_WORKER_ROUTER_VERSION,
          ...authoritativeRouting,
        },
        telemetry: authoritativeSnapshot.telemetry,
      },
    });

    if (!claim.claimed) {
      return claim.reason === "cas_lost"
        ? Response.json(
            { claimed: false },
            { headers: { "Cache-Control": "no-store" } },
          )
        : Response.json(
            { claimed: false, reason: claim.reason },
            { status: 409, headers: { "Cache-Control": "no-store" } },
          );
    }

    return Response.json(
      {
        claimed: true,
        revision: claim.revision,
        decision_id: claim.decisionId,
      },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Internal error." },
      {
        status: 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
