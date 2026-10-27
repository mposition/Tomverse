import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { AMUX_WORKER_REGISTRY_V31_SEED } from "@/lib/amux/workerRegistryCore";
import {
  AmuxWorkerRegistryWriteError,
  readAmuxWorkerRegistryOrThrow,
  recordAmuxWorkerRegistryChangeByOwner,
} from "@/lib/amux/workerRegistryStore";
import { prisma } from "@/lib/prisma";

// Orchestration policy version 31, stage R1, against PostgreSQL through the
// migration history (20261012100000_amux_worker_registry, its guard body
// replaced by 20261020200000_amux_worker_registry_direct_activation), in the
// agents lane of the DB integration suite.
//
// What the migration headers say the database enforces: the name grammar and
// class prefix, Cursor and Copilot below contract, the change rule (first
// event requested or active, for any name; activation from requested or
// paused with no trial period, the operator's 2026-10-20 decision; nothing
// after retired; the class never changes; a wider role only while requested), the
// per-worker revision, the person's audit row of the same transaction under
// the right action (a system audit cannot be written for these actions at
// all: writeSystemAuditLog refuses an action its actor does not own), the
// database clock, no update or delete, READ COMMITTED only -- and that the
// three system tables refuse every write until R4 and R5.
// The writer's own statements are counted in
// tests/amuxWorkerRegistryStore.test.mjs.

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
    throw new Error(
      "REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database",
    );
  }
};
requireDedicatedAmuxTestDatabase();

// The table refuses DELETE; TRUNCATE fires no row trigger, so each test
// starts from no event at all.
beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxWorkerRegistryEvent" RESTART IDENTITY`);
});

after(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxWorkerRegistryEvent" RESTART IDENTITY`);
  await prisma.$disconnect();
});

const TARGET = "AmuxWorkerRegistryEvent";

const owner = (id = `worker-owner-${randomUUID()}`): Session =>
  ({ user: { id, email: "owner@example.test" }, expires: "2099-01-01T00:00:00.000Z" }) as Session;

/** A database refusal, found wherever Prisma put the message. */
const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp) => {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, "the database accepted what it must refuse");
  const record = caught as { meta?: unknown; cause?: unknown };
  const text = [String(caught), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" ");
  assert.match(text, pattern);
};

type Row = {
  workerName: string;
  providerClass?: string;
  roleCeiling: string;
  desiredState: string;
  revision: number;
};

type Audit =
  | { kind: "person"; userId: string; action: string; targetId?: string }
  | { kind: "none" };

/** A raw insert, bypassing the store, with the audit the test chooses. */
const insertRaw = (row: Row, audit: Audit, options: { isolation?: Prisma.TransactionIsolationLevel } = {}) =>
  prisma.$transaction(
    async (tx) => {
      const id = randomUUID();
      const actorUserId = audit.kind === "person" ? audit.userId : "nobody";
      let auditLogId: string = randomUUID();
      if (audit.kind === "person") {
        auditLogId = await writeAdminAuditLog({
          tx,
          session: owner(audit.userId),
          action: audit.action,
          targetType: TARGET,
          targetId: audit.targetId ?? id,
          summary: "test",
        });
      }
      await tx.$executeRaw`
        INSERT INTO "AmuxWorkerRegistryEvent"
          ("id", "workerName", "providerClass", "roleCeiling", "desiredState", "revision", "actorUserId", "auditLogId")
        VALUES
          (${id}, ${row.workerName}, ${row.providerClass ?? row.workerName.split("-")[0]}, ${row.roleCeiling},
           ${row.desiredState}, ${row.revision}, ${actorUserId}, ${auditLogId})
      `;
      return id;
    },
    options.isolation ? { isolationLevel: options.isolation } : undefined,
  );

const register = (userId: string, row: Row) =>
  insertRaw(row, { kind: "person", userId, action: row.revision === 1 ? "amux.worker.register" : "amux.worker.change" });

const change = (session: Session, input: { workerName: string; roleCeiling: string; desiredState: string; expectedRevision: number }) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryChange, (tx) =>
    recordAmuxWorkerRegistryChangeByOwner(tx, { session, providerClass: input.workerName.slice(0, input.workerName.indexOf("-")), ...input }),
  );

test("the store registers all thirteen workers of the seed, each under its own audit", async () => {
  const session = owner();
  const auditLogIds: string[] = [];
  for (const entry of AMUX_WORKER_REGISTRY_V31_SEED) {
    const record = await change(session, { ...entry, expectedRevision: 0 });
    assert.equal(record.action, "amux.worker.register");
    assert.equal(record.revision, 1);
    auditLogIds.push(record.auditLogId);
  }
  const view = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) => readAmuxWorkerRegistryOrThrow(tx));
  assert.ok(view.registrations);
  assert.deepEqual(
    view.registrations.map((row) => [row.workerName, row.desiredState, row.roleCeiling]),
    [...AMUX_WORKER_REGISTRY_V31_SEED]
      .sort((a, b) => a.workerName.localeCompare(b.workerName))
      .map((entry) => [entry.workerName, entry.desiredState, entry.roleCeiling]),
  );
  assert.equal(view.latches.size, 0);
  assert.equal(view.observations.size, 0);
  // The audit log is not reset between runs; count this run's rows.
  const audits = await prisma.adminAuditLog.count({
    where: { id: { in: auditLogIds }, targetType: TARGET, action: "amux.worker.register", actorUserId: session.user.id },
  });
  assert.equal(audits, 13);
});

test("a later change is the next revision; a stale revision is refused before anything is written", async () => {
  const session = owner();
  await change(session, { workerName: "claude-impl", roleCeiling: "implementation", desiredState: "active", expectedRevision: 0 });
  const paused = await change(session, { workerName: "claude-impl", roleCeiling: "chore", desiredState: "paused", expectedRevision: 1 });
  assert.equal(paused.action, "amux.worker.change");
  assert.equal(paused.revision, 2);
  const before = await prisma.adminAuditLog.count({ where: { targetType: TARGET } });
  await assert.rejects(
    change(session, { workerName: "claude-impl", roleCeiling: "chore", desiredState: "retired", expectedRevision: 1 }),
    (error) => error instanceof AmuxWorkerRegistryWriteError && error.code === "stale_revision",
  );
  assert.equal(await prisma.adminAuditLog.count({ where: { targetType: TARGET } }), before);
});

test("the CHECKs refuse a name, class or role outside version 31", async () => {
  const userId = `owner-${randomUUID()}`;
  // Owner decision 2026-10-27 (migration 20261027100000): a name is free and
  // does not name the CLI; the engineering runner's name is still refused.
  await rejectsWith(register(userId, { workerName: "Devin_worker", providerClass: "claude", roleCeiling: "chore", desiredState: "requested", revision: 1 }), /worker_name_check/);
  await rejectsWith(register(userId, { workerName: "engineering-runner", providerClass: "claude", roleCeiling: "chore", desiredState: "requested", revision: 1 }), /worker_name_check/);
  await rejectsWith(register(userId, { workerName: "kimi-x", providerClass: "devin", roleCeiling: "chore", desiredState: "requested", revision: 1 }), /provider_class_check/);
  await register(userId, { workerName: "kimi-x", providerClass: "copilot", roleCeiling: "chore", desiredState: "requested", revision: 1 });
  await register(userId, { workerName: "claude-x", providerClass: "codex", roleCeiling: "chore", desiredState: "requested", revision: 1 });
  // The guard still keeps a name on the class it was registered with.
  await rejectsWith(register(userId, { workerName: "kimi-x", providerClass: "codex", roleCeiling: "chore", desiredState: "active", revision: 2 }), /AMUX_WORKER_REGISTRY_CLASS_CHANGED/);
  await rejectsWith(register(userId, { workerName: "cursor-x", roleCeiling: "contract", desiredState: "requested", revision: 1 }), /class_ceiling_check/);
  await rejectsWith(register(userId, { workerName: "codex-y", roleCeiling: "review", desiredState: "requested", revision: 1 }), /role_ceiling_check/);
  // A first event outside the change rule is the guard's refusal (a BEFORE
  // trigger runs before the CHECKs); a later one reaches the CHECK itself.
  await rejectsWith(register(userId, { workerName: "codex-x", roleCeiling: "chore", desiredState: "autonomous", revision: 1 }), /AMUX_WORKER_REGISTRY_FIRST_STATE/);
  await register(userId, { workerName: "codex-x", roleCeiling: "chore", desiredState: "requested", revision: 1 });
  await rejectsWith(register(userId, { workerName: "codex-x", roleCeiling: "chore", desiredState: "autonomous", revision: 2 }), /desired_state_check/);
});

test("the guard holds the change rule the core holds", async () => {
  const userId = `owner-${randomUUID()}`;
  // First event: requested or active, whatever the name; never paused or retired.
  await rejectsWith(register(userId, { workerName: "claude-new", roleCeiling: "chore", desiredState: "paused", revision: 1 }), /AMUX_WORKER_REGISTRY_FIRST_STATE/);
  await rejectsWith(register(userId, { workerName: "claude-new", roleCeiling: "chore", desiredState: "retired", revision: 1 }), /AMUX_WORKER_REGISTRY_FIRST_STATE/);
  await rejectsWith(register(userId, { workerName: "claude-new", roleCeiling: "chore", desiredState: "requested", revision: 2 }), /AMUX_WORKER_REGISTRY_STALE_REVISION/);
  await register(userId, { workerName: "claude-new", roleCeiling: "chore", desiredState: "requested", revision: 1 });
  await register(userId, { workerName: "codex-impl", roleCeiling: "implementation", desiredState: "active", revision: 1 });
  // A worker outside the catalog's seven may start active (no trial period).
  await register(userId, { workerName: "cursor-new", roleCeiling: "implementation", desiredState: "active", revision: 1 });
  // A wider role only while requested: an activation cannot widen it.
  await rejectsWith(register(userId, { workerName: "codex-impl", roleCeiling: "contract", desiredState: "active", revision: 2 }), /AMUX_WORKER_REGISTRY_ROLE_WIDENING/);
  await rejectsWith(register(userId, { workerName: "claude-new", roleCeiling: "implementation", desiredState: "active", revision: 2 }), /AMUX_WORKER_REGISTRY_ROLE_WIDENING/);
  await register(userId, { workerName: "claude-new", roleCeiling: "contract", desiredState: "requested", revision: 2 });
  // requested -> active.
  await register(userId, { workerName: "claude-new", roleCeiling: "contract", desiredState: "active", revision: 3 });
  // The revision is the previous plus one.
  await rejectsWith(register(userId, { workerName: "codex-impl", roleCeiling: "chore", desiredState: "paused", revision: 3 }), /AMUX_WORKER_REGISTRY_STALE_REVISION/);
  await register(userId, { workerName: "codex-impl", roleCeiling: "chore", desiredState: "paused", revision: 2 });
  // paused -> active: lifting a pause.
  await register(userId, { workerName: "codex-impl", roleCeiling: "chore", desiredState: "active", revision: 3 });
  // The class never changes (the guard runs before the name/class CHECK).
  await rejectsWith(
    register(userId, { workerName: "codex-impl", providerClass: "claude", roleCeiling: "chore", desiredState: "paused", revision: 4 }),
    /AMUX_WORKER_REGISTRY_CLASS_CHANGED/,
  );
  // Retired is final, an activation included.
  await register(userId, { workerName: "codex-impl", roleCeiling: "chore", desiredState: "retired", revision: 4 });
  await rejectsWith(register(userId, { workerName: "codex-impl", roleCeiling: "chore", desiredState: "requested", revision: 5 }), /AMUX_WORKER_REGISTRY_RETIRED/);
  await rejectsWith(register(userId, { workerName: "codex-impl", roleCeiling: "chore", desiredState: "active", revision: 5 }), /AMUX_WORKER_REGISTRY_RETIRED/);
  // Cursor and Copilot never hold contract, whether they start or become active.
  await rejectsWith(register(userId, { workerName: "copilot-new", roleCeiling: "contract", desiredState: "active", revision: 1 }), /class_ceiling_check/);
  await rejectsWith(register(userId, { workerName: "cursor-new", roleCeiling: "contract", desiredState: "requested", revision: 2 }), /class_ceiling_check/);
});

test("the store activates directly: requested and paused workers become active through the owner's change", async () => {
  const session = owner();
  await change(session, { workerName: "cursor-impl", roleCeiling: "implementation", desiredState: "requested", expectedRevision: 0 });
  const activated = await change(session, { workerName: "cursor-impl", roleCeiling: "implementation", desiredState: "active", expectedRevision: 1 });
  assert.equal(activated.action, "amux.worker.change");
  assert.equal(activated.revision, 2);
  await change(session, { workerName: "cursor-impl", roleCeiling: "implementation", desiredState: "paused", expectedRevision: 2 });
  const resumed = await change(session, { workerName: "cursor-impl", roleCeiling: "implementation", desiredState: "active", expectedRevision: 3 });
  assert.equal(resumed.revision, 4);
  const first = await change(session, { workerName: "copilot-new", roleCeiling: "chore", desiredState: "active", expectedRevision: 0 });
  assert.equal(first.action, "amux.worker.register");
  const view = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) => readAmuxWorkerRegistryOrThrow(tx));
  assert.deepEqual(
    view.registrations?.map((row) => [row.workerName, row.desiredState, row.revision]),
    [
      ["copilot-new", "active", 1],
      ["cursor-impl", "active", 4],
    ],
  );
});

test("every event needs the person's audit of its own transaction, under the right action", async () => {
  const userId = `owner-${randomUUID()}`;
  const row = { workerName: "claude-impl", roleCeiling: "implementation", desiredState: "active", revision: 1 };
  await rejectsWith(insertRaw(row, { kind: "none" }), /AMUX_WORKER_REGISTRY_UNAUDITED|auditLogId_fkey/);
  await rejectsWith(insertRaw(row, { kind: "person", userId, action: "amux.worker.change" }), /AMUX_WORKER_REGISTRY_UNAUDITED/);
  await rejectsWith(insertRaw(row, { kind: "person", userId, action: "amux.worker.register", targetId: randomUUID() }), /AMUX_WORKER_REGISTRY_UNAUDITED/);
  // An audit row of an earlier transaction does not count.
  const earlier = await prisma.$transaction((tx) =>
    writeAdminAuditLog({ tx, session: owner(userId), action: "amux.worker.register", targetType: TARGET, targetId: "x", summary: "test" }),
  );
  await rejectsWith(
    prisma.$executeRaw`
      INSERT INTO "AmuxWorkerRegistryEvent"
        ("id", "workerName", "providerClass", "roleCeiling", "desiredState", "revision", "actorUserId", "auditLogId")
      VALUES (${randomUUID()}, 'claude-impl', 'claude', 'implementation', 'active', 1, ${userId}, ${earlier})
    `,
    /AMUX_WORKER_REGISTRY_UNAUDITED/,
  );
  await insertRaw(row, { kind: "person", userId, action: "amux.worker.register" });
});

test("events are never changed or removed, and only READ COMMITTED writes", async () => {
  const userId = `owner-${randomUUID()}`;
  await rejectsWith(
    insertRaw(
      { workerName: "claude-impl", roleCeiling: "implementation", desiredState: "active", revision: 1 },
      { kind: "person", userId, action: "amux.worker.register" },
      { isolation: Prisma.TransactionIsolationLevel.RepeatableRead },
    ),
    /AMUX_WORKER_REGISTRY_ISOLATION/,
  );
  const id = await register(userId, { workerName: "claude-impl", roleCeiling: "implementation", desiredState: "active", revision: 1 });
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxWorkerRegistryEvent" SET "desiredState" = 'paused' WHERE "id" = ${id}`, /AMUX_WORKER_REGISTRY_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxWorkerRegistryEvent" WHERE "id" = ${id}`, /AMUX_WORKER_REGISTRY_IMMUTABLE/);
  // The database clock, not the writer's.
  const [row] = await prisma.$queryRaw<Array<{ skew: number }>>`
    SELECT abs(extract(epoch FROM ("createdAt" - clock_timestamp())))::float AS skew
    FROM "AmuxWorkerRegistryEvent" WHERE "id" = ${id}
  `;
  assert.ok(row.skew < 60);
});

test("the observation, trial and latch tables refuse every write until R4 and R5", async () => {
  await rejectsWith(
    prisma.$executeRaw`INSERT INTO "AmuxWorkerObservation" ("id", "workerName", "status") VALUES (${randomUUID()}, 'claude-impl', 'ok')`,
    /AMUX_WORKER_OBSERVATION_CLOSED/,
  );
  // The BEFORE trigger refuses before the audit foreign key is even checked.
  await rejectsWith(
    prisma.$executeRaw`
      INSERT INTO "AmuxWorkerTrialEvidence" ("id", "workerName", "trialNumber", "outcome", "costMicroUsd", "auditLogId")
      VALUES (${randomUUID()}, 'cursor-impl', 1, 'passed', NULL, ${randomUUID()})
    `,
    /AMUX_WORKER_TRIAL_EVIDENCE_CLOSED/,
  );
  await rejectsWith(
    prisma.$executeRaw`
      INSERT INTO "AmuxWorkerLatchEvent" ("id", "workerName", "eventKind", "actorKind", "actorUserId", "auditLogId")
      VALUES (${randomUUID()}, 'cursor-impl', 'opened', 'system', NULL, ${randomUUID()})
    `,
    /AMUX_WORKER_LATCH_CLOSED/,
  );
  const view = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryRead, (tx) => readAmuxWorkerRegistryOrThrow(tx));
  assert.deepEqual(view.registrations, []);
  assert.equal(view.latches.size, 0);
  assert.equal(view.observations.size, 0);
});
