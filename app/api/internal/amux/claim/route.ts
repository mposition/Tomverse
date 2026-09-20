export const dynamic = "force-dynamic";

import { z } from "zod";
import { readLimitedJson } from "@/lib/apiSecurity";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { buildAmuxRoutingSnapshot } from "@/lib/amux/routing";
import {
  scoreAmuxWorkers,
  type AmuxRoutingScoreResult,
} from "@/lib/amux/workerRouterCore";
import { claimUnownedTodo } from "@/lib/amux/store";

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
    scoring_version: z.literal("amux-worker-router-v1"),
    preferred_worker: z.string().trim().min(1).max(120).nullable(),
    selected_worker: z.string().trim().min(1).max(120).nullable(),
    preferred_score: unitScore.nullable(),
    selected_score: unitScore.nullable(),
    candidates: z.array(candidateSchema).min(1).max(128),
  })
  .strict();

const signalsSchema = z
  .object({
    scheduler: schedulerSignalsSchema,
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
        scoring_version: z.literal("amux-global-priority-v1"),
        signals: signalsSchema,
      })
      .strict(),
  })
  .strict();

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
  routing: z.infer<typeof routingEvidenceSchema>,
) => {
  const names = routing.candidates.map(
    (candidate) => candidate.worker_name,
  );

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
      (!breakdown.operationally_allowed ||
        breakdown.provider_exhausted)
    ) {
      return false;
    }
  }

  const preferred = [...routing.candidates]
    .filter(
      (candidate) =>
        candidate.breakdown.operationally_allowed,
    )
    .sort(
      (left, right) =>
        right.breakdown.intrinsic_score -
          left.breakdown.intrinsic_score ||
        workerNameCompare(left, right),
    )[0];

  if (!preferred) {
    if (
      routing.preferred_worker !== null ||
      routing.preferred_score !== null
    ) {
      return false;
    }
  } else if (
    routing.preferred_worker !== preferred.worker_name ||
    routing.preferred_score === null ||
    !scoreEqual(
      routing.preferred_score,
      preferred.breakdown.intrinsic_score,
    )
  ) {
    return false;
  }

  const selected = [...routing.candidates]
    .filter(
      (candidate) =>
        candidate.breakdown.selected_eligible,
    )
    .sort(
      (left, right) =>
        right.breakdown.selected_score -
          left.breakdown.selected_score ||
        workerNameCompare(left, right),
    )[0];

  if (
    !selected ||
    routing.selected_worker !== worker ||
    routing.selected_worker !== selected.worker_name ||
    routing.selected_score === null ||
    !scoreEqual(
      routing.selected_score,
      selected.breakdown.selected_score,
    )
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
    client.preferred_worker !==
      authoritative.preferred_worker ||
    client.selected_worker !==
      authoritative.selected_worker
  ) {
    return false;
  }

  if (
    (client.preferred_score === null) !==
      (authoritative.preferred_score === null) ||
    (client.selected_score === null) !==
      (authoritative.selected_score === null)
  ) {
    return false;
  }

  if (
    client.preferred_score !== null &&
    authoritative.preferred_score !== null &&
    !scoreEqual(
      client.preferred_score,
      authoritative.preferred_score,
    )
  ) {
    return false;
  }

  if (
    client.selected_score !== null &&
    authoritative.selected_score !== null &&
    !scoreEqual(
      client.selected_score,
      authoritative.selected_score,
    )
  ) {
    return false;
  }

  if (
    client.candidates.length !==
    authoritative.candidates.length
  ) {
    return false;
  }

  for (
    let index = 0;
    index < authoritative.candidates.length;
    index += 1
  ) {
    const left = client.candidates[index];
    const right =
      authoritative.candidates[index];

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
      a.task_fit.large_task !==
        b.task_fit.large_task ||
      !scoreEqual(
        a.task_fit.role_fit,
        b.task_fit.role_fit,
      ) ||
      !scoreEqual(
        a.task_fit.provider_fit,
        b.task_fit.provider_fit,
      ) ||
      !scoreEqual(
        a.task_fit.combined,
        b.task_fit.combined,
      ) ||
      !scoreEqual(
        a.selected_score,
        b.selected_score,
      ) ||
      !scoreEqual(
        a.intrinsic_score,
        b.intrinsic_score,
      ) ||
      a.operationally_allowed !==
        b.operationally_allowed ||
      a.provider_exhausted !==
        b.provider_exhausted ||
      a.selected_eligible !==
        b.selected_eligible
    ) {
      return false;
    }

    const metricPairs = [
      [
        a.predicted_success,
        b.predicted_success,
      ],
      [
        a.quota_remaining,
        b.quota_remaining,
      ],
      [
        a.expected_speed,
        b.expected_speed,
      ],
      [
        a.low_rework,
        b.low_rework,
      ],
      [
        a.low_human_attention,
        b.low_human_attention,
      ],
      [
        a.cost_efficiency,
        b.cost_efficiency,
      ],
    ] as const;

    for (const [clientMetric, serverMetric] of metricPairs) {
      if (
        clientMetric.observed !==
          serverMetric.observed ||
        !scoreEqual(
          clientMetric.value,
          serverMetric.value,
        )
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
    const body = await readLimitedJson(
      request,
      256 * 1_024,
      requestSchema,
    );

    const scheduler = body.decision.signals.scheduler;

    if (
      scheduler.dependent_weight !==
      scheduler.dependents * 5
    ) {
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
      scheduler.drag;

    if (
      recomputedSchedulerScore !==
      body.decision.scheduler_score
    ) {
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
    const authoritativeSnapshot =
      await buildAmuxRoutingSnapshot(
        body.task_id,
        body.expected_revision,
      );

    if (!authoritativeSnapshot.eligible) {
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

    const authoritativeRouting =
      scoreAmuxWorkers(
        authoritativeSnapshot.task,
        authoritativeSnapshot.candidates,
      );

    if (
      authoritativeRouting.selected_worker === null
    ) {
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

    if (
      authoritativeRouting.selected_worker !==
      body.worker
    ) {
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
      !validateRoutingEvidence(
        body.worker,
        body.decision.signals.routing,
      ) ||
      !routingMatchesAuthoritative(
        body.decision.signals.routing,
        authoritativeRouting,
      )
    ) {
      return Response.json(
        {
          error:
            "Routing evidence does not match authoritative server scoring.",
        },
        {
          status: 400,
          headers: { "Cache-Control": "no-store" },
        },
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
      schedulerScore: body.decision.scheduler_score,
      scoringVersion: body.decision.scoring_version,
      signals: {
        scheduler:
          body.decision.signals.scheduler,
        routing: {
          scoring_version:
            "amux-worker-router-v1",
          ...authoritativeRouting,
        },
      },
    });

    return Response.json(
      claim
        ? {
            claimed: true,
            revision: claim.revision,
            decision_id: claim.decisionId,
          }
        : { claimed: false },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch {
    return Response.json(
      { error: "Invalid request." },
      {
        status: 400,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
