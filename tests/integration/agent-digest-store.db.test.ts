import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { after, test } from "node:test";

import { expireAgentDigestBodies, purgeAgentDigestMeta, recordAgentDigestItem } from "@/lib/agentDigestStore";
import { prisma } from "@/lib/prisma";

// lib/agentDigestStore.ts against PostgreSQL through the migration history:
// the row and its system audit entry commit together, a repeat writes
// nothing, and a refused submission never reaches the database.

const requireDedicatedTestDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  const runtimeRaw = process.env.DATABASE_URL?.trim();
  if (!testRaw) throw new Error("TEST_DATABASE_URL is required");
  if (runtimeRaw !== testRaw) {
    throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
  }
};
requireDedicatedTestDatabase();

const createdIds: string[] = [];

after(async () => {
  if (createdIds.length > 0) {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_delete"`);
    try {
      await prisma.$executeRawUnsafe(`DELETE FROM "AgentDigestItem" WHERE "id" = ANY($1::uuid[])`, createdIds);
    } finally {
      await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_delete"`);
    }
  }
  await prisma.$disconnect();
});

const submission = (payload: unknown = { gates: { pending: 40 } }) => ({
  agentKey: "qa-release",
  kind: "daily_digest",
  schemaVersion: 1,
  idempotencyKey: `qa-release:test:${randomUUID()}`,
  payload,
});

const auditCount = (targetId: string) =>
  prisma.adminAuditLog.count({ where: { targetType: "AgentDigestItem", targetId } });

test("a new item is one row and one system audit entry, with the canonical hash and no payload in the audit", async () => {
  const input = submission();
  const result = await recordAgentDigestItem(input);
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  createdIds.push(result.id);

  const row = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: result.id } });
  assert.equal(row.payloadSha256, result.payloadSha256);
  assert.equal(row.sizeBytes, result.sizeBytes);
  assert.deepEqual(row.payload, input.payload);

  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditLogId } });
  assert.equal(audit.action, "agent_digest.recorded");
  assert.equal(audit.targetId, result.id);
  assert.equal(audit.actorUserId, null);
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.systemActor, "qa-release-intake");
  assert.equal(metadata.payloadSha256, result.payloadSha256);
  assert.equal("payload" in metadata, false);
});

test("the same key and bytes replay; different bytes conflict; neither writes a row or an audit entry", async () => {
  const input = submission({ a: 1, b: 2 });
  const first = await recordAgentDigestItem(input);
  assert.equal(first.status, "created");
  if (first.status !== "created") return;
  createdIds.push(first.id);

  // Key order differs, canonical bytes do not.
  const replay = await recordAgentDigestItem({ ...input, payload: { b: 2, a: 1 } });
  assert.deepEqual(replay, { status: "replayed", id: first.id, payloadSha256: first.payloadSha256 });

  const conflict = await recordAgentDigestItem({ ...input, payload: { a: 2, b: 2 } });
  assert.deepEqual(conflict, { status: "conflict", id: first.id });

  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: input.idempotencyKey } }), 1);
  assert.equal(await auditCount(first.id), 1);
});

test("concurrent submissions under one key leave exactly one row and one audit entry", async () => {
  const input = submission({ race: true });
  const results = await Promise.all(Array.from({ length: 4 }, () => recordAgentDigestItem(input)));
  const created = results.filter((result) => result.status === "created");
  assert.equal(created.length, 1, JSON.stringify(results.map((result) => result.status)));
  assert.ok(results.every((result) => result.status === "created" || result.status === "replayed"));
  const id = created[0].status === "created" ? created[0].id : "";
  createdIds.push(id);
  assert.equal(await auditCount(id), 1);
});

test("a refused submission writes nothing", async () => {
  const input = submission({ note: `ghp_${"A".repeat(36)}` });
  const before = await prisma.adminAuditLog.count();
  const result = await recordAgentDigestItem(input);
  assert.deepEqual(result, { status: "refused", reason: "payload_contains_secret", secretRuleIds: ["github-token"] });
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: input.idempotencyKey } }), 0);
  assert.equal(await prisma.adminAuditLog.count(), before);
});

test("the transaction runs under the policy's database limits and Prisma timeout", async () => {
  let seen: { statement: string; idle: string } | null = null;
  let options: { timeout?: number } | undefined;
  const db = {
    $transaction: (work: (tx: typeof prisma) => Promise<unknown>, opts?: { timeout?: number }) => {
      options = opts;
      return prisma.$transaction(async (tx) => {
        const result = await work(tx as unknown as typeof prisma);
        const rows = await tx.$queryRaw<{ statement: string; idle: string }[]>`SELECT
          current_setting('statement_timeout') AS statement,
          current_setting('idle_in_transaction_session_timeout') AS idle`;
        seen = rows[0];
        return result;
      }, opts);
    },
  } as unknown as Pick<typeof prisma, "$transaction">;
  const result = await recordAgentDigestItem(submission({ limits: true }), db);
  if (result.status === "created") createdIds.push(result.id);
  assert.deepEqual(seen, { statement: "2s", idle: "1s" });
  assert.equal(options?.timeout, 37_000);
});

test("a caller's admission refusal inside the transaction writes no row and no audit entry", async () => {
  const input = submission({ admit: true });
  const auditsBefore = await prisma.adminAuditLog.count();
  let sawTransaction = false;
  const result = await recordAgentDigestItem(input, prisma, async (tx) => {
    // Runs after the audit chain lock: the lock is held by this transaction.
    const held = await tx.$queryRaw<{ held: boolean }[]>`SELECT EXISTS (
      SELECT 1 FROM pg_locks WHERE locktype = 'advisory' AND pid = pg_backend_pid() AND granted) AS held`;
    sawTransaction = held[0].held;
    return "control_revision_mismatch";
  });
  assert.deepEqual(result, { status: "not_admitted", reason: "control_revision_mismatch" });
  assert.equal(sawTransaction, true);
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: input.idempotencyKey } }), 0);
  assert.equal(await prisma.adminAuditLog.count(), auditsBefore);
});

test("a refusal from the caller's last-statement confirmation rolls back the row and its audit entry", async () => {
  const input = submission({ confirm: true });
  const auditsBefore = await prisma.adminAuditLog.count();
  const result = await recordAgentDigestItem(input, prisma, undefined, async (tx) => {
    // Runs after the audit entry: both writes are visible inside the transaction.
    const seen = await tx.agentDigestItem.count({ where: { idempotencyKey: input.idempotencyKey } });
    return seen === 1 ? "run_deadline_passed" : "unexpected";
  });
  assert.deepEqual(result, { status: "not_admitted", reason: "run_deadline_passed" });
  assert.equal(await prisma.agentDigestItem.count({ where: { idempotencyKey: input.idempotencyKey } }), 0);
  assert.equal(await prisma.adminAuditLog.count(), auditsBefore);
});

test("a confirmation returning null commits; on a replay or conflict it is not asked", async () => {
  const input = submission({ confirmCommit: true });
  let asked = 0;
  const confirm = async () => {
    asked += 1;
    return null;
  };
  const first = await recordAgentDigestItem(input, prisma, undefined, confirm);
  assert.equal(first.status, "created");
  if (first.status === "created") createdIds.push(first.id);
  assert.equal(asked, 1);
  assert.equal((await recordAgentDigestItem(input, prisma, undefined, confirm)).status, "replayed");
  assert.equal((await recordAgentDigestItem({ ...input, payload: { other: 1 } }, prisma, undefined, confirm)).status, "conflict");
  assert.equal(asked, 1);
});

test("an admission returning null lets the row and its audit entry commit", async () => {
  const input = submission({ admitPass: true });
  const result = await recordAgentDigestItem(input, prisma, async () => null);
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  createdIds.push(result.id);
  assert.equal(await auditCount(result.id), 1);
});

// docs/policy/billing-finance-ops.md §7 W1a: the registration migration widens
// the CHECKs and the retention CASE. A billing-finance-ops row is accepted with
// its own 90-day body retention and its own intake actor; a kind that belongs
// to another agent is still refused by the database, not only by the store.
test("billing-finance-ops is registered with its kind, retention and intake actor", async () => {
  const result = await recordAgentDigestItem({
    agentKey: "billing-finance-ops",
    kind: "price_deadline_digest",
    schemaVersion: 1,
    idempotencyKey: `billing-finance-ops:test:${randomUUID()}`,
    payload: { verdict: "quiet", items: [], rejectedFields: [] },
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  createdIds.push(result.id);

  const row = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: result.id } });
  assert.equal(row.retentionUntil.getTime() - row.createdAt.getTime(), 90 * 86_400_000);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditLogId } });
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "billing-finance-ops-intake");

  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "AgentDigestItem" ("id", "agentKey", "kind", "schemaVersion", "idempotencyKey", "payload", "payloadSha256", "sizeBytes")
       VALUES ($1::uuid, 'billing-finance-ops', 'daily_digest', 1, $2, '{}'::jsonb, $3, 2)`,
      randomUUID(),
      `billing-finance-ops:test:${randomUUID()}`,
      "0".repeat(64),
    ),
    /AgentDigestItem_kind_check/,
  );
});

// The switch row the registration migration seeds is pinned on the migration's
// SQL in tests/agentDigestContract.test.mjs, not here: other suites in this
// lane clear AppSetting, so whether the row is still present when this file
// runs depends on test order, not on the migration.

// The function returns void, so it is called with $executeRawUnsafe (as the
// support_triage_assert_deadline tests do) rather than selected as a value.
// The boundary itself -- a run is refused only when the clock is strictly past
// the deadline -- cannot be hit with a live clock, so it is pinned on the
// function's text in tests/agentDigestContract.test.mjs; here the two sides of
// it are shown with a margin.
test("billing_finance_ops_assert_deadline passes before the deadline and raises after it or on NULL", async () => {
  await prisma.$executeRawUnsafe(
    `SELECT billing_finance_ops_assert_deadline(clock_timestamp() + interval '1 minute')`,
  );
  // A deadline passed from the application goes as an ISO instant with its Z.
  // Prisma sends a JS Date as a timestamp without a zone, which `::timestamptz`
  // then reads in the session's time zone -- on a +10:00 server that moved
  // this one-minute deadline ten hours into the past.
  await prisma.$executeRawUnsafe(
    `SELECT billing_finance_ops_assert_deadline($1::timestamptz)`,
    new Date(Date.now() + 60_000).toISOString(),
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`SELECT billing_finance_ops_assert_deadline(clock_timestamp() - interval '1 second')`),
    /billing_finance_ops_deadline_passed/,
  );
  await assert.rejects(
    prisma.$executeRawUnsafe(`SELECT billing_finance_ops_assert_deadline(NULL)`),
    /billing_finance_ops_deadline_passed/,
  );
});

// docs/policy/billing-finance-ops.md §1.4: the two retention batches. A row's
// clock columns are immutable through the application, so the test backdates
// them with the update trigger disabled -- the only way to make a row old
// without waiting a year.
const backdate = async (id: string, days: number) => {
  await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" DISABLE TRIGGER "AgentDigestItem_before_update"`);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "AgentDigestItem"
         SET "createdAt" = "createdAt" - make_interval(days => $2::int),
             "retentionUntil" = "retentionUntil" - make_interval(days => $2::int)
       WHERE "id" = $1::uuid`,
      id,
      days,
    );
  } finally {
    await prisma.$executeRawUnsafe(`ALTER TABLE "AgentDigestItem" ENABLE TRIGGER "AgentDigestItem_before_update"`);
  }
};

test("body expiry clears only bodies past their retention, stamps the deletion, and audits the batch", async () => {
  const expired = await recordAgentDigestItem(submission({ n: 1 }));
  const fresh = await recordAgentDigestItem(submission({ n: 2 }));
  assert.equal(expired.status, "created");
  assert.equal(fresh.status, "created");
  if (expired.status !== "created" || fresh.status !== "created") return;
  createdIds.push(expired.id, fresh.id);
  await backdate(expired.id, 91);

  const result = await expireAgentDigestBodies();
  assert.ok(result.expired >= 1);

  const gone = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: expired.id } });
  assert.equal(gone.payload, null);
  assert.ok(gone.bodyDeletedAt);
  assert.equal(gone.payloadSha256, expired.payloadSha256);
  const kept = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: fresh.id } });
  assert.notEqual(kept.payload, null);

  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "agent_digest.bodies_expired" },
    orderBy: { createdAt: "desc" },
  });
  const metadata = audit.metadata as Record<string, unknown>;
  assert.equal(metadata.systemActor, "agent-digest-retention");
  assert.equal(metadata.expired, result.expired);
});

test("the meta purge deletes only rows whose body is gone and whose 365 days are up", async () => {
  const old = await recordAgentDigestItem(submission({ n: 3 }));
  const bodied = await recordAgentDigestItem(submission({ n: 4 }));
  const young = await recordAgentDigestItem(submission({ n: 5 }));
  if (old.status !== "created" || bodied.status !== "created" || young.status !== "created") throw new Error("setup");
  createdIds.push(old.id, bodied.id, young.id);
  await backdate(old.id, 400);
  await backdate(bodied.id, 400);
  await backdate(young.id, 100);
  // The first and the third lose their bodies. The second keeps its body and
  // the third is only 100 days old, so both must survive the purge.
  await prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "payload" = NULL WHERE "id" = $1::uuid`, old.id);
  await prisma.$executeRawUnsafe(`UPDATE "AgentDigestItem" SET "payload" = NULL WHERE "id" = $1::uuid`, young.id);

  const result = await purgeAgentDigestMeta();
  assert.ok(result.purged >= 1);
  assert.equal(await prisma.agentDigestItem.count({ where: { id: old.id } }), 0);
  assert.equal(await prisma.agentDigestItem.count({ where: { id: bodied.id } }), 1);
  const youngRow = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: young.id } });
  assert.ok(youngRow.bodyDeletedAt, "the young row's body is gone");

  const audit = await prisma.adminAuditLog.findFirstOrThrow({
    where: { action: "agent_digest.meta_purged" },
    orderBy: { createdAt: "desc" },
  });
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "agent-digest-retention");
});

// docs/policy/sre-ops.md §1 item 3, §10: the registration migration widens the
// CHECKs and the retention CASE for sre-ops. Its daily_digest row is accepted
// with a 90-day body and recorded by the agent's one listed actor; another
// agent's kind under sre-ops is refused by the database itself.
test("sre-ops is registered with its kind, retention and intake actor", async () => {
  const result = await recordAgentDigestItem({
    agentKey: "sre-ops",
    kind: "daily_digest",
    schemaVersion: 1,
    idempotencyKey: `sre-ops:test:${randomUUID()}`,
    payload: { verdict: "quiet", items: [] },
  });
  assert.equal(result.status, "created");
  if (result.status !== "created") return;
  createdIds.push(result.id);

  const row = await prisma.agentDigestItem.findUniqueOrThrow({ where: { id: result.id } });
  assert.equal(row.retentionUntil.getTime() - row.createdAt.getTime(), 90 * 86_400_000);
  const audit = await prisma.adminAuditLog.findUniqueOrThrow({ where: { id: result.auditLogId } });
  assert.equal((audit.metadata as Record<string, unknown>).systemActor, "ops-observer");

  await assert.rejects(
    prisma.$executeRawUnsafe(
      `INSERT INTO "AgentDigestItem" ("id", "agentKey", "kind", "schemaVersion", "idempotencyKey", "payload", "payloadSha256", "sizeBytes")
       VALUES ($1::uuid, 'sre-ops', 'price_deadline_digest', 1, $2, '{}'::jsonb, $3, 2)`,
      randomUUID(),
      `sre-ops:test:${randomUUID()}`,
      "0".repeat(64),
    ),
    /AgentDigestItem_kind_check/,
  );
});

// A caller whose policy fixes its own limits (docs/policy/sre-ops.md §6): its
// arming replaces the shared defaults as the transaction's first statement,
// and what it armed holds for the rest of the transaction.
test("a caller's own limits arm the transaction first, in place of the defaults", async () => {
  const seen: string[] = [];
  const result = await recordAgentDigestItem(
    {
      agentKey: "sre-ops",
      kind: "daily_digest",
      schemaVersion: 1,
      idempotencyKey: `sre-ops:test:${randomUUID()}`,
      payload: { verdict: "quiet", items: [] },
    },
    undefined,
    async (tx) => {
      const [row] = await tx.$queryRaw<{ timeout: string }[]>`SELECT current_setting('statement_timeout') AS timeout`;
      seen.push(`admit:${row.timeout}`);
      return null;
    },
    undefined,
    {
      arm: async (tx) => {
        seen.push("arm");
        await tx.$executeRaw`SELECT set_config('statement_timeout', '1234', true)`;
      },
      prismaTimeoutMs: 55_000,
    },
  );
  assert.equal(result.status, "created");
  if (result.status === "created") createdIds.push(result.id);
  // The arming ran, and before anything the caller sees: the default 2 s is not in force.
  assert.deepEqual(seen, ["arm", "admit:1234ms"]);
});
