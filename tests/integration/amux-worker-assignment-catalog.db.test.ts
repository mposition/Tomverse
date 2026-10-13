import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  amuxWorkerCatalogRefusal,
  readAmuxAssignmentCatalogs,
  readAmuxDerivedWorkerCatalog,
} from "@/lib/amux/workerAssignmentCatalog";
import { recordAmuxWorkerCapabilityByOwner } from "@/lib/amux/workerCapabilityStore";
import { recordAmuxWorkerRegistryChangeByOwner } from "@/lib/amux/workerRegistryStore";
import {
  AmuxWorkerRegistrationRefusedError,
  heartbeatAmuxWorkerRuntime,
  registerAmuxWorkerRuntime,
} from "@/lib/amux/workerRuntime";
import { prisma } from "@/lib/prisma";

// Orchestration policy version 35, section 3 (stage R2c), against PostgreSQL
// through the migration history, in the agents lane: the registry, the stop
// latches and the capabilities are read in one statement -- the capability
// read boundary allows setup, one statement and its fence -- and the catalog
// derived from them. The stop latch table refuses every write until R4, so an
// open latch is covered by tests/amuxWorkerAssignmentCatalog.test.mjs.

const requireDedicatedAmuxTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
  const url = new URL(testRaw);
  const schemaName = url.searchParams.get("schema");
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  const usesDedicatedAmuxSchema = schemaName === "tomverse_amux_test";
  const usesCanonicalCiDatabase =
    databaseName === "tomverse_test" &&
    (schemaName === null || schemaName === "public") &&
    (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!usesDedicatedAmuxSchema && !usesCanonicalCiDatabase) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
};
requireDedicatedAmuxTestDatabase();

const RUNTIME_NAMES = ["claude-impl", "codex-impl"];
const truncate = async () => {
  await prisma.amuxWorkerRuntime.deleteMany({ where: { workerName: { in: RUNTIME_NAMES } } });
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxWorkerCapabilityEvent", "AmuxWorkerRegistryEvent" RESTART IDENTITY`);
};

beforeEach(truncate);

after(async () => {
  await truncate();
  await prisma.$disconnect();
});

const owner = (): Session =>
  ({ user: { id: `catalog-owner-${randomUUID()}`, email: "owner@example.test" }, expires: "2099-01-01T00:00:00.000Z" }) as Session;

const register = (session: Session, workerName: string, roleCeiling: string, desiredState: string) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryChange, (tx) =>
    recordAmuxWorkerRegistryChangeByOwner(tx, { session, workerName, roleCeiling, desiredState, expectedRevision: 0 }),
  );

const record = (session: Session, workerName: string, capability: unknown) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityChange, (tx) =>
    recordAmuxWorkerCapabilityByOwner(tx, { session, workerName, expectedRevision: 0, capability }),
  );

const readDerived = () =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityRead, (tx) => readAmuxDerivedWorkerCatalog(tx));

test("with nothing registered, only the engineering runner's constant is derived", async () => {
  const derived = await readDerived();
  assert.deepEqual(derived?.legacy.map((entry) => entry.worker_name), ["engineering-runner"]);
  assert.deepEqual(derived?.v22, []);
});

test("one statement derives the catalog from what the owner recorded", async () => {
  const session = owner();
  await register(session, "claude-impl", "implementation", "active");
  await register(session, "codex-chore", "chore", "active");
  await register(session, "cursor-impl", "implementation", "requested");
  await record(session, "claude-impl", {
    model: null, routingTags: ["implementation"], toolCapabilities: [],
    v22: { model: "claude-opus-5-5", roles: ["implement"], tools: ["repo_write"] },
  });
  await record(session, "codex-chore", { model: null, routingTags: ["chore"], toolCapabilities: [], v22: null });
  await record(session, "cursor-impl", { model: null, routingTags: ["implementation"], toolCapabilities: [], v22: null });

  const derived = await readDerived();
  // Requested workers have a capability but are not assigned.
  assert.deepEqual(derived?.legacy.map((entry) => entry.worker_name), ["claude-impl", "codex-chore", "engineering-runner"]);
  assert.deepEqual(derived?.legacy[0], {
    worker_name: "claude-impl", provider: "claude", model: null, routing_roles: ["implementation"], tool_capabilities: [],
    archived: false, paused: false, isolated: false, blocked: false,
  });
  assert.deepEqual(derived?.v22.map((entry) => [entry.worker_name, entry.provider, entry.model, entry.routing_roles, entry.tool_capabilities]), [
    ["claude-impl", "anthropic", "claude-opus-5-5", ["implement"], ["repo_write"]],
  ]);

  // The assignment reader, latched on, gives the configured shapes in the
  // same single statement.
  const catalogs = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityRead, (tx) => readAmuxAssignmentCatalogs(tx, true));
  assert.equal(catalogs.source, "derived");
  assert.deepEqual(catalogs.workers?.map((worker) => [worker.worker_name, worker.running, worker.dispatch_ready]), [
    ["claude-impl", false, false],
    ["codex-chore", false, false],
    ["engineering-runner", false, false],
  ]);
  assert.deepEqual(catalogs.v22?.map((worker) => worker.worker_name), ["claude-impl"]);
});

test("latched on, registration and heartbeat ask the derived catalog inside their own transaction", async () => {
  const session = owner();
  await register(session, "claude-impl", "implementation", "active");
  await record(session, "claude-impl", { model: null, routingTags: ["implementation"], toolCapabilities: [], v22: null });
  const admit = (name: string) => (tx: Parameters<typeof amuxWorkerCatalogRefusal>[0]) => amuxWorkerCatalogRefusal(tx, name, true);
  const listed = (name: string) => async (tx: Parameters<typeof amuxWorkerCatalogRefusal>[0]) =>
    (await amuxWorkerCatalogRefusal(tx, name, true)) === null;

  // A name the catalog does not list is refused and nothing is written.
  await assert.rejects(
    registerAmuxWorkerRuntime("codex-impl", randomUUID(), undefined, undefined, admit("codex-impl")),
    (error) => error instanceof AmuxWorkerRegistrationRefusedError && error.reason === "worker_not_configured",
  );
  assert.equal(await prisma.amuxWorkerRuntime.count({ where: { workerName: "codex-impl" } }), 0);

  // A listed name registers, and an idle ready heartbeat is dispatch-ready.
  const instanceId = randomUUID();
  const runtime = await registerAmuxWorkerRuntime("claude-impl", instanceId, undefined, undefined, admit("claude-impl"));
  const beat = () => heartbeatAmuxWorkerRuntime({
    workerName: "claude-impl", instanceId, generation: runtime.generation, status: "idle", dispatchReady: true, listed: listed("claude-impl"),
  });
  assert.equal((await beat()).accepted, true);
  assert.equal((await prisma.amuxWorkerRuntime.findUniqueOrThrow({ where: { workerName: "claude-impl" } })).dispatchReady, true);

  // Once it leaves the catalog its heartbeat is still accepted -- a refusal
  // would halt the bridge -- but it is no longer dispatch-ready.
  await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryChange, (tx) =>
    recordAmuxWorkerRegistryChangeByOwner(tx, { session, workerName: "claude-impl", roleCeiling: "implementation", desiredState: "paused", expectedRevision: 1 }),
  );
  assert.equal((await beat()).accepted, true);
  assert.equal((await prisma.amuxWorkerRuntime.findUniqueOrThrow({ where: { workerName: "claude-impl" } })).dispatchReady, false);
});
