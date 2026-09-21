import "server-only";

import type { Prisma } from "@prisma/client";
import {
  type AmuxResourceRef,
  type AmuxResourceScope,
} from "@/lib/amux/resourcePolicyCore";

export type LockedAmuxResourcePolicy = {
  scope: string;
  key: string;
  active: boolean;
  wipLimit: number | null;
  capacityPoints: number | null;
  costBudgetMicrousd: bigint | null;
  budgetWindowStartsAt: Date | null;
  budgetWindowEndsAt: Date | null;
};

/**
 * Locks the logical resource even when no policy row exists yet.
 *
 * Admin policy upserts use this helper too, so creating a WIP limit cannot
 * race a claim through a missing-row SELECT FOR UPDATE window.
 */
export async function lockAmuxResourcePolicies(
  tx: Prisma.TransactionClient,
  refs: readonly AmuxResourceRef[],
): Promise<LockedAmuxResourcePolicy[]> {
  const policies: LockedAmuxResourcePolicy[] = [];
  for (const ref of refs) {
    const lockName = `tomverse-amux-resource:${ref.scope}:${ref.key}`;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockName}))`;
    const rows = await tx.$queryRaw<LockedAmuxResourcePolicy[]>`
      SELECT
        "scope",
        "key",
        "active",
        "wipLimit",
        "capacityPoints",
        "costBudgetMicrousd",
        "budgetWindowStartsAt",
        "budgetWindowEndsAt"
      FROM "AmuxResourcePolicy"
      WHERE "scope" = ${ref.scope}
        AND "key" = ${ref.key}
      FOR UPDATE
    `;
    if (rows[0]) policies.push(rows[0]);
  }
  return policies;
}

const resourceTaskWhere = (
  ref: AmuxResourceRef,
): Prisma.AmuxWorkItemWhereInput =>
  ref.scope === "project" ? { projectKey: ref.key } : { teamKey: ref.key };

export type AmuxWipDecision = {
  allowed: boolean;
  blocked_resource: AmuxResourceRef | null;
  evidence: Array<{
    scope: AmuxResourceScope;
    key: string;
    limit: number;
    current: number;
  }>;
};

export async function evaluateLockedAmuxWip(
  tx: Prisma.TransactionClient,
  policies: readonly LockedAmuxResourcePolicy[],
): Promise<AmuxWipDecision> {
  const evidence: AmuxWipDecision["evidence"] = [];
  for (const policy of policies) {
    if (!policy.active || policy.wipLimit === null) continue;
    const ref = { scope: policy.scope as AmuxResourceScope, key: policy.key };
    const current = await tx.amuxWorkItem.count({
      where: {
        ...resourceTaskWhere(ref),
        archivedAt: null,
        OR: [{ status: "doing" }, { status: "todo", owner: { not: null } }],
      },
    });
    evidence.push({
      scope: ref.scope,
      key: ref.key,
      limit: policy.wipLimit,
      current,
    });
    if (current >= policy.wipLimit) {
      return { allowed: false, blocked_resource: ref, evidence };
    }
  }
  return { allowed: true, blocked_resource: null, evidence };
}

export type AmuxCostAdmissionDecision =
  | {
      allowed: true;
      reservations: Array<{
        scope: AmuxResourceScope;
        resourceKey: string;
        amountMicrousd: bigint;
        budgetWindowStartsAt: Date;
        budgetWindowEndsAt: Date;
      }>;
      evidence: Array<{
        scope: AmuxResourceScope;
        key: string;
        budget: bigint;
        used: bigint;
        proposed: bigint;
      }>;
    }
  | {
      allowed: false;
      reason:
        | "cost_estimate_missing"
        | "cost_budget_exhausted"
        | "cost_budget_window_inactive";
      blocked_resource: AmuxResourceRef;
      evidence: Array<{
        scope: AmuxResourceScope;
        key: string;
        budget: bigint;
        used: bigint;
        proposed: bigint;
      }>;
    };

export async function evaluateLockedAmuxCostAdmission(
  tx: Prisma.TransactionClient,
  policies: readonly LockedAmuxResourcePolicy[],
  estimatedCostMicrousd: bigint | null,
  now: Date,
): Promise<AmuxCostAdmissionDecision> {
  const reservations: Extract<
    AmuxCostAdmissionDecision,
    { allowed: true }
  >["reservations"] = [];
  const evidence: Extract<
    AmuxCostAdmissionDecision,
    { allowed: true }
  >["evidence"] = [];

  for (const policy of policies) {
    if (!policy.active || policy.costBudgetMicrousd === null) continue;
    const ref = { scope: policy.scope as AmuxResourceScope, key: policy.key };
    const proposed = estimatedCostMicrousd ?? BigInt(0);
    if (estimatedCostMicrousd === null) {
      return {
        allowed: false,
        reason: "cost_estimate_missing",
        blocked_resource: ref,
        evidence,
      };
    }
    if (
      !policy.budgetWindowStartsAt ||
      !policy.budgetWindowEndsAt ||
      now < policy.budgetWindowStartsAt ||
      now >= policy.budgetWindowEndsAt
    ) {
      return {
        allowed: false,
        reason: "cost_budget_window_inactive",
        blocked_resource: ref,
        evidence,
      };
    }
    const aggregate = await tx.amuxCostLedgerEntry.aggregate({
      where: {
        scope: ref.scope,
        resourceKey: ref.key,
        budgetWindowStartsAt: policy.budgetWindowStartsAt,
        budgetWindowEndsAt: policy.budgetWindowEndsAt,
      },
      _sum: { amountMicrousd: true },
    });
    const used = aggregate._sum.amountMicrousd ?? BigInt(0);
    evidence.push({
      scope: ref.scope,
      key: ref.key,
      budget: policy.costBudgetMicrousd,
      used,
      proposed,
    });
    if (used + proposed > policy.costBudgetMicrousd) {
      return {
        allowed: false,
        reason: "cost_budget_exhausted",
        blocked_resource: ref,
        evidence,
      };
    }
    reservations.push({
      scope: ref.scope,
      resourceKey: ref.key,
      amountMicrousd: proposed,
      budgetWindowStartsAt: policy.budgetWindowStartsAt,
      budgetWindowEndsAt: policy.budgetWindowEndsAt,
    });
  }

  return { allowed: true, reservations, evidence };
}
