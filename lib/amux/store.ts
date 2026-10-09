import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_SYSTEM_AUDIT_ACTOR,
  type AmuxClaimAuditRefusalReason,
} from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { AMUX_V22_TASK_EXECUTION_ENV,
  amuxV22TaskExecutionEnabled } from "@/lib/amux/v22TaskExecutionCore";
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

export const AMUX_QUEUE_MAX_ITEMS = 512;
export const AMUX_OWNED_QUEUE_MAX_ITEMS = 512;
export const PRISMA_INT_MAX = 2_147_483_647;

export class AmuxQueueCapacityError extends Error {
  readonly code = "AMUX_QUEUE_CAPACITY_EXCEEDED";

  constructor(readonly queue: "selection" | "owned") {
    super(`AMUX ${queue} queue exceeds the complete-response item ceiling`);
    this.name = "AmuxQueueCapacityError";
  }
}

const satisfiedDependencyStatuses = (): string[] => ["done"];
const nonScoringDependentStatuses = (): string[] => [
  "backlog",
  "done",
  "cancelled",
];

/**
 * The selection queue row.
 *
 * `title`, `status` and `dependencies` are a compatibility window, not
 * selection input (docs/ops/amux/wsl-execution-bridge.md, "Wire
 * compatibility"). An orchestrator built from main before the develop AMUX
 * port requires them (non-Option fields of its QueueTask) and fails to parse a
 * queue without them; the Rust built from this tree accepts the row with or
 * without them. main also sent `owner`, always null; that Rust reads it as an
 * Option, so a missing key is None and it is not sent. Removing the rest is its
 * own change, made once no such orchestrator runs.
 */
export type AmuxQueueTask = {
  id: string;
  title: string;
  status: "todo";
  kind: string;
  priority: string;
  pinned: boolean;
  drag: number;
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
  db: Prisma.TransactionClient | typeof prisma = prisma,
) => {
  const projectKeys = [
    ...new Set(rows.flatMap((row) => (row.projectKey ? [row.projectKey] : []))),
  ];
  const teamKeys = [
    ...new Set(rows.flatMap((row) => (row.teamKey ? [row.teamKey] : []))),
  ];
  const [policies, active] = await Promise.all([
    db.amuxResourcePolicy.findMany({
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
    db.amuxWorkItem.findMany({
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
      reason:
        | "cas_lost"
        | "incident_admission_blocked"
        | "wip_limit_reached"
        | "execution_lifecycle_unavailable";
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

// A12 creates unassigned v4 Task Todo rows, but A13 has not made their
// role/grade-based worker claim safe yet. Keep them out of every legacy
// dispatch read and claim CAS; nullable legacy sourceSystem must still pass.
const legacyDispatchSourceFilter = (): Prisma.AmuxWorkItemWhereInput => ({
  OR: [{ sourceSystem: null },
    { sourceSystem: { not: "admin-idea-v4" } }],
});

/**
 * The global scheduler needs the complete runnable population.
 *
 * Do not introduce a "top N" database cut here: ranking before truncation would
 * make a lower-priority row invisible to starvation ageing and dependent-count
 * scoring. The caller ranks the whole returned set deterministically.
 */
export async function listDispatchable(): Promise<AmuxQueueTask[]> {
  return withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.queueRead,
    async (tx, { dbNow }) => {
      const incidentRow = await tx.appSetting.findUnique({
        where: { key: AMUX_INCIDENT_SETTING_KEY },
        select: { value: true },
      });
      if (parseAmuxIncidentSetting(incidentRow?.value).blocks_admission) {
        return [];
      }

      const rows = await tx.amuxWorkItem.findMany({
        where: {
          status: "todo",
          ...legacyDispatchSourceFilter(),
          owner: null,
          archivedAt: null,
          dueParseState: { in: ["none", "valid"] },
          dependencies: runnableDependencyFilter(),
        },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: {
          id: true,
          title: true,
          kind: true,
          priority: true,
          pinned: true,
          drag: true,
          revision: true,
          createdAt: true,
          dependencies: {
            select: { dependencyId: true },
            orderBy: { dependencyId: "asc" },
          },
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
                    status: {
                      notIn: nonScoringDependentStatuses(),
                    },
                  },
                },
              },
            },
          },
        },
        take: AMUX_QUEUE_MAX_ITEMS + 1,
      });

      if (rows.length > AMUX_QUEUE_MAX_ITEMS) {
        throw new AmuxQueueCapacityError("selection");
      }

      const schedulerInputs = await schedulerInputsForRows(rows, tx);

      return rows.map((row) => {
        const input = schedulerInputs.get(row);
        if (!input) {
          throw new Error(`AMUX scheduler inputs missing for ${row.id}`);
        }
        const score = scoreAmuxScheduler({ ...input, now: dbNow });
        return {
          id: row.id,
          title: row.title,
          status: "todo" as const,
          kind: row.kind,
          priority: row.priority,
          pinned: row.pinned,
          drag: row.drag,
          revision: row.revision,
          created_at: row.createdAt.toISOString(),
          dependencies: row.dependencies.map((edge) => edge.dependencyId),
          dependent_count: row._count.dependents,
          scheduler_score: score.total,
          scoring_version: AMUX_GLOBAL_PRIORITY_VERSION,
          scheduler_signals: score,
        };
      });
    },
  );
}

/**
 * Revalidate one scheduler-selected task before worker routing.
 *
 * This is still a read. The later claim performs the authoritative CAS again.
 */
export async function getRoutingSnapshotTask(
  taskId: string,
  expectedRevision: number,
  transaction?: Prisma.TransactionClient,
): Promise<{
  classification: Prisma.JsonValue | null;
  requiredRoutingRole: string | null;
} | null> {
  const read = (tx: Prisma.TransactionClient) =>
    tx.amuxWorkItem.findFirst({
      where: {
        id: taskId,
        status: "todo",
        ...legacyDispatchSourceFilter(),
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
  return transaction
    ? read(transaction)
    : withAmuxDbBoundary(AMUX_DB_BOUNDARIES.routingTaskRead, read);
}

/**
 * Workers that already own an open (todo or doing) card. The router treats
 * them as not dispatch-ready, so one tick hands the next card to another
 * worker instead of re-selecting one the claim would refuse.
 */
export async function amuxWorkersOwningOpenCards(
  workerNames: string[],
  client: Prisma.TransactionClient = prisma,
): Promise<Set<string>> {
  if (workerNames.length === 0) return new Set();
  const rows = await client.amuxWorkItem.findMany({
    where: {
      owner: { in: workerNames },
      archivedAt: null,
      status: { in: ["todo", "doing"] },
    },
    select: { owner: true },
    distinct: ["owner"],
  });
  return new Set(rows.flatMap((row) => (row.owner ? [row.owner] : [])));
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
  transaction?: Prisma.TransactionClient,
): Promise<AmuxAuthoritativeSchedulerInput | null> {
  const read = async (tx: Prisma.TransactionClient) => {
    const row = await tx.amuxWorkItem.findFirst({
      where: {
        id: taskId,
        status: "todo",
        ...legacyDispatchSourceFilter(),
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
                  status: { notIn: nonScoringDependentStatuses() },
                },
              },
            },
          },
        },
      },
    });
    if (!row) return null;
    return (await schedulerInputsForRows([row], tx)).get(row) ?? null;
  };
  return transaction
    ? read(transaction)
    : withAmuxDbBoundary(AMUX_DB_BOUNDARIES.routingTaskRead, read);
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
      // The incident that blocked admission, as main recorded it (#1595).
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
        ...legacyDispatchSourceFilter(),
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
      // The resource that was full and the counts read under its lock, as
      // main recorded them (#1595).
      await writeAmuxClaimRefusalAudit(tx, "wip_limit_reached", refusalContext, {
        blocked_resource: wip.blocked_resource,
        wip: wip.evidence,
      });
      return {
        claimed: false as const,
        reason: "wip_limit_reached" as const,
      };
    }

    // A worker takes one card at a time: a runner drives at most one owned
    // task per worker per tick, and the runtime stays idle and dispatch-ready
    // between a claim and its execution start. Without this, one ready worker
    // collected every runnable card within seconds (seen on the first
    // claim-only run on 2026-09-29) and the extras sat owned until their
    // reservation expired. The admission lock above serialises claims, so the
    // count cannot race another claim for the same worker.
    const ownedOpen = await tx.amuxWorkItem.count({
      where: {
        owner: worker,
        archivedAt: null,
        status: { in: ["todo", "doing"] },
      },
    });
    if (ownedOpen > 0) {
      await writeAmuxClaimRefusalAudit(
        tx,
        "execution_lifecycle_unavailable",
        refusalContext,
        { owned_open_cards: ownedOpen },
      );
      return {
        claimed: false as const,
        reason: "execution_lifecycle_unavailable" as const,
      };
    }

    const claim = await tx.amuxWorkItem.updateMany({
      where: {
        id: input.taskId,
        status: "todo",
        ...legacyDispatchSourceFilter(),
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

    // Orchestration policy version 20, section 4: the owner and revision
    // change and the claim decision, as receipts of an admitted claim. The
    // refusal and CAS-loss paths above change nothing and record none.
    context.recordReceipt("work_item", input.taskId, 1);
    context.recordReceipt("claim_decision", decision.id, 1);

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

/**
 * Record an authenticated system refusal without retaining the request body.
 */
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

/**
 * The owned queue row.
 *
 * Only `id`, `owner` and `revision` are execution input. `title`, `kind`,
 * `priority` and `created_at` are kept for a compatibility window
 * (docs/ops/amux/wsl-execution-bridge.md, "Wire compatibility"): a WSL bridge
 * built from main before the develop AMUX port requires them (non-Option
 * fields of its OwnedTodoTask) and halts on a body without them. main also
 * sent `description` and `claimed_at`; that bridge reads both as Options and
 * uses neither, so they are not sent. A description is free text of up to
 * 50,000 characters, and a few of them would reach the 512 KB response
 * ceiling that main never had. The Rust built from this tree accepts the row
 * with or without the compatibility fields and reads none of them. Removing
 * them is its own change, made once no such bridge runs.
 */
export type AmuxOwnedTodo = {
  id: string;
  title: string;
  kind: string;
  priority: string;
  owner: string;
  revision: number;
  created_at: string;
  assignment_id?: string;
};

/**
 * Durable handoff queue between routing ownership and execution.
 *
 * Ownership is not execution: these rows remain Todo until the board driver
 * proves the selected worker is live, at a safe boundary, and wins the later
 * execution-start CAS.
 */
export async function listOwnedTodos(): Promise<AmuxOwnedTodo[]> {
  const rows = await withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.ownedQueueRead,
    (tx) =>
      tx.amuxWorkItem.findMany({
        where: {
          status: "todo",
          owner: {
            not: null,
          },
          ...(!amuxV22TaskExecutionEnabled(
            process.env[AMUX_V22_TASK_EXECUTION_ENV])
            ? legacyDispatchSourceFilter() : {}),
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
          kind: true,
          priority: true,
          owner: true,
          revision: true,
          createdAt: true,
          sourceSystem: true,
          v22AssignmentId: true,
        },
        take: AMUX_OWNED_QUEUE_MAX_ITEMS + 1,
      }),
  );

  if (rows.length > AMUX_OWNED_QUEUE_MAX_ITEMS) {
    throw new AmuxQueueCapacityError("owned");
  }

  return rows.flatMap((row) =>
    row.owner
      ? [
          {
            id: row.id,
            title: row.title,
            kind: row.kind,
            priority: row.priority,
            owner: row.owner,
            revision: row.revision,
            created_at: row.createdAt.toISOString(),
            ...(row.sourceSystem === "admin-idea-v4" && row.v22AssignmentId
              ? { assignment_id: row.v22AssignmentId } : {}),
          },
        ]
      : [],
  );
}
