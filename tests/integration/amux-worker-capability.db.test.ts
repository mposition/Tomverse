import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  AmuxWorkerCapabilityWriteError,
  readAmuxWorkerCapabilitiesOrThrow,
  recordAmuxWorkerCapabilityByOwner,
} from "@/lib/amux/workerCapabilityStore";
import { recordAmuxWorkerRegistryChangeByOwner } from "@/lib/amux/workerRegistryStore";
import { prisma } from "@/lib/prisma";

// Orchestration policy version 35, stage R2a, against PostgreSQL through the
// migration history (20261013100000_amux_worker_capability), in the agents
// lane. What the migration header says the database enforces: a registered,
// non-retired worker; the closed tag and v22 lists; every tag and v22 role
// within the worker's current ceiling and class; distinct values; the
// per-worker revision; the owner's audit of the same transaction; no update
// or delete. The writer's own statements are counted in
// tests/amuxWorkerCapabilityStore.test.mjs.

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

beforeEach(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxWorkerCapabilityEvent", "AmuxWorkerRegistryEvent" RESTART IDENTITY`);
});

after(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxWorkerCapabilityEvent", "AmuxWorkerRegistryEvent" RESTART IDENTITY`);
  await prisma.$disconnect();
});

const owner = (id = `capability-owner-${randomUUID()}`): Session =>
  ({ user: { id, email: "owner@example.test" }, expires: "2099-01-01T00:00:00.000Z" }) as Session;

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

const registerWorker = (session: Session, workerName: string, roleCeiling: string, desiredState = "requested") =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryChange, (tx) =>
    recordAmuxWorkerRegistryChangeByOwner(tx, { session, workerName, providerClass: workerName.slice(0, workerName.indexOf("-")), roleCeiling, desiredState, expectedRevision: 0 }),
  );

const write = (session: Session, workerName: string, capability: unknown, expectedRevision = 0) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityChange, (tx) =>
    recordAmuxWorkerCapabilityByOwner(tx, { session, workerName, expectedRevision, capability }),
  );

/** A raw insert with the owner's audit, bypassing the store's own refusal. */
const insertRaw = (userId: string, row: {
  workerName: string; revision?: number; routingTags: string[]; toolCapabilities?: string[];
  v22Model?: string | null; v22Roles?: string[] | null; v22Tools?: string[] | null;
}) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const auditLogId = await writeAdminAuditLog({
      tx, session: owner(userId), action: "amux.worker.capability", targetType: "AmuxWorkerCapabilityEvent", targetId: id, summary: "test",
    });
    await tx.$executeRaw`
      INSERT INTO "AmuxWorkerCapabilityEvent"
        ("id", "workerName", "revision", "model", "routingTags", "toolCapabilities", "v22Model", "v22Roles", "v22Tools", "actorUserId", "auditLogId")
      VALUES (${id}, ${row.workerName}, ${row.revision ?? 1}, NULL, ${row.routingTags}::text[], ${row.toolCapabilities ?? []}::text[],
              ${row.v22Model ?? null}, ${row.v22Roles ?? null}::text[], ${row.v22Tools ?? null}::text[], ${userId}, ${auditLogId})
    `;
  });

test("the store records production's shape, and reads it back", async () => {
  const session = owner();
  await registerWorker(session, "claude-chore", "chore", "active");
  const record = await write(session, "claude-chore", {
    model: null, routingTags: ["chore"], toolCapabilities: [],
    v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] },
  });
  assert.equal(record.revision, 1);
  const entries = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerCapabilityRead, (tx) => readAmuxWorkerCapabilitiesOrThrow(tx));
  assert.deepEqual(entries.get("claude-chore")?.capability, {
    model: null, routingTags: ["chore"], toolCapabilities: [],
    v22: { model: "claude-opus-5-5", roles: ["investigate"], tools: ["repo_read"] },
  });
  const second = await write(session, "claude-chore", { model: null, routingTags: ["chore", "tests"], toolCapabilities: [], v22: null }, 1);
  assert.equal(second.revision, 2);
  await assert.rejects(
    write(session, "claude-chore", { model: null, routingTags: ["chore"], toolCapabilities: [], v22: null }, 1),
    (error) => error instanceof AmuxWorkerCapabilityWriteError && error.code === "stale_revision",
  );
});

test("the guard binds every tag and v22 role to the worker's current ceiling and class", async () => {
  const session = owner();
  const userId = session.user!.id;
  await registerWorker(session, "claude-chore", "chore");
  await registerWorker(session, "cursor-impl", "implementation");
  await registerWorker(session, "codex-impl", "implementation");
  await rejectsWith(insertRaw(userId, { workerName: "claude-chore", routingTags: ["implementation"] }), /AMUX_WORKER_CAPABILITY_TAG_CEILING/);
  await rejectsWith(insertRaw(userId, { workerName: "codex-impl", routingTags: ["architecture"] }), /AMUX_WORKER_CAPABILITY_TAG_CEILING/);
  await rejectsWith(insertRaw(userId, { workerName: "cursor-impl", routingTags: ["review"] }), /AMUX_WORKER_CAPABILITY_TAG_VERIFIED/);
  await rejectsWith(insertRaw(userId, { workerName: "claude-chore", routingTags: ["chore"], v22Model: "claude-opus-5-5", v22Roles: ["implement"], v22Tools: ["repo_write"] }), /AMUX_WORKER_CAPABILITY_V22_ROLE/);
  // Owner decision 2026-10-26: every provider class may run v22; only a
  // Claude worker is held to a claude-* model.
  await rejectsWith(insertRaw(userId, { workerName: "claude-chore", routingTags: ["chore"], v22Model: "gpt-6-luna", v22Roles: ["investigate"], v22Tools: ["repo_read"] }), /AMUX_WORKER_CAPABILITY_V22_CLASS/);
  await rejectsWith(insertRaw(userId, { workerName: "claude-chore", routingTags: ["chore"], v22Model: "claude-opus-5-5", v22Roles: ["investigate"], v22Tools: ["repo_write"] }), /AMUX_WORKER_CAPABILITY_V22_ROLE/);
  await rejectsWith(insertRaw(userId, { workerName: "claude-chore", routingTags: ["chore", "chore"] }), /AMUX_WORKER_CAPABILITY_DUPLICATE/);
  await rejectsWith(insertRaw(userId, { workerName: "claude-chore", routingTags: ["engineering"] }), /routing_tags_check/);
  // The guard runs before the CHECK, so a malformed name is shown on a class
  // the guard lets through.
  await rejectsWith(insertRaw(userId, { workerName: "codex-impl", routingTags: ["implementation"], v22Model: "-not a model", v22Roles: ["implement"], v22Tools: ["repo_write"] }), /v22_shape_check/);
  await rejectsWith(insertRaw(userId, { workerName: "claude-chore", routingTags: ["chore"], v22Model: "claude-opus-5-5", v22Roles: null, v22Tools: ["repo_read"] }), /v22_shape_check/);
  // Investigate is read-only and allowed at chore; review needs a verified class only.
  await insertRaw(userId, { workerName: "claude-chore", routingTags: ["chore", "review"], v22Model: "claude-opus-5-5", v22Roles: ["investigate", "review"], v22Tools: ["repo_read"] });
  await insertRaw(userId, { workerName: "codex-impl", routingTags: ["implementation"], v22Model: "gpt-6-luna", v22Roles: ["implement"], v22Tools: ["repo_write"] });
  // Cursor takes read roles only, in the guard as in the app.
  await rejectsWith(insertRaw(userId, { workerName: "cursor-impl", routingTags: ["implementation"], v22Model: "auto", v22Roles: ["implement"], v22Tools: ["repo_write"] }), /AMUX_WORKER_CAPABILITY_V22_ROLE/);
  await insertRaw(userId, { workerName: "cursor-impl", routingTags: ["implementation"], v22Model: "auto", v22Roles: ["investigate"], v22Tools: ["repo_read"] });
});

test("only a registered, non-retired worker has capabilities; revisions follow on; events never change", async () => {
  const session = owner();
  const userId = session.user!.id;
  await rejectsWith(insertRaw(userId, { workerName: "claude-ghost", routingTags: ["chore"] }), /AMUX_WORKER_CAPABILITY_NOT_REGISTERED/);
  await registerWorker(session, "codex-chore", "chore");
  await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.workerRegistryChange, (tx) =>
    recordAmuxWorkerRegistryChangeByOwner(tx, { session, workerName: "codex-chore", providerClass: "codex", roleCeiling: "chore", desiredState: "retired", expectedRevision: 1 }));
  await rejectsWith(insertRaw(userId, { workerName: "codex-chore", routingTags: ["chore"] }), /AMUX_WORKER_CAPABILITY_RETIRED/);
  await registerWorker(session, "claude-impl", "implementation");
  await rejectsWith(insertRaw(userId, { workerName: "claude-impl", revision: 2, routingTags: ["chore"] }), /AMUX_WORKER_CAPABILITY_STALE_REVISION/);
  await insertRaw(userId, { workerName: "claude-impl", routingTags: ["implementation"] });
  await rejectsWith(prisma.$executeRaw`UPDATE "AmuxWorkerCapabilityEvent" SET "routingTags" = ARRAY['chore']`, /AMUX_WORKER_CAPABILITY_IMMUTABLE/);
  await rejectsWith(prisma.$executeRaw`DELETE FROM "AmuxWorkerCapabilityEvent"`, /AMUX_WORKER_CAPABILITY_IMMUTABLE/);
});

test("an event needs the owner's audit of its own transaction under the capability action", async () => {
  const session = owner();
  const userId = session.user!.id;
  await registerWorker(session, "claude-impl", "implementation");
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const id = randomUUID();
      const auditLogId = await writeAdminAuditLog({ tx, session: owner(userId), action: "amux.worker.change", targetType: "AmuxWorkerCapabilityEvent", targetId: id, summary: "test" });
      await tx.$executeRaw`
        INSERT INTO "AmuxWorkerCapabilityEvent" ("id", "workerName", "revision", "routingTags", "toolCapabilities", "actorUserId", "auditLogId")
        VALUES (${id}, 'claude-impl', 1, ARRAY['implementation']::text[], ARRAY[]::text[], ${userId}, ${auditLogId})
      `;
    }),
    /AMUX_WORKER_CAPABILITY_UNAUDITED/,
  );
});
