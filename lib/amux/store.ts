import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_SYSTEM_AUDIT_ACTOR,
  type AmuxClaimAuditRefusalReason,
} from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { prisma } from "@/lib/prisma";
import {
  scoreAmuxScheduler,
  type AmuxSchedulerFacts,
  type AmuxSchedulerScore,
} from "@/lib/amux/schedulerScoreCore";
import { lockAmuxAdmissionAndReadIncident } from "@/lib/amux/incident";
import {
  AMUX_INCIDENT_SETTING_KEY,
  parseAmuxIncidentSetting,
} from "@/lib/amux/incidentCore";
import {
  AMUX_GLOBAL_PRIORITY_VERSION,
  type AmuxDeadlineParse,
} from "@/lib/amux/planningCore";
import {
  evaluateLockedAmuxWip,
  lockAmuxResourcePolicies,
} from "@/lib/amux/resourcePolicy";
import {
  amuxCapacityWeight,
  amuxResourceRefs,
} from "@/lib/amux/resourcePolicyCore";

const satisfiedDependencyStatuses = (): string[] => ["done"];
const terminalDependentStatuses = (): string[] => ["done", "cancelled"];
const PRISMA_INT_MAX = 2_147_483_647;

export type AmuxQueueTask = {
  id: string;
  title: string;
  status: string;
  kind: string;
  priority: string;
  pinned: boolean;
  drag: number;
  owner: string | null;
  revision: number;
  created_at: string;
  dependencies: string[];
  dependent_count: number;
  scheduler_score: number;
  scoring_version: typeof AMUX_GLOBAL_PRIORITY_VERSION;
  scheduler_signals: AmuxSchedulerScore;
};

export type AmuxDecisionSignals = {
  pin: number;
  age_hours: number;
  type_weight: number;
  priority_weight: number;
  dependents: number;
  dependent_weight: number;
  drag: number;
};

type SchedulerRow = {
  pinned: boolean;
  createdAt: Date;
  kind: string;
  priority: string;
  drag: number;
  dueAt: Date | null;
  duePrecision: string | null;
  dueSource: string | null;
  dueRaw: string | null;
  projectKey: string | null;
  teamKey: string | null;
  effortPoints: number;
  _count: { dependents: number };
};

type AmuxAuthoritativeSchedulerInput = {
  facts: AmuxSchedulerFacts;
  deadline?: AmuxDeadlineParse;
  capacityWeight: number;
};

const deadlineForRow = (row: SchedulerRow): AmuxDeadlineParse | undefined =>
  row.dueAt &&
  (row.duePrecision === "date" || row.duePrecision === "instant") &&
  (row.dueSource === "classification" ||
    row.dueSource === "title" ||
    row.dueSource === "description")
    ? {
        state: "parsed",
        due_at: row.dueAt.toISOString(),
        source: row.dueSource,
        precision: row.duePrecision,
        raw: row.dueRaw ?? row.dueAt.toISOString(),
      }
    : undefined;

const schedulerInputsForRows = async <T extends SchedulerRow>(
  rows: readonly T[],
) => {
  const projectKeys = [
    ...new Set(rows.flatMap((row) => (row.projectKey ? [row.projectKey] : []))),
  ];
  const teamKeys = [
    ...new Set(rows.flatMap((row) => (row.teamKey ? [row.teamKey] : []))),
  ];
  const [policies, active] = await Promise.all([
    prisma.amuxResourcePolicy.findMany({
      where: {
        active: true,
        capacityPoints: { not: null },
        OR: [
          { scope: "project", key: { in: projectKeys } },
          { scope: "team", key: { in: teamKeys } },
        ],
      },
      select: { scope: true, key: true, capacityPoints: true },
    }),
    prisma.amuxWorkItem.findMany({
      where: {
        archivedAt: null,
        OR: [{ status: "doing" }, { status: "todo", owner: { not: null } }],
        AND: [
          {
            OR: [
              { projectKey: { in: projectKeys } },
              { teamKey: { in: teamKeys } },
            ],
          },
        ],
      },
      select: { projectKey: true, teamKey: true, effortPoints: true },
    }),
  ]);
  const usage = new Map<string, number>();
  for (const task of active) {
    if (task.projectKey) {
      const key = `project:${task.projectKey}`;
      usage.set(key, (usage.get(key) ?? 0) + task.effortPoints);
    }
    if (task.teamKey) {
      const key = `team:${task.teamKey}`;
      usage.set(key, (usage.get(key) ?? 0) + task.effortPoints);
    }
  }
  const policy = new Map<string, number>(
    policies.flatMap((item) =>
      item.capacityPoints === null
        ? []
        : [[`${item.scope}:${item.key}`, item.capacityPoints] as const],
    ),
  );
  return new Map(
    rows.map((row) => {
      const observations = amuxResourceRefs(row).flatMap((ref) => {
        const key = `${ref.scope}:${ref.key}`;
        const capacity = policy.get(key);
        return capacity === undefined
          ? []
          : [{ capacity, used: usage.get(key) ?? 0 }];
      });
      return [
        row,
        {
          facts: {
            pinned: row.pinned,
            createdAt: row.createdAt,
            kind: row.kind,
            priority: row.priority,
            dependentCount: row._count.dependents,
            drag: row.drag,
          },
          deadline: deadlineForRow(row),
          capacityWeight: amuxCapacityWeight(observations),
        } satisfies AmuxAuthoritativeSchedulerInput,
      ] as const;
    }),
  );
};

export type AmuxClaimInput = {
  taskId: string;
  worker: string;
  expectedRevision: number;
  schedulerScore: number;
  scoringVersion: string;
  signals: Prisma.InputJsonValue;
};

export type AmuxClaimOutcome =
  | {
      claimed: true;
      revision: number;
      decisionId: string;
    }
  | {
      claimed: false;
      reason: "cas_lost" | "incident_admission_blocked" | "wip_limit_reached";
    };

type AmuxClaimRefusalContext = {
  taskId?: string;
  worker?: string;
  expectedRevision?: number;
};

const runnableDependencyFilter =
  (): Prisma.AmuxWorkDependencyListRelationFilter => ({
    every: {
      dependency: {
        archivedAt: null,
        status: {
          in: satisfiedDependencyStatuses(),
        },
      },
    },
  });

/**
 * The global scheduler needs the complete runnable population.
 *
 * Do not introduce a "top N" database cut here: ranking before truncation would
 * make a lower-priority row invisible to starvation ageing and dependent-count
 * scoring. The caller ranks the whole returned set deterministically.
 */
export async function listDispatchable(): Promise<AmuxQueueTask[]> {
  const incidentRow = await prisma.appSetting.findUnique({
    where: { key: AMUX_INCIDENT_SETTING_KEY },
    select: { value: true },
  });
  if (parseAmuxIncidentSetting(incidentRow?.value).blocks_admission) return [];

  const rows = await prisma.amuxWorkItem.findMany({
    where: {
      status: "todo",
      owner: null,
      archivedAt: null,
      dueParseState: { in: ["none", "valid"] },
      dependencies: runnableDependencyFilter(),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: {
      id: true,
      title: true,
      status: true,
      kind: true,
      priority: true,
      pinned: true,
      drag: true,
      owner: true,
      revision: true,
      createdAt: true,
      dueAt: true,
      duePrecision: true,
      dueSource: true,
      dueRaw: true,
      projectKey: true,
      teamKey: true,
      effortPoints: true,
      dependencies: {
        select: {
          dependencyId: true,
        },
        orderBy: {
          dependencyId: "asc",
        },
      },
      _count: {
        select: {
          dependents: {
            where: {
              task: {
                archivedAt: null,
                status: {
                  notIn: terminalDependentStatuses(),
                },
              },
            },
          },
        },
      },
    },
  });

  const schedulerInputs = await schedulerInputsForRows(rows);
  const observedAt = new Date();

  return rows.map((row) => {
    const input = schedulerInputs.get(row);
    if (!input) throw new Error(`AMUX scheduler inputs missing for ${row.id}`);
    const score = scoreAmuxScheduler({ ...input, now: observedAt });
    return {
      id: row.id,
      title: row.title,
      status: row.status,
      kind: row.kind,
      priority: row.priority,
      pinned: row.pinned,
      drag: row.drag,
      owner: row.owner,
      revision: row.revision,
      created_at: row.createdAt.toISOString(),
      dependencies: row.dependencies.map((edge) => edge.dependencyId),
      dependent_count: row._count.dependents,
      scheduler_score: score.total,
      scoring_version: AMUX_GLOBAL_PRIORITY_VERSION,
      scheduler_signals: score,
    };
  });
}

/**
 * Revalidate one scheduler-selected task before worker routing.
 *
 * This is still a read. The later claim performs the authoritative CAS again.
 */
export async function getRoutingSnapshotTask(
  taskId: string,
  expectedRevision: number,
): Promise<{
  classification: Prisma.JsonValue | null;
  requiredRoutingRole: string | null;
} | null> {
  return prisma.amuxWorkItem.findFirst({
    where: {
      id: taskId,
      status: "todo",
      owner: null,
      archivedAt: null,
      revision: expectedRevision,
      dependencies: runnableDependencyFilter(),
    },
    select: {
      classification: true,
      requiredRoutingRole: true,
    },
  });
}

/**
 * Re-read scheduler inputs from the database immediately before claim.
 *
 * The orchestrator's score is a proposal. This snapshot is the authority
 * persisted with the append-only route decision, matching the worker-router
 * boundary which already replaces caller evidence with server-owned facts.
 */
export async function getAuthoritativeSchedulerFacts(
  taskId: string,
  expectedRevision: number,
): Promise<AmuxAuthoritativeSchedulerInput | null> {
  const row = await prisma.amuxWorkItem.findFirst({
    where: {
      id: taskId,
      status: "todo",
      owner: null,
      archivedAt: null,
      revision: expectedRevision,
      dependencies: runnableDependencyFilter(),
    },
    select: {
      pinned: true,
      createdAt: true,
      kind: true,
      priority: true,
      drag: true,
      dueAt: true,
      duePrecision: true,
      dueSource: true,
      dueRaw: true,
      projectKey: true,
      teamKey: true,
      effortPoints: true,
      _count: {
        select: {
          dependents: {
            where: {
              task: {
                archivedAt: null,
                status: { notIn: terminalDependentStatuses() },
              },
            },
          },
        },
      },
    },
  });
  if (!row) return null;
  return (await schedulerInputsForRows([row])).get(row) ?? null;
}

/**
 * Claim one still-runnable Todo and persist the route decision atomically.
 *
 * No status transition, execution lease, attempt row or external action starts
 * here. A CAS loser creates no AmuxRouteDecision row.
 */
export async function claimUnownedTodo(
  input: AmuxClaimInput,
): Promise<AmuxClaimOutcome> {
  const worker = input.worker.trim();
  const refusalContext = {
    taskId: input.taskId,
    worker,
    expectedRevision: input.expectedRevision,
  };
  if (
    !worker ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= PRISMA_INT_MAX
  ) {
    await recordAmuxClaimRefusal("cas_lost", refusalContext);
    return { claimed: false, reason: "cas_lost" };
  }

  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.claim, async (tx, context) => {
    const incident = await lockAmuxAdmissionAndReadIncident(tx, context.dbNow);
    if (incident.blocks_admission) {
      await writeAmuxClaimRefusalAudit(
        tx,
        "incident_admission_blocked",
        refusalContext,
        {
          incident_state: incident.state.state,
          incident_transition_id: incident.state.transition_id,
          incident_valid: incident.valid,
        },
      );
      return {
        claimed: false as const,
        reason: "incident_admission_blocked" as const,
      };
    }

    const planning = await tx.amuxWorkItem.findFirst({
      where: {
        id: input.taskId,
        status: "todo",
        owner: null,
        archivedAt: null,
        revision: input.expectedRevision,
        dueParseState: { in: ["none", "valid"] },
        dependencies: runnableDependencyFilter(),
      },
      select: { projectKey: true, teamKey: true },
    });
    if (!planning) {
      await writeAmuxClaimRefusalAudit(tx, "cas_lost", refusalContext);
      return { claimed: false as const, reason: "cas_lost" as const };
    }
    const policies = await lockAmuxResourcePolicies(
      tx,
      amuxResourceRefs(planning),
    );
    const wip = await evaluateLockedAmuxWip(tx, policies);
    if (!wip.allowed) {
      await writeAmuxClaimRefusalAudit(
        tx,
        "wip_limit_reached",
        refusalContext,
        {
          blocked_resource: wip.blocked_resource,
          wip: wip.evidence,
        },
      );
      return {
        claimed: false as const,
        reason: "wip_limit_reached" as const,
      };
    }

    const claim = await tx.amuxWorkItem.updateMany({
      where: {
        id: input.taskId,
        status: "todo",
        owner: null,
        archivedAt: null,
        revision: input.expectedRevision,
        projectKey: planning.projectKey,
        teamKey: planning.teamKey,
        dueParseState: { in: ["none", "valid"] },
        dependencies: runnableDependencyFilter(),
      },
      data: {
        owner: worker,
        claimedAt: context.dbNow,
        revision: {
          increment: 1,
        },
      },
    });

    if (claim.count !== 1) {
      await writeAmuxClaimRefusalAudit(tx, "cas_lost", refusalContext);
      return { claimed: false as const, reason: "cas_lost" as const };
    }

    const decision = await tx.amuxRouteDecision.create({
      select: {
        id: true,
      },
      data: {
        taskId: input.taskId,
        worker,
        schedulerScore: input.schedulerScore,
        scoringVersion: input.scoringVersion,
        taskRevision: input.expectedRevision,
        signals: {
          ...(input.signals as Prisma.InputJsonObject),
          admission: {
            incident: {
              state: incident.state.state,
              transition_id: incident.state.transition_id,
              valid: incident.valid,
            },
            wip: wip.evidence,
          },
        },
      },
    });

    const revision = input.expectedRevision + 1;

    await writeSystemAuditLog({
      systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: "amux.claim.assigned",
      targetType: "AmuxWorkItem",
      targetId: input.taskId,
      summary: `Claimed AMUX work item ${input.taskId} for ${worker}.`,
      metadata: {
        decision_id: decision.id,
        worker,
        prior_task_revision: input.expectedRevision,
        task_revision: revision,
        scheduler_score: input.schedulerScore,
        scoring_version: input.scoringVersion,
        measured: true,
        verdict: "claimed",
      },
      tx,
    });

    return {
      claimed: true as const,
      revision,
      decisionId: decision.id,
    };
  });
}

/** Record an authenticated claim refusal without retaining request text. */
export async function recordAmuxClaimRefusal(
  reason: AmuxClaimAuditRefusalReason,
  context: AmuxClaimRefusalContext = {},
): Promise<void> {
  await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.claimRefusal, async (tx) => {
    await writeAmuxClaimRefusalAudit(tx, reason, context);
  });
}

async function writeAmuxClaimRefusalAudit(
  tx: Prisma.TransactionClient,
  reason: AmuxClaimAuditRefusalReason,
  context: AmuxClaimRefusalContext,
  evidence: Record<string, unknown> = {},
): Promise<void> {
  const taskId = context.taskId?.trim() || null;
  const worker = context.worker?.trim() || null;

  await writeSystemAuditLog({
    systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.claim.refused",
    targetType: taskId ? "AmuxWorkItem" : "AmuxClaimRequest",
    targetId: taskId,
    summary: "Refused an authenticated AMUX claim request.",
    metadata: {
      ...evidence,
      reason,
      ...(worker ? { worker } : {}),
      ...(context.expectedRevision === undefined
        ? {}
        : { expected_revision: context.expectedRevision }),
      measured: true,
      verdict: "refused",
    },
    tx,
  });
}

export type AmuxOwnedTodo = {
  id: string;
  title: string;
  description: string | null;
  kind: string;
  priority: string;
  owner: string;
  revision: number;
  claimed_at: string | null;
  created_at: string;
};

/**
 * Durable handoff queue between routing ownership and execution.
 *
 * Ownership is not execution: these rows remain Todo until the board driver
 * proves the selected worker is live, at a safe boundary, and wins the later
 * execution-start CAS.
 */
export async function listOwnedTodos(): Promise<AmuxOwnedTodo[]> {
  const rows = await prisma.amuxWorkItem.findMany({
    where: {
      status: "todo",
      owner: {
        not: null,
      },
      archivedAt: null,
      dependencies: runnableDependencyFilter(),
    },
    orderBy: [
      {
        claimedAt: "asc",
      },
      {
        createdAt: "asc",
      },
      {
        id: "asc",
      },
    ],
    select: {
      id: true,
      title: true,
      description: true,
      kind: true,
      priority: true,
      owner: true,
      revision: true,
      claimedAt: true,
      createdAt: true,
    },
  });

  return rows.flatMap((row) =>
    row.owner
      ? [
          {
            id: row.id,
            title: row.title,
            description: row.description,
            kind: row.kind,
            priority: row.priority,
            owner: row.owner,
            revision: row.revision,
            claimed_at: row.claimedAt?.toISOString() ?? null,
            created_at: row.createdAt.toISOString(),
          },
        ]
      : [],
  );
}
