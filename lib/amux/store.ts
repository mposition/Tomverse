import "server-only";

import type { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";

const satisfiedDependencyStatuses = (): string[] => ["done"];
const terminalDependentStatuses = (): string[] => ["done", "cancelled"];

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
  const rows = await prisma.amuxWorkItem.findMany({
    where: {
      status: "todo",
      owner: null,
      archivedAt: null,
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

  return rows.map((row) => ({
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
): Promise<{ classification: Prisma.JsonValue | null } | null> {
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
    },
  });
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
  if (!worker) return null;

  return prisma.$transaction(async (tx) => {
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
        claimedAt: new Date(),
        revision: {
          increment: 1,
        },
      },
    });

    if (claim.count !== 1) {
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

    return {
      revision: input.expectedRevision + 1,
      decisionId: decision.id,
    };
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
            claimed_at:
              row.claimedAt?.toISOString() ?? null,
            created_at: row.createdAt.toISOString(),
          },
        ]
      : [],
  );
}
