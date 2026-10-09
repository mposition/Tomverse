import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_DB_BOUNDARIES, AmuxDbBoundaryError, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import {
  latchDecisionMakerInstanceOff,
  readDecisionMakerSwitches,
  readDecisionMakerSwitchesOrThrow,
  recordDecisionMakerSwitchByOperator,
} from "@/lib/amux/decisionMakerSwitchStore";
import { prisma } from "@/lib/prisma";

// AMUX Decision Maker policy version 1 (docs/policy/amux-decision-maker.md),
// stage S1b, against PostgreSQL through the migration history
// (20261008030000_amux_decision_maker_switch), in the agents lane of the DB
// integration suite.
//
// §12's blocking test "스위치가 off·proposal 밖의 값을 거부한다는 DB 테스트" is
// the first one below. The rest cover what the migration header says the
// database enforces: the scope/value/actor/reason CHECKs, the audit row of the
// same transaction under the right action and actor, the increasing sequence,
// the database clock, and no update or delete. The writer's own statements are
// counted in tests/amuxDecisionMakerSwitch.test.mjs.

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
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxDecisionMakerSwitchEvent" RESTART IDENTITY`);
});

after(async () => {
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AmuxDecisionMakerSwitchEvent" RESTART IDENTITY`);
  await prisma.$disconnect();
});

const TARGET = "AmuxDecisionMakerSwitchEvent";

const operator = (id = `dm-operator-${randomUUID()}`): Session =>
  ({ user: { id, email: "operator@example.test" }, expires: "2099-01-01T00:00:00.000Z" }) as Session;

/** A database refusal, found wherever Prisma put the message. Null accepts any refusal. */
const rejectsWith = async (promise: Promise<unknown>, pattern: RegExp | null = null) => {
  let caught: unknown = null;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  assert.ok(caught !== null, "the database accepted what it must refuse");
  if (pattern === null) return;
  const record = caught as { meta?: unknown; cause?: unknown };
  const text = [String(caught), JSON.stringify(record.meta ?? null), String(record.cause ?? "")].join(" ");
  assert.match(text, pattern);
};

type Row = {
  scope: string;
  value: string;
  reasonCode: string;
  actorKind: string;
  actorUserId: string | null;
  sequence?: number;
  createdAt?: string;
};

type Audit =
  | { kind: "person"; userId: string; action: string; targetId?: string }
  | { kind: "system"; actor: "amux-decision-router" | "amux-decision-maker-openai" | "amux-decision-maker-anthropic"; action: string; targetId?: string }
  | { kind: "none" };

const writeAudit = async (tx: Prisma.TransactionClient, audit: Audit, id: string): Promise<string> => {
  if (audit.kind === "person") {
    return writeAdminAuditLog({
      tx,
      session: operator(audit.userId),
      action: audit.action,
      targetType: TARGET,
      targetId: audit.targetId ?? id,
      summary: "test",
    });
  }
  if (audit.kind === "system") {
    return writeSystemAuditLog({
      tx,
      systemActor: audit.actor,
      action: audit.action,
      targetType: TARGET,
      targetId: audit.targetId ?? id,
      summary: "test",
    });
  }
  return `no-such-audit-${randomUUID()}`;
};

const insertRow = (tx: Prisma.TransactionClient, id: string, row: Row, auditLogId: string) =>
  row.sequence === undefined
    ? tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerSwitchEvent"
          ("id", "scope", "value", "reasonCode", "actorKind", "actorUserId", "auditLogId", "createdAt")
        VALUES
          (${id}, ${row.scope}, ${row.value}, ${row.reasonCode}, ${row.actorKind}, ${row.actorUserId}, ${auditLogId},
           ${row.createdAt ?? "2001-01-01T00:00:00Z"}::timestamptz)
      `
    : tx.$executeRaw`
        INSERT INTO "AmuxDecisionMakerSwitchEvent"
          ("id", "sequence", "scope", "value", "reasonCode", "actorKind", "actorUserId", "auditLogId")
        VALUES
          (${id}, ${row.sequence}, ${row.scope}, ${row.value}, ${row.reasonCode}, ${row.actorKind}, ${row.actorUserId}, ${auditLogId})
      `;

/** One event and its audit row in one transaction, written directly so a test can break either. */
const append = (row: Row, audit: Audit) =>
  prisma.$transaction(async (tx) => {
    const id = randomUUID();
    const auditLogId = await writeAudit(tx, audit, id);
    await insertRow(tx, id, row, auditLogId);
    return { id, auditLogId };
  });

const person = (userId: string, scope: string, value: string, action = "amux.decision.mode") => ({
  row: { scope, value, reasonCode: "operator", actorKind: "human", actorUserId: userId },
  audit: { kind: "person" as const, userId, action },
});

const latch = (
  scope: "decision-maker-openai" | "decision-maker-anthropic",
  reasonCode = "validation_latch",
) => ({
  row: { scope, value: "off", reasonCode, actorKind: "system", actorUserId: null },
  audit: {
    kind: "system" as const,
    actor: scope === "decision-maker-openai" ? ("amux-decision-maker-openai" as const) : ("amux-decision-maker-anthropic" as const),
    action: "amux.decision.latch",
  },
});

const rowsOf = () =>
  prisma.$queryRaw<
    Array<{ id: string; sequence: bigint; scope: string; value: string; actorKind: string; createdAt: Date }>
  >`SELECT "id", "sequence", "scope", "value", "actorKind", "createdAt" FROM "AmuxDecisionMakerSwitchEvent" ORDER BY "sequence"`;

const dbNow = async () =>
  (await prisma.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`)[0]!.now;

test("the store refuses any switch value outside off/proposal, the kill switch outside on/off, and 'autonomous' above all", async () => {
  // §12: "스위치가 off·proposal 밖의 값을 거부한다는 DB 테스트". Each row carries a
  // valid audit, so the refusal is a CHECK's, not the trigger's. PostgreSQL
  // tests CHECKs in name order, so a value outside both lists may be reported
  // by the pairing CHECK before the value CHECK.
  const userId = `dm-operator-${randomUUID()}`;
  for (const [scope, value, constraint] of [
    ["decision-maker-openai", "autonomous", /AmuxDecisionMakerSwitchEvent_(scope_)?value_check/],
    ["decision-maker-anthropic", "autonomous", /AmuxDecisionMakerSwitchEvent_(scope_)?value_check/],
    ["kill_switch", "autonomous", /AmuxDecisionMakerSwitchEvent_(scope_)?value_check/],
    ["decision-maker-openai", "Proposal", /AmuxDecisionMakerSwitchEvent_(scope_)?value_check/],
    ["decision-maker-openai", "on", /AmuxDecisionMakerSwitchEvent_scope_value_check/],
    ["kill_switch", "proposal", /AmuxDecisionMakerSwitchEvent_scope_value_check/],
    ["decision-maker-gemini", "off", /AmuxDecisionMakerSwitchEvent_scope_check/],
    ["", "off", /AmuxDecisionMakerSwitchEvent_scope_check/],
  ] as const) {
    const { row, audit } = person(userId, scope, value);
    await rejectsWith(append(row, audit), constraint);
  }
  assert.equal((await rowsOf()).length, 0);
  // The values the policy names are accepted.
  for (const [scope, value] of [
    ["kill_switch", "on"],
    ["kill_switch", "off"],
    ["decision-maker-openai", "proposal"],
    ["decision-maker-anthropic", "off"],
  ] as const) {
    const { row, audit } = person(userId, scope, value);
    await append(row, audit);
  }
  assert.equal((await rowsOf()).length, 4);
});

test("a person changes only as operator and is named; the system only latches an instance off", async () => {
  const userId = `dm-operator-${randomUUID()}`;
  // A system row for the operator reason, and a system row that is not a latch.
  await rejectsWith(
    append({ ...latch("decision-maker-openai").row, reasonCode: "operator" }, latch("decision-maker-openai").audit),
    /AmuxDecisionMakerSwitchEvent_actor_reason_check/,
  );
  await rejectsWith(
    append({ ...latch("decision-maker-openai").row, value: "proposal" }, latch("decision-maker-openai").audit),
    /AmuxDecisionMakerSwitchEvent_actor_reason_check/,
  );
  // A system row carrying a person.
  await rejectsWith(
    append({ ...latch("decision-maker-anthropic").row, actorUserId: userId }, latch("decision-maker-anthropic").audit),
    /AmuxDecisionMakerSwitchEvent_actor_user_check/,
  );
  // A person's row for a latch reason.
  const latchReason = person(userId, "decision-maker-openai", "off");
  await rejectsWith(
    append({ ...latchReason.row, reasonCode: "validation_latch" }, latchReason.audit),
    /AmuxDecisionMakerSwitchEvent_actor_reason_check/,
  );
  // A person's row without the person: no audit row can name a missing id.
  await rejectsWith(
    append({ ...latchReason.row, actorUserId: null }, latchReason.audit),
    /AMUX_DM_SWITCH_UNAUDITED|AmuxDecisionMakerSwitchEvent_actor_user_check/,
  );
  // The kill switch is never latched by the system.
  await rejectsWith(
    append(
      { scope: "kill_switch", value: "off", reasonCode: "validation_latch", actorKind: "system", actorUserId: null },
      { kind: "system", actor: "amux-decision-router", action: "amux.decision.latch" },
    ),
    /AMUX_DM_SWITCH_UNAUDITED|AmuxDecisionMakerSwitchEvent_actor_reason_check/,
  );
  // An actor kind outside the list.
  await rejectsWith(
    append({ ...latchReason.row, actorKind: "dm" }, latch("decision-maker-openai").audit),
    /AMUX_DM_SWITCH_UNAUDITED|AmuxDecisionMakerSwitchEvent_actor_kind_check/,
  );
  assert.equal((await rowsOf()).length, 0);
  // Both latch reasons on both instances are accepted.
  await append(latch("decision-maker-openai", "validation_latch").row, latch("decision-maker-openai").audit);
  await append(latch("decision-maker-anthropic", "cleanup_latch").row, latch("decision-maker-anthropic").audit);
  assert.equal((await rowsOf()).length, 2);
});

test("every event needs an audit row of its own transaction, its own target, its own person or actor and the right action", async () => {
  const userId = `dm-operator-${randomUUID()}`;
  const change = person(userId, "decision-maker-openai", "proposal");
  // No audit row at all.
  await rejectsWith(append(change.row, { kind: "none" }), /AMUX_DM_SWITCH_UNAUDITED/);
  // An audit row naming another event.
  await rejectsWith(append(change.row, { ...change.audit, targetId: randomUUID() }), /AMUX_DM_SWITCH_UNAUDITED/);
  // Another person's audit row.
  await rejectsWith(
    append(change.row, { ...change.audit, userId: `someone-else-${randomUUID()}` }),
    /AMUX_DM_SWITCH_UNAUDITED/,
  );
  // A latch release when nothing is latched.
  await rejectsWith(append(change.row, { ...change.audit, action: "amux.decision.latch_release" }), /AMUX_DM_SWITCH_UNAUDITED/);
  // A person's row under a system audit.
  await rejectsWith(append(change.row, latch("decision-maker-openai").audit), /AMUX_DM_SWITCH_UNAUDITED/);
  // A latch by the router, by the other instance, or under a person's entry.
  const openaiLatch = latch("decision-maker-openai");
  await rejectsWith(
    append(openaiLatch.row, { kind: "system", actor: "amux-decision-router", action: "amux.decision.latch" }),
    /AMUX_DM_SWITCH_UNAUDITED/,
  );
  await rejectsWith(
    append(openaiLatch.row, { kind: "system", actor: "amux-decision-maker-anthropic", action: "amux.decision.latch" }),
    /AMUX_DM_SWITCH_UNAUDITED/,
  );
  await rejectsWith(
    append(openaiLatch.row, { kind: "person", userId, action: "amux.decision.latch" }),
    /AMUX_DM_SWITCH_UNAUDITED/,
  );
  await rejectsWith(
    append(openaiLatch.row, { kind: "system", actor: "amux-decision-maker-openai", action: "amux.decision.mode" }),
    /AMUX_DM_SWITCH_UNAUDITED/,
  );

  // An audit row committed by an earlier transaction is not this event's.
  const id = randomUUID();
  const earlierAudit = await prisma.$transaction((tx) => writeAudit(tx, change.audit, id));
  await rejectsWith(
    prisma.$transaction((tx) => insertRow(tx, id, change.row, earlierAudit)),
    /AMUX_DM_SWITCH_UNAUDITED/,
  );
  assert.equal((await rowsOf()).length, 0);

  // One audit row names one event only.
  await rejectsWith(
    prisma.$transaction(async (tx) => {
      const first = randomUUID();
      const auditLogId = await writeAudit(tx, change.audit, first);
      await insertRow(tx, first, change.row, auditLogId);
      await insertRow(tx, randomUUID(), change.row, auditLogId);
    }),
    /AMUX_DM_SWITCH_UNAUDITED|AmuxDecisionMakerSwitchEvent_auditLogId_key|Unique constraint/,
  );
  assert.equal((await rowsOf()).length, 0);
});

test("the first change after a latch must be recorded as its release, and only then as a mode change", async () => {
  const userId = `dm-operator-${randomUUID()}`;
  await append(person(userId, "decision-maker-anthropic", "proposal").row, person(userId, "decision-maker-anthropic", "proposal").audit);
  await append(latch("decision-maker-anthropic").row, latch("decision-maker-anthropic").audit);
  // A mode change over the latch is refused, even one that keeps it off.
  for (const value of ["proposal", "off"]) {
    const { row, audit } = person(userId, "decision-maker-anthropic", value);
    await rejectsWith(append(row, audit), /AMUX_DM_SWITCH_UNAUDITED/);
  }
  // The latch of one instance does not touch the other.
  await append(person(userId, "decision-maker-openai", "proposal").row, person(userId, "decision-maker-openai", "proposal").audit);
  // The release, then an ordinary change again.
  const release = person(userId, "decision-maker-anthropic", "off", "amux.decision.latch_release");
  await append(release.row, release.audit);
  await rejectsWith(
    append(person(userId, "decision-maker-anthropic", "proposal", "amux.decision.latch_release").row, release.audit),
    /AMUX_DM_SWITCH_UNAUDITED/,
  );
  await append(person(userId, "decision-maker-anthropic", "proposal").row, person(userId, "decision-maker-anthropic", "proposal").audit);
});

test("events are never updated or deleted", async () => {
  const userId = `dm-operator-${randomUUID()}`;
  const { id } = await append(person(userId, "kill_switch", "on").row, person(userId, "kill_switch", "on").audit);
  await rejectsWith(
    prisma.$executeRaw`UPDATE "AmuxDecisionMakerSwitchEvent" SET "value" = 'off' WHERE "id" = ${id}`,
    /AMUX_DM_SWITCH_IMMUTABLE/,
  );
  await rejectsWith(
    prisma.$executeRaw`UPDATE "AmuxDecisionMakerSwitchEvent" SET "createdAt" = clock_timestamp() WHERE "id" = ${id}`,
    /AMUX_DM_SWITCH_IMMUTABLE/,
  );
  await rejectsWith(
    prisma.$executeRaw`DELETE FROM "AmuxDecisionMakerSwitchEvent" WHERE "id" = ${id}`,
    /AMUX_DM_SWITCH_IMMUTABLE/,
  );
  const [row] = await rowsOf();
  assert.equal(row?.value, "on");
});

test("an event under any isolation level but READ COMMITTED is refused, by the store and by the guard", async () => {
  // 20261008090000_amux_decision_maker_switch_serialization: the guard reads the
  // scope's newest event after its lock, which sees a transaction the lock
  // waited for only under READ COMMITTED. Under REPEATABLE READ a latch
  // committed meanwhile could be missed and the first change after it written
  // as amux.decision.mode instead of its release.
  const userId = `dm-operator-${randomUUID()}`;
  await append(latch("decision-maker-openai").row, latch("decision-maker-openai").audit);
  for (const isolationLevel of [
    Prisma.TransactionIsolationLevel.RepeatableRead,
    Prisma.TransactionIsolationLevel.Serializable,
  ]) {
    const { row, audit } = person(userId, "decision-maker-openai", "proposal", "amux.decision.latch_release");
    await rejectsWith(
      prisma.$transaction(
        async (tx) => {
          const id = randomUUID();
          await insertRow(tx, id, row, await writeAudit(tx, audit, id));
        },
        { isolationLevel },
      ),
      /AMUX_DM_SWITCH_ISOLATION/,
    );
    await rejectsWith(
      prisma.$transaction(
        (tx) =>
          recordDecisionMakerSwitchByOperator(tx, {
            session: operator(userId),
            scope: "decision-maker-openai",
            value: "proposal",
          }),
        { isolationLevel },
      ),
      /AMUX_DM_SWITCH_ISOLATION/,
    );
    await rejectsWith(
      prisma.$transaction(
        (tx) => latchDecisionMakerInstanceOff(tx, { instance: "decision-maker-anthropic", reason: "cleanup_latch" }),
        { isolationLevel },
      ),
      /AMUX_DM_SWITCH_ISOLATION/,
    );
    // The refusal of an update comes first, whatever the level.
    await rejectsWith(
      prisma.$transaction(
        (tx) => tx.$executeRaw`UPDATE "AmuxDecisionMakerSwitchEvent" SET "value" = 'proposal'`,
        { isolationLevel },
      ),
      /AMUX_DM_SWITCH_IMMUTABLE/,
    );
  }
  assert.equal((await rowsOf()).length, 1);
  // Under READ COMMITTED the release goes through as before.
  const release = await prisma.$transaction(
    (tx) =>
      recordDecisionMakerSwitchByOperator(tx, {
        session: operator(userId),
        scope: "decision-maker-openai",
        value: "proposal",
      }),
    { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
  );
  assert.equal(release.action, "amux.decision.latch_release");
});

test("createdAt is the database clock of the insert, whatever the writer sent", async () => {
  const userId = `dm-operator-${randomUUID()}`;
  const before = await dbNow();
  await append(
    { ...person(userId, "decision-maker-openai", "off").row, createdAt: "2001-01-01T00:00:00Z" },
    person(userId, "decision-maker-openai", "off").audit,
  );
  const afterInsert = await dbNow();
  const [row] = await rowsOf();
  assert.ok(row);
  assert.ok(row.createdAt.getTime() >= before.getTime() - 1, `${row.createdAt.toISOString()} >= ${before.toISOString()}`);
  assert.ok(row.createdAt.getTime() <= afterInsert.getTime() + 1);
});

test("a scope's sequence only increases: an event numbered below the newest is refused", async () => {
  const userId = `dm-operator-${randomUUID()}`;
  await append(person(userId, "decision-maker-openai", "proposal").row, person(userId, "decision-maker-openai", "proposal").audit);
  await append(person(userId, "decision-maker-openai", "off").row, person(userId, "decision-maker-openai", "off").audit);
  const newest = (await rowsOf()).at(-1)!;
  const stale = person(userId, "decision-maker-openai", "proposal");
  await rejectsWith(
    append({ ...stale.row, sequence: Number(newest.sequence) - 1 }, stale.audit),
    /AMUX_DM_SWITCH_OUT_OF_ORDER/,
  );
  // In a scope with no event the order rule has nothing to compare, and a
  // number another event already holds is refused by the unique index.
  const other = person(userId, "kill_switch", "off");
  await rejectsWith(append({ ...other.row, sequence: Number(newest.sequence) - 1 }, other.audit), /duplicate key|Unique constraint|sequence_key/i);
  assert.equal((await readDecisionMakerSwitches(prisma)).instances["decision-maker-openai"], "off");
});

test("with no event the store reads kill switch off and both instances off", async () => {
  assert.deepEqual(await readDecisionMakerSwitches(prisma), {
    killSwitch: false,
    instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "off" },
  });
});

test("the store writes a person's change and a latch with their audit rows, and the newest event of each scope wins", async () => {
  const session = operator();
  const first = await prisma.$transaction((tx) =>
    recordDecisionMakerSwitchByOperator(tx, { session, scope: "decision-maker-openai", value: "proposal" }),
  );
  assert.equal(first.action, "amux.decision.mode");
  await prisma.$transaction((tx) =>
    recordDecisionMakerSwitchByOperator(tx, { session, scope: "decision-maker-anthropic", value: "proposal" }),
  );
  assert.deepEqual(await readDecisionMakerSwitches(prisma), {
    killSwitch: false,
    instances: { "decision-maker-openai": "proposal", "decision-maker-anthropic": "proposal" },
  });

  const latched = await prisma.$transaction((tx) =>
    latchDecisionMakerInstanceOff(tx, { instance: "decision-maker-openai", reason: "cleanup_latch" }),
  );
  assert.ok(BigInt(latched.sequence) > BigInt(first.sequence));
  assert.deepEqual(await readDecisionMakerSwitches(prisma), {
    killSwitch: false,
    instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "proposal" },
  });
  const latchAudit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: latched.auditLogId } });
  assert.equal(latchAudit.action, "amux.decision.latch");
  assert.equal(latchAudit.actorUserId, null);
  assert.equal(latchAudit.targetId, latched.eventId);
  assert.deepEqual(latchAudit.metadata, {
    event_id: latched.eventId,
    scope: "decision-maker-openai",
    value: "off",
    reason_code: "cleanup_latch",
    systemActor: "amux-decision-maker-openai",
  });

  const kill = await prisma.$transaction((tx) =>
    recordDecisionMakerSwitchByOperator(tx, { session, scope: "kill_switch", value: "on" }),
  );
  assert.equal(kill.action, "amux.decision.mode");
  // The operator's next change of the latched instance is its release.
  const release = await prisma.$transaction((tx) =>
    recordDecisionMakerSwitchByOperator(tx, { session, scope: "decision-maker-openai", value: "proposal" }),
  );
  assert.equal(release.action, "amux.decision.latch_release");
  const releaseAudit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: release.auditLogId } });
  assert.equal(releaseAudit.action, "amux.decision.latch_release");
  assert.equal(releaseAudit.actorUserId, session.user!.id);
  assert.deepEqual(releaseAudit.metadata, {
    event_id: release.eventId,
    scope: "decision-maker-openai",
    value: "proposal",
    reason_code: "operator",
    previous_value: "off",
  });
  assert.deepEqual(await readDecisionMakerSwitches(prisma), {
    killSwitch: true,
    instances: { "decision-maker-openai": "proposal", "decision-maker-anthropic": "proposal" },
  });

  // A rolled-back change leaves neither the event nor its audit row.
  const count = (await rowsOf()).length;
  const rolledBack: { auditLogId: string | null } = { auditLogId: null };
  await assert.rejects(
    prisma.$transaction(async (tx) => {
      const result = await recordDecisionMakerSwitchByOperator(tx, { session, scope: "kill_switch", value: "off" });
      rolledBack.auditLogId = result.auditLogId;
      throw new Error("rolled back after the change");
    }),
    /rolled back after the change/,
  );
  assert.equal((await rowsOf()).length, count);
  assert.ok(rolledBack.auditLogId);
  assert.equal(await prisma.adminAuditLog.count({ where: { id: rolledBack.auditLogId } }), 0);
  assert.equal((await readDecisionMakerSwitches(prisma)).killSwitch, true);
});

test("two people changing one scope at once commit one after the other, and the read is the last committed", async () => {
  const run = (value: "off" | "proposal") =>
    prisma.$transaction(
      (tx) => recordDecisionMakerSwitchByOperator(tx, { session: operator(), scope: "decision-maker-anthropic", value }),
      { maxWait: 10_000, timeout: 30_000 },
    );
  const results = await Promise.all([run("proposal"), run("off"), run("proposal")]);
  const rows = await rowsOf();
  assert.equal(rows.length, 3);
  // Distinct, and the read matches the event with the highest sequence.
  assert.equal(new Set(results.map((result) => result.sequence)).size, 3);
  const newest = rows.at(-1)!;
  assert.equal((await readDecisionMakerSwitches(prisma)).instances["decision-maker-anthropic"], newest.value);
  // In sequence order, each commit is no earlier than the one before it.
  for (let index = 1; index < rows.length; index += 1) {
    assert.ok(rows[index]!.createdAt.getTime() >= rows[index - 1]!.createdAt.getTime());
  }
});

test("the Admin route's boundary holds a person's change at its largest, and one call fewer refuses it", async () => {
  // §9: a DM store operation runs inside the AMUX DB boundary, at READ
  // COMMITTED for a mutation, which the switch guard requires. The change is
  // largest with an integrity key (the administrator audit's fourth
  // statement); the ceiling is that plus setup and fence, so one fewer must
  // refuse it and leave nothing behind.
  const names = ["ADMIN_AUDIT_INTEGRITY_KEY", "ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS"] as const;
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = "dm-switch-route-db-test-key";
  delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  try {
    const session = operator();
    const short = { ...AMUX_DB_BOUNDARIES.decisionMakerSwitchChange, prismaCallCeiling: 8 };
    await assert.rejects(
      withAmuxDbBoundary(short, (tx) =>
        recordDecisionMakerSwitchByOperator(tx, { session, scope: "decision-maker-anthropic", value: "proposal" }),
      ),
      (error: unknown) =>
        error instanceof AmuxDbBoundaryError && error.code === "AMUX_DB_PRISMA_CALL_CEILING_EXCEEDED",
    );
    assert.equal((await rowsOf()).length, 0);
    assert.equal(await prisma.adminAuditLog.count({ where: { actorUserId: session.user!.id } }), 0);

    const changed = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchChange, (tx) =>
      recordDecisionMakerSwitchByOperator(tx, { session, scope: "decision-maker-anthropic", value: "proposal" }),
    );
    assert.equal(changed.action, "amux.decision.mode");
    const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: changed.auditLogId } });
    assert.equal(audit.actorUserId, session.user!.id);
    assert.equal(audit.targetId, changed.eventId);

    const state = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerSwitchRead, (tx) =>
      readDecisionMakerSwitchesOrThrow(tx),
    );
    assert.deepEqual(state, {
      killSwitch: false,
      instances: { "decision-maker-openai": "off", "decision-maker-anthropic": "proposal" },
    });
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
