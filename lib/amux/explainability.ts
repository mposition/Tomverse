import "server-only";

import type { Prisma } from "@prisma/client";

import {
  parseAmuxIncidentSetting,
  AMUX_INCIDENT_SETTING_KEY,
} from "@/lib/amux/incidentCore";
import { publicAmuxEscalationReasonCode } from "@/lib/amux/escalation";
import { prisma } from "@/lib/prisma";

const asRecord = (value: Prisma.JsonValue | null | undefined) =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, Prisma.JsonValue>)
    : null;

const finite = (value: Prisma.JsonValue | undefined) =>
  typeof value === "number" && Number.isFinite(value) ? value : null;

const text = (value: Prisma.JsonValue | undefined) =>
  typeof value === "string" ? value : null;

const boolean = (value: Prisma.JsonValue | undefined) =>
  typeof value === "boolean" ? value : null;

const schedulerKeys = [
  "pin",
  "age_hours",
  "type_weight",
  "priority_weight",
  "dependents",
  "dependent_weight",
  "drag",
  "urgency",
  "capacity_weight",
  "incident_bonus",
] as const;

const metricKeys = [
  "task_fit",
  "predicted_success",
  "quota_remaining",
  "expected_speed",
  "low_rework",
  "low_human_attention",
  "cost_efficiency",
] as const;

const summarizeSignals = (signals: Prisma.JsonValue) => {
  const root = asRecord(signals);
  const scheduler = asRecord(root?.scheduler);
  const planning = asRecord(root?.planning);
  const deadline = asRecord(planning?.deadline);
  const admission = asRecord(root?.admission);
  const incidentAdmission = asRecord(admission?.incident);
  const routing = asRecord(root?.routing);
  const candidates = Array.isArray(routing?.candidates)
    ? routing.candidates
    : [];
  const selectedWorker = text(routing?.selected_worker);
  const selected = candidates
    .map(asRecord)
    .find((candidate) => text(candidate?.worker_name) === selectedWorker);
  const breakdown = asRecord(selected?.breakdown);
  const telemetryRoot = asRecord(root?.telemetry);
  const workerTelemetry = selectedWorker
    ? asRecord(telemetryRoot?.[selectedWorker])
    : null;
  const history = asRecord(workerTelemetry?.history);
  const quota = asRecord(workerTelemetry?.quota);
  const metricEvidence = (value: Prisma.JsonValue | undefined) => {
    const metric = asRecord(value);
    return metric
      ? {
          value: finite(metric.value),
          raw_value: finite(metric.raw_value),
          confidence: finite(metric.confidence),
          observed: boolean(metric.observed),
          source: text(metric.source),
          sample_size: finite(metric.sample_size),
          observed_at: text(metric.observed_at),
        }
      : null;
  };

  return {
    scheduler: Object.fromEntries(
      scheduler
        ? schedulerKeys.flatMap((key) => {
        const value = finite(scheduler?.[key]);
            return value === null ? [] : [[key, value]];
          })
        : [],
    ),
    planning: {
      due_at: text(deadline?.due_at),
      precision: text(deadline?.precision),
      source: text(deadline?.source),
      capacity_weight: finite(planning?.capacity_weight),
      incident_admission: text(incidentAdmission?.state),
    },
    routing: {
      scoring_version: text(routing?.scoring_version),
      preferred_worker: text(routing?.preferred_worker),
      selected_worker: selectedWorker,
      preferred_score: finite(routing?.preferred_score),
      selected_score: finite(routing?.selected_score),
      candidate_count: candidates.length,
      provider: text(selected?.provider),
      operationally_allowed: boolean(breakdown?.operationally_allowed),
      provider_exhausted: boolean(breakdown?.provider_exhausted),
      metrics: Object.fromEntries(
        metricKeys.flatMap((key) => {
          const metric = asRecord(breakdown?.[key]);
          if (!metric) return [];
          const value =
            key === "task_fit" ? finite(metric.combined) : finite(metric.value);
          const observed = key === "task_fit" ? true : boolean(metric.observed);
          return value === null ? [] : [[key, { value, observed }]];
        }),
      ),
    },
    telemetry: {
      history_sample_size: finite(history?.sample_size),
      predicted_success: metricEvidence(history?.predicted_success),
      expected_speed: metricEvidence(history?.expected_speed),
      low_rework: metricEvidence(history?.low_rework),
      low_human_attention: metricEvidence(history?.low_human_attention),
      cost_efficiency: metricEvidence(history?.cost_efficiency),
      quota: {
        metric: metricEvidence(quota),
        state: text(quota?.state),
        provider_exhausted: boolean(quota?.provider_exhausted),
        reset_at: text(quota?.reset_at),
      },
    },
  };
};

export async function getAmuxExplainabilityReport() {
  const [
    decisions,
    attempts,
    runtimes,
    queue,
    incidentRow,
    policies,
    escalations,
  ] = await Promise.all([
    prisma.amuxRouteDecision.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 50,
      select: {
        id: true,
        worker: true,
        schedulerScore: true,
        scoringVersion: true,
        taskRevision: true,
        signals: true,
        createdAt: true,
        task: {
          select: {
            id: true,
            title: true,
            kind: true,
            priority: true,
            status: true,
          },
        },
      },
    }),
    prisma.amuxExecutionAttempt.findMany({
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: 500,
      select: {
        worker: true,
        outcome: true,
        startedAt: true,
        endedAt: true,
      },
    }),
    prisma.amuxWorkerRuntime.findMany({
      orderBy: { workerName: "asc" },
      select: {
        workerName: true,
        status: true,
        dispatchReady: true,
        generation: true,
        heartbeatAt: true,
        leaseExpiresAt: true,
      },
    }),
    prisma.amuxWorkItem.groupBy({
      by: ["status"],
      where: { archivedAt: null },
      _count: { _all: true },
    }),
    prisma.appSetting.findUnique({
      where: { key: AMUX_INCIDENT_SETTING_KEY },
      select: { value: true, updatedAt: true },
    }),
    prisma.amuxResourcePolicy.findMany({
      orderBy: [{ scope: "asc" }, { key: "asc" }],
      select: {
        scope: true,
        key: true,
        displayName: true,
        active: true,
        wipLimit: true,
        capacityPoints: true,
        costBudgetMicrousd: true,
        budgetWindowStartsAt: true,
        budgetWindowEndsAt: true,
      },
    }),
    prisma.amuxHumanEscalation.findMany({
      where: { status: { in: ["open", "acknowledged"] } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: 100,
      select: {
        id: true,
        specialty: true,
        status: true,
        createdAt: true,
        task: {
          select: { id: true, title: true, priority: true, status: true },
        },
      },
    }),
  ]);

  const workerOutcomes = new Map<
    string,
    {
      total: number;
      calibratable: number;
      succeeded: number;
      failed: number;
      blocked: number;
      expired: number;
      settled_latency_ms: number[];
    }
  >();
  for (const attempt of attempts) {
    const current = workerOutcomes.get(attempt.worker) ?? {
      total: 0,
      calibratable: 0,
      succeeded: 0,
      failed: 0,
      blocked: 0,
      expired: 0,
      settled_latency_ms: [],
    };
    current.total += 1;
    if (attempt.endedAt && attempt.outcome !== "expired") {
      current.calibratable += 1;
    }
    if (attempt.outcome === "succeeded") current.succeeded += 1;
    if (attempt.outcome === "failed") current.failed += 1;
    if (attempt.outcome === "blocked") current.blocked += 1;
    if (attempt.outcome === "expired") current.expired += 1;
    if (attempt.endedAt && attempt.outcome !== "expired") {
      current.settled_latency_ms.push(
        Math.max(0, attempt.endedAt.getTime() - attempt.startedAt.getTime()),
      );
    }
    workerOutcomes.set(attempt.worker, current);
  }

  return {
    generated_at: new Date().toISOString(),
    limits: { decisions: 50, attempts: 500 },
    incident: {
      ...parseAmuxIncidentSetting(incidentRow?.value),
      setting_updated_at: incidentRow?.updatedAt.toISOString() ?? null,
    },
    queue: Object.fromEntries(
      queue.map((entry) => [entry.status, entry._count._all]),
    ),
    policies: policies.map((policy) => ({
      ...policy,
      costBudgetMicrousd: policy.costBudgetMicrousd?.toString() ?? null,
      budgetWindowStartsAt: policy.budgetWindowStartsAt?.toISOString() ?? null,
      budgetWindowEndsAt: policy.budgetWindowEndsAt?.toISOString() ?? null,
    })),
    escalations: escalations.map((escalation) => ({
      ...escalation,
      reason_code: publicAmuxEscalationReasonCode(escalation.task.status),
      createdAt: escalation.createdAt.toISOString(),
    })),
    workers: runtimes.map((runtime) => {
      const outcomes = workerOutcomes.get(runtime.workerName) ?? {
        total: 0,
        calibratable: 0,
        succeeded: 0,
        failed: 0,
        blocked: 0,
        expired: 0,
        settled_latency_ms: [],
      };
      const average =
        outcomes.settled_latency_ms.length === 0
          ? null
          : Math.round(
              outcomes.settled_latency_ms.reduce(
                (sum, value) => sum + value,
                0,
              ) / outcomes.settled_latency_ms.length,
            );
      return {
        name: runtime.workerName,
        status: runtime.status,
        dispatch_ready: runtime.dispatchReady,
        generation: runtime.generation,
        heartbeat_at: runtime.heartbeatAt.toISOString(),
        lease_expires_at: runtime.leaseExpiresAt.toISOString(),
        outcomes: {
          total: outcomes.total,
          calibratable_total: outcomes.calibratable,
          succeeded: outcomes.succeeded,
          failed: outcomes.failed,
          blocked: outcomes.blocked,
          expired: outcomes.expired,
          average_latency_ms: average,
        },
      };
    }),
    decisions: decisions.map((decision) => ({
      id: decision.id,
      task: decision.task,
      worker: decision.worker,
      scheduler_score: decision.schedulerScore,
      scoring_version: decision.scoringVersion,
      task_revision: decision.taskRevision,
      created_at: decision.createdAt.toISOString(),
      evidence: summarizeSignals(decision.signals),
    })),
  };
}
