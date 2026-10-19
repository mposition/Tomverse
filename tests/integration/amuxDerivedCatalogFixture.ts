// Orchestration policy version 35, section 3: every assignment path reads the
// catalog the registry derives -- since R2c the only one, and since R2e the
// catalog variables are gone. A DB test that needs a worker catalog therefore
// records it the way an owner does: a registry event and a capability event
// per worker. The engineering runner is in the derived catalog as its code
// constant, without a registry entry.
//
// Only the seven catalog workers of version 31's seed may be registered
// `active` without trial evidence (R5), so these are the only names a test
// can use. Each call replaces the whole registry: the two event tables are
// truncated first, as tests/integration/amux-worker-assignment-catalog.db.test.ts
// does. Because the names repeat across tests, an open card an earlier test
// left with one of them would make that worker busy (routing offers a worker
// one open card at a time), so those cards are archived first, and their
// runtimes are removed so no test inherits another's runtime evidence.

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { recordAmuxWorkerCapabilityByOwner } from "@/lib/amux/workerCapabilityStore";
import { AMUX_WORKER_REGISTRY_V31_SEED } from "@/lib/amux/workerRegistryCore";
import { recordAmuxWorkerRegistryChangeByOwner } from "@/lib/amux/workerRegistryStore";
import { prisma } from "@/lib/prisma";

export type AmuxFixtureWorker = {
  worker_name: string;
  model?: string;
  routing_roles: string[];
  tool_capabilities?: string[];
  /** The v22 one-shot profile; the worker must be a Claude worker. */
  v22?: { model: string; routing_roles: string[]; tool_capabilities: string[] };
};

const ACTIVE_SEED = new Map(
  AMUX_WORKER_REGISTRY_V31_SEED
    .filter((entry) => entry.desiredState === "active")
    .map((entry) => [entry.workerName, entry.roleCeiling]),
);

export const truncateAmuxWorkerRegistry = () =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxWorkerCapabilityEvent", "AmuxWorkerRegistryEvent" RESTART IDENTITY`);

/**
 * Registers each worker `active` at its seed ceiling with the given
 * capability. Returns a function that empties the registry again.
 */
export async function seedAmuxWorkerCatalog(workers: readonly AmuxFixtureWorker[]) {
  await truncateAmuxWorkerRegistry();
  await prisma.amuxWorkItem.updateMany({
    where: {
      owner: { in: workers.map((worker) => worker.worker_name) },
      archivedAt: null,
      status: { in: ["todo", "doing"] },
    },
    data: { archivedAt: new Date() },
  });
  await prisma.amuxWorkerRuntime.deleteMany({
    where: { workerName: { in: workers.map((worker) => worker.worker_name) } },
  });
  const session = {
    user: { id: `catalog-owner-${randomUUID()}`, email: "owner@example.test" },
    expires: "2099-01-01T00:00:00.000Z",
  } as Session;
  for (const worker of workers) {
    const roleCeiling = ACTIVE_SEED.get(worker.worker_name);
    if (!roleCeiling) throw new Error(`${worker.worker_name} is not one of the seven seed workers`);
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryChange, (tx) =>
      recordAmuxWorkerRegistryChangeByOwner(tx, {
        session, workerName: worker.worker_name, roleCeiling, desiredState: "active", expectedRevision: 0,
      }));
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityChange, (tx) =>
      recordAmuxWorkerCapabilityByOwner(tx, {
        session,
        workerName: worker.worker_name,
        expectedRevision: 0,
        capability: {
          model: worker.model ?? null,
          routingTags: worker.routing_roles,
          toolCapabilities: worker.tool_capabilities ?? [],
          v22: worker.v22
            ? { model: worker.v22.model, roles: worker.v22.routing_roles, tools: worker.v22.tool_capabilities }
            : null,
        },
      }));
  }
  return async () => {
    await truncateAmuxWorkerRegistry();
  };
}
