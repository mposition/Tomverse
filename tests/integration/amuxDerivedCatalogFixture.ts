// Orchestration policy version 35, section 3 (stage R2c): once the derived
// assignment catalog's code latch is on, every assignment path reads the
// catalog the registry derives, not TOMVERSE_AMUX_WORKER_CATALOG_JSON. A DB
// test that needs a worker catalog therefore records it the way an owner
// does -- a registry event and a capability event per worker -- and also
// writes the same entries to the catalog variables, so the test sees one
// catalog whichever way the latch is set.
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
import { AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY } from "@/lib/amux/workerDerivedCatalogCore";
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

const LEGACY_ENV = "TOMVERSE_AMUX_WORKER_CATALOG_JSON";
const V22_ENV = "TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON";

const ACTIVE_SEED = new Map(
  AMUX_WORKER_REGISTRY_V31_SEED
    .filter((entry) => entry.desiredState === "active")
    .map((entry) => [entry.workerName, entry.roleCeiling]),
);

/** The registry's provider class is the name's first segment. */
const providerOf = (workerName: string) => workerName.split("-")[0]!;

export const truncateAmuxWorkerRegistry = () =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxWorkerCapabilityEvent", "AmuxWorkerRegistryEvent" RESTART IDENTITY`);

/**
 * The catalog variable's JSON for these workers, as the derived catalog would
 * list them -- including the engineering runner's constant entry, which the
 * derived catalog always carries.
 */
const RUNNER = AMUX_ENGINEERING_RUNNER_CATALOG_ENTRY;
export const amuxFixtureCatalogJson = (workers: readonly AmuxFixtureWorker[]) =>
  JSON.stringify([...workers.map((worker) => ({
    worker_name: worker.worker_name,
    provider: providerOf(worker.worker_name),
    ...(worker.model ? { model: worker.model } : {}),
    routing_roles: worker.routing_roles,
    ...(worker.tool_capabilities ? { tool_capabilities: worker.tool_capabilities } : {}),
  })), {
    worker_name: RUNNER.worker_name,
    provider: RUNNER.provider,
    model: RUNNER.model,
    routing_roles: [...RUNNER.routing_roles],
  }]);

const v22CatalogJson = (workers: readonly AmuxFixtureWorker[]) =>
  JSON.stringify(workers.flatMap((worker) => worker.v22
    ? [{
      worker_name: worker.worker_name,
      provider: "anthropic",
      model: worker.v22.model,
      routing_roles: worker.v22.routing_roles,
      tool_capabilities: worker.v22.tool_capabilities,
    }]
    : []));

/**
 * Registers each worker `active` at its seed ceiling with the given
 * capability, and sets both catalog variables to the same entries. Returns a
 * function that restores the variables and empties the registry again.
 */
export async function seedAmuxWorkerCatalog(workers: readonly AmuxFixtureWorker[]) {
  const saved = { legacy: process.env[LEGACY_ENV], v22: process.env[V22_ENV] };
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
  process.env[LEGACY_ENV] = amuxFixtureCatalogJson(workers);
  process.env[V22_ENV] = v22CatalogJson(workers);
  return async () => {
    for (const [name, value] of [[LEGACY_ENV, saved.legacy], [V22_ENV, saved.v22]] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await truncateAmuxWorkerRegistry();
  };
}
