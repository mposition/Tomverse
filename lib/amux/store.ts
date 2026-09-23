import "server-only";

import type { Prisma } from "@prisma/client";
import { writeSystemAuditLog } from "@/lib/adminAudit";
import {
  AMUX_SYSTEM_AUDIT_ACTOR,
  type AmuxClaimAuditRefusalReason,
} from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";

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
// Catalog-only backlog rows do not contribute to runnable-task priority.
// A runnable task that explicitly depends on backlog still waits for it to be
// completed; dependency satisfaction is a separate rule.
const nonScoringDependentStatuses = (): string[] => [
  "backlog",
  "done",
  "cancelled",
];

export type AmuxQueueTask = {
  id: string;
  kind: string;
  priority: string;
  pinned: boolean;
  drag: number;
  revision: number;
  created_at: string;
  dependent_count: number;
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

export type AmuxClaimInput = {
  taskId: string;
  worker: string;
  expectedRevision: number;
  schedulerScore: number;
  scoringVersion: string;
  signals: Prisma.InputJsonValue;
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
  const rows = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.queueRead, (tx) =>
    tx.amuxWorkItem.findMany({
      where: {
        status: "todo",
        owner: null,
        archivedAt: null,
        dependencies: runnableDependencyFilter(),
      },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: {
        id: true,
        kind: true,
        priority: true,
        pinned: true,
        drag: true,
        revision: true,
        createdAt: true,
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
    }),
  );

  if (rows.length > AMUX_QUEUE_MAX_ITEMS) {
    throw new AmuxQueueCapacityError("selection");
  }

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    priority: row.priority,
    pinned: row.pinned,
    drag: row.drag,
    revision: row.revision,
    created_at: row.createdAt.toISOString(),
    dependent_count: row._count.dependents,
  }));
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
): Promise<{ classification: Prisma.JsonValue | null } | null> {
  const read = (tx: Prisma.TransactionClient) =>
    tx.amuxWorkItem.findFirst({
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
      },
    });

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
): Promise<{ revision: number; decisionId: string } | null> {
  const worker = input.worker.trim();
  if (
    !worker ||
    input.expectedRevision < 0 ||
    input.expectedRevision >= PRISMA_INT_MAX
  )
    return null;

  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.claim, async (tx, context) => {
    const claim = await tx.amuxWorkItem.updateMany({
      where: {
        id: input.taskId,
        status: "todo",
        owner: null,
        archivedAt: null,
        revision: input.expectedRevision,
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
      await writeAmuxClaimRefusalAudit(tx, "cas_lost", {
        taskId: input.taskId,
        worker,
        expectedRevision: input.expectedRevision,
      });
      return null;
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
        signals: input.signals,
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
      revision,
      decisionId: decision.id,
    };
  });
}

/**
 * Record an authenticated system refusal without parsing or retaining the
 * caller's request body. There is no state mutation to pair with this entry,
 * but the canonical writer still owns the hash-chain transaction.
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
  owner: string;
  revision: number;
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
          owner: true,
          revision: true,
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
            owner: row.owner,
            revision: row.revision,
          },
        ]
      : [],
  );
}
