import "server-only";

import { createHash } from "node:crypto";

import {
  AMUX_INCIDENT_SETTING_KEY,
  parseAmuxIncidentSetting,
} from "@/lib/amux/incidentCore";
import { amuxStagingEvidenceDigests } from "@/lib/amux/stagingEvidenceCore";
import { prisma } from "@/lib/prisma";

const SHA_PATTERN = /^[0-9a-f]{40}$/i;
const opaqueEvidenceKey = (value: string) =>
  createHash("sha256").update(value).digest("hex").slice(0, 16);

export async function captureAmuxStagingEvidence(
  expectedDeploySha: string,
  now = new Date(),
) {
  const deploymentRevision =
    process.env.RAILWAY_GIT_COMMIT_SHA ??
    process.env.VERCEL_GIT_COMMIT_SHA ??
    null;
  if (!SHA_PATTERN.test(expectedDeploySha)) {
    throw new Error("Expected deployment SHA must be a full 40-character SHA.");
  }
  if (!deploymentRevision || !SHA_PATTERN.test(deploymentRevision)) {
    throw new Error(
      "The capture process did not expose a valid Railway or Vercel commit SHA.",
    );
  }
  if (deploymentRevision.toLowerCase() !== expectedDeploySha.toLowerCase()) {
    throw new Error("The expected SHA does not match the capture process SHA.");
  }

  const [
    incidentRow,
    tasks,
    decisions,
    attempts,
    deliveries,
    policies,
    quota,
    escalations,
    cost,
  ] = await Promise.all([
    prisma.appSetting.findUnique({
      where: { key: AMUX_INCIDENT_SETTING_KEY },
      select: { value: true, updatedAt: true },
    }),
    prisma.amuxWorkItem.groupBy({
      by: ["status", "dueParseState"],
      _count: { _all: true },
    }),
    prisma.amuxRouteDecision.groupBy({
      by: ["scoringVersion"],
      _count: { _all: true },
    }),
    prisma.amuxExecutionAttempt.groupBy({
      by: ["outcome", "costConfirmed"],
      _count: { _all: true },
    }),
    prisma.amuxWorkDelivery.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.amuxResourcePolicy.findMany({
      orderBy: [{ scope: "asc" }, { key: "asc" }],
      select: {
        scope: true,
        key: true,
        active: true,
        wipLimit: true,
        capacityPoints: true,
        costBudgetMicrousd: true,
        budgetWindowStartsAt: true,
        budgetWindowEndsAt: true,
        updatedAt: true,
      },
    }),
    prisma.$queryRaw<
      Array<{
        worker: string;
        provider: string;
        remainingBasisPoints: number;
        confidenceBasisPoints: number;
        exhausted: boolean;
        source: string;
        observedAt: Date;
        resetAt: Date | null;
      }>
    >`
      SELECT DISTINCT ON (observation."worker")
        observation."worker",
        observation."provider",
        observation."remainingBasisPoints",
        observation."confidenceBasisPoints",
        observation."exhausted",
        observation."source",
        observation."observedAt",
        observation."resetAt"
      FROM "AmuxQuotaObservation" AS observation
      ORDER BY
        observation."worker" ASC,
        observation."observedAt" DESC,
        observation."createdAt" DESC,
        observation."id" DESC
    `,
    prisma.amuxHumanEscalation.groupBy({
      by: ["status", "specialty"],
      _count: { _all: true },
    }),
    prisma.amuxCostLedgerEntry.groupBy({
      by: [
        "scope",
        "resourceKey",
        "budgetWindowStartsAt",
        "budgetWindowEndsAt",
        "kind",
      ],
      _count: { _all: true },
      _sum: { amountMicrousd: true },
    }),
  ]);

  const incident = parseAmuxIncidentSetting(incidentRow?.value, now);
  const observation = {
    schema_version: "amux-staging-evidence-v1",
    evidence_scope: "observed_facts_only",
    generated_at: now.toISOString(),
    deployment_revision: deploymentRevision.toLowerCase(),
    capture_process_revision_matches_expected: true,
    human_judgement: {
      result: null,
      signature: null,
      note: "This capture does not approve, freeze or sign a staging result.",
    },
    incident: {
      valid: incident.valid,
      blocks_admission: incident.blocks_admission,
      problem: incident.problem,
      state: incident.state,
      setting_updated_at: incidentRow?.updatedAt.toISOString() ?? null,
    },
    tasks: tasks
      .map((row) => ({
        status: row.status,
        due_parse_state: row.dueParseState,
        count: row._count._all,
      }))
      .sort((left, right) =>
        `${left.status}:${left.due_parse_state}`.localeCompare(
          `${right.status}:${right.due_parse_state}`,
        ),
      ),
    route_decisions: decisions
      .map((row) => ({
        scoring_version: row.scoringVersion,
        count: row._count._all,
      }))
      .sort((left, right) =>
        left.scoring_version.localeCompare(right.scoring_version),
      ),
    execution_attempts: attempts
      .map((row) => ({
        outcome: row.outcome,
        cost_confirmed: row.costConfirmed,
        count: row._count._all,
      }))
      .sort((left, right) =>
        `${left.outcome ?? ""}:${left.cost_confirmed}`.localeCompare(
          `${right.outcome ?? ""}:${right.cost_confirmed}`,
        ),
      ),
    deliveries: deliveries
      .map((row) => ({
        status: row.status,
        count: row._count._all,
      }))
      .sort((left, right) => left.status.localeCompare(right.status)),
    resource_policies: policies.map((policy) => ({
      scope: policy.scope,
      key_fingerprint: opaqueEvidenceKey(policy.key),
      active: policy.active,
      wipLimit: policy.wipLimit,
      capacityPoints: policy.capacityPoints,
      costBudgetMicrousd: policy.costBudgetMicrousd?.toString() ?? null,
      budgetWindowStartsAt: policy.budgetWindowStartsAt?.toISOString() ?? null,
      budgetWindowEndsAt: policy.budgetWindowEndsAt?.toISOString() ?? null,
      updatedAt: policy.updatedAt.toISOString(),
    })),
    latest_quota_by_worker: quota
      .map((row) => ({
        worker: row.worker,
        provider: row.provider,
        remaining_basis_points: row.remainingBasisPoints,
        confidence_basis_points: row.confidenceBasisPoints,
        exhausted: row.exhausted,
        source: row.source,
        observed_at: row.observedAt.toISOString(),
        age_seconds: Math.max(
          0,
          Math.floor((now.getTime() - row.observedAt.getTime()) / 1_000),
        ),
        reset_at: row.resetAt?.toISOString() ?? null,
      }))
      .sort((left, right) => left.worker.localeCompare(right.worker)),
    human_escalations: escalations
      .map((row) => ({
        status: row.status,
        specialty: row.specialty,
        count: row._count._all,
      }))
      .sort((left, right) =>
        `${left.status}:${left.specialty ?? ""}`.localeCompare(
          `${right.status}:${right.specialty ?? ""}`,
        ),
      ),
    cost_ledger: cost
      .map((row) => ({
        scope: row.scope,
        resource_key_fingerprint: opaqueEvidenceKey(row.resourceKey),
        budget_window_starts_at: row.budgetWindowStartsAt.toISOString(),
        budget_window_ends_at: row.budgetWindowEndsAt.toISOString(),
        kind: row.kind,
        entries: row._count._all,
        amount_microusd: (row._sum.amountMicrousd ?? BigInt(0)).toString(),
      }))
      .sort((left, right) =>
        `${left.scope}:${left.resource_key_fingerprint}:${left.budget_window_starts_at}:${left.kind}`.localeCompare(
          `${right.scope}:${right.resource_key_fingerprint}:${right.budget_window_starts_at}:${right.kind}`,
        ),
      ),
  };
  return {
    ...observation,
    ...amuxStagingEvidenceDigests(observation),
  };
}
