import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Owner decision 2026-11-10: the owner accepts that one ended v22 attempt's
// CLI usage stays unknown. The acceptance is owner-only and re-authenticated,
// is written in the transaction of its own audit, and changes no cost.

const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
type Row = Record<string, unknown>;

const world = {
  role: "owner" as string, reauth: true, task: { id: "task-1", sourceSystem: "admin-idea-v4" } as Row | null,
  unknown: ["attempt-1"] as string[], acceptances: [] as Row[], audits: [] as Row[],
  attempt: { worker: "codex-impl", outcome: "blocked", reason: "usage_outcome_unknown",
    reservedCostMicrousd: BigInt(4_100_000), settledCostMicrousd: null, costConfirmed: false,
    cliUsageEvents: [] as Row[] },
  locked: [] as unknown[], txOpen: false, chainLocked: 0, order: [] as string[],
};
function reset() {
  world.role = "owner"; world.reauth = true;
  world.task = { id: "task-1", sourceSystem: "admin-idea-v4" };
  world.unknown = ["attempt-1"]; world.acceptances = []; world.audits = []; world.locked = [];
  world.chainLocked = 0; world.order = [];
}
const tx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("FOR UPDATE")) {
      world.order.push("task"); world.locked.push(values[0]); return [{ id: values[0] }];
    }
    if (sql.includes("clock_timestamp")) return [{ now: new Date("2026-11-10T00:00:00.000Z") }];
    if (sql.includes('"AmuxV22AttemptUsageAcceptance" x')) return world.unknown.map((id) => ({ id }));
    throw new Error(`unexpected SQL: ${sql}`);
  },
  amuxWorkItem: { findUnique: async ({ where }: { where: Row }) =>
    world.task ? { ...world.task, id: where.id } : null },
  amuxV22AttemptUsageAcceptance: {
    findUnique: async ({ where }: { where: Row }) =>
      world.acceptances.find((row) => row.attemptId === where.attemptId) ?? null,
    createMany: async ({ data }: { data: Row[] }) => {
      assert.equal(world.txOpen, true, "acceptance is written inside the audit's transaction");
      world.acceptances.push(...data); return { count: data.length };
    },
  },
  amuxExecutionAttempt: { findUniqueOrThrow: async () => world.attempt },
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {
  $transaction: async (callback: (client: typeof tx) => Promise<unknown>) => {
    const saved = { acceptances: [...world.acceptances], audits: [...world.audits] };
    world.txOpen = true;
    try { return await callback(tx); }
    catch (error) { world.acceptances = saved.acceptances; world.audits = saved.audits; throw error; }
    finally { world.txOpen = false; }
  },
} } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async (client: unknown) => {
    assert.equal(client, tx); world.order.push("audit-chain"); world.chainLocked += 1;
  },
  writeAdminAuditLog: async (input: Row) => {
    assert.equal(input.tx, tx, "the audit uses the caller's transaction");
    const id = `audit-${world.audits.length + 1}`;
    world.audits.push({ ...input, id }); return id;
  },
} });
mock.module(mod("lib/adminAuth.ts"), { namedExports: {
  isAdminSession: () => true, getAdminRole: () => world.role,
} });
mock.module(mod("lib/adminReauthentication.ts"), { namedExports: {
  assertRecentAdminAuthentication: async () => {
    if (!world.reauth) throw new Error("reauth required");
  },
} });

const session = { user: { id: "owner-1", email: "owner@example.test" }, expires: "2099-01-01T00:00:00.000Z" };
const request = new Request("https://example.test/api/admin/amux/execution-usage-acceptance", { method: "POST" });
const load = () => import(mod("lib/amux/v22AttemptUsageAcceptance.ts"));

test("the owner's acceptance is audited with the attempt's unchanged cost and recorded in the same transaction", async () => {
  reset();
  const { acceptAmuxV22AttemptUnknownUsage, AMUX_V22_USAGE_ACCEPTED_ACTION } = await load();
  const result = await acceptAmuxV22AttemptUnknownUsage({ session: session as never, request,
    taskId: "task-1", attemptId: "attempt-1" });
  assert.equal(result.accepted, true); assert.equal(result.alreadyAccepted, false);
  assert.deepEqual(world.locked, ["task-1"]);
  // The audit chain lock comes before the Task row (review r-20261110-000809-a46dad).
  assert.deepEqual(world.order, ["audit-chain", "task"]);
  assert.equal(world.audits.length, 1);
  const audit = world.audits[0]!;
  assert.equal(audit.action, AMUX_V22_USAGE_ACCEPTED_ACTION);
  assert.equal(audit.targetType, "AmuxExecutionAttempt"); assert.equal(audit.targetId, "attempt-1");
  const metadata = audit.metadata as Row;
  assert.equal(metadata.taskId, "task-1");
  assert.equal(metadata.reservedCostMicrousd, "4100000");
  assert.equal(metadata.settledCostMicrousd, null);
  assert.equal(metadata.costConfirmed, false);
  assert.equal(metadata.costChanged, false);
  assert.equal(world.acceptances.length, 1);
  assert.deepEqual({ ...world.acceptances[0], id: undefined }, { id: undefined, attemptId: "attempt-1",
    taskId: "task-1", source: "owner_accept", acceptedByUserId: "owner-1",
    authorizationAuditLogId: "audit-1", acceptedAt: new Date("2026-11-10T00:00:00.000Z") });
});

test("a repeated acceptance is a read-back: no second audit or row", async () => {
  reset();
  const { acceptAmuxV22AttemptUnknownUsage } = await load();
  const input = { session: session as never, request, taskId: "task-1", attemptId: "attempt-1" };
  await acceptAmuxV22AttemptUnknownUsage(input);
  world.unknown = [];
  const again = await acceptAmuxV22AttemptUnknownUsage(input);
  assert.equal(again.alreadyAccepted, true); assert.equal(again.source, "owner_accept");
  assert.equal(world.audits.length, 1); assert.equal(world.acceptances.length, 1);
  // The same attempt named under another Task is refused.
  await assert.rejects(acceptAmuxV22AttemptUnknownUsage({ ...input, taskId: "task-2" }),
    (error: { code?: string }) => error.code === "attempt_unavailable");
});

test("only an ended attempt with unknown usage on a v4 Task can be accepted", async () => {
  reset();
  const { acceptAmuxV22AttemptUnknownUsage } = await load();
  const input = { session: session as never, request, taskId: "task-1", attemptId: "attempt-2" };
  await assert.rejects(acceptAmuxV22AttemptUnknownUsage(input),
    (error: { code?: string }) => error.code === "usage_not_unknown");
  world.task = { id: "task-1", sourceSystem: "admin-workboard" };
  await assert.rejects(acceptAmuxV22AttemptUnknownUsage({ ...input, attemptId: "attempt-1" }),
    (error: { code?: string }) => error.code === "task_unavailable");
  assert.equal(world.audits.length, 0); assert.equal(world.acceptances.length, 0);
});

test("a non-owner or a stale sign-in records nothing", async () => {
  reset();
  const { acceptAmuxV22AttemptUnknownUsage } = await load();
  const input = { session: session as never, request, taskId: "task-1", attemptId: "attempt-1" };
  world.role = "admin";
  await assert.rejects(acceptAmuxV22AttemptUnknownUsage(input),
    (error: { code?: string }) => error.code === "forbidden");
  world.role = "owner"; world.reauth = false;
  await assert.rejects(acceptAmuxV22AttemptUnknownUsage(input), /reauth required/);
  assert.equal(world.audits.length, 0); assert.equal(world.acceptances.length, 0);
  assert.deepEqual(world.locked, []);
});
