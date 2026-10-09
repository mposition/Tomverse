import assert from "node:assert/strict";
import { resolve } from "node:path";
import test, { mock } from "node:test";
import { pathToFileURL } from "node:url";

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const buckets = new Map<string, bigint>();
const holds = new Set<string>();
const events: string[] = [];
let dbNow = new Date("2026-10-08T13:59:59.999Z");

const tx = {
  async $queryRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    const sql = strings.join("?");
    if (sql.includes("transaction_timestamp()")) {
      return [{ dbNow }];
    }
    assert.match(sql, /INSERT INTO "PromptRefinerAutoBudgetWindow"/);
    const key = `${values[0]}:${(values[1] as Date).toISOString()}`;
    const current = buckets.get(key) ?? 0n;
    const amount = values[2] as bigint;
    const limitMinusAmount = values[4] as bigint;
    events.push(`book:${values[0]}`);
    if (current > limitMinusAmount) return [];
    buckets.set(key, current + amount);
    return [{ count: current + amount }];
  },
  async $executeRaw(strings: TemplateStringsArray, ...values: unknown[]) {
    assert.match(strings.join("?"), /INSERT INTO "PromptRefinerAutoBudgetHold"/);
    const requestKey = values[1] as string;
    if (holds.has(requestKey)) throw new Error("duplicate_request_key");
    holds.add(requestKey);
    events.push("hold");
    return 1;
  },
};
const fakePrisma = {
  async $transaction<T>(work: (client: typeof tx) => Promise<T>): Promise<T> {
    const priorBuckets = new Map(buckets);
    const priorHolds = new Set(holds);
    try { return await work(tx); }
    catch (error) {
      buckets.clear();
      for (const [key, value] of priorBuckets) buckets.set(key, value);
      holds.clear();
      for (const key of priorHolds) holds.add(key);
      throw error;
    }
  },
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: fakePrisma } });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  writeSystemAuditLog: async (input: { tx: unknown; systemActor: string }) => {
    assert.equal(input.tx, tx); events.push("audit_write");
    assert.equal(input.systemActor, "prompt-refiner-auto-budget");
    return `audit-${events.filter((event) => event === "audit_write").length}`;
  },
} });

const load = () => import(mod("lib/promptRefinerAutoBudgetHold.ts"));
const binding = (requestKey: string) => ({
  requestKey, candidateDigest: "a".repeat(64),
  pricePinDigest: "b".repeat(64),
  runtimeDeploymentId: "11111111-1111-4111-8111-111111111111",
});
const key = (ordinal: number) => `00000000-0000-4000-8000-${String(ordinal).padStart(12, "0")}`;
const clear = () => { buckets.clear(); holds.clear(); events.length = 0; };

test("Brisbane day and month boundaries use the DB instant", async () => {
  const budget = await load();
  const before = budget.promptRefinerAutoBudgetWindows(
    new Date("2026-10-31T13:59:59.999Z"));
  const after = budget.promptRefinerAutoBudgetWindows(
    new Date("2026-10-31T14:00:00.000Z"));
  assert.equal(before.dayStart.toISOString(), "2026-10-30T14:00:00.000Z");
  assert.equal(before.monthStart.toISOString(), "2026-09-30T14:00:00.000Z");
  assert.equal(after.dayStart.toISOString(), "2026-10-31T14:00:00.000Z");
  assert.equal(after.monthStart.toISOString(), "2026-10-31T14:00:00.000Z");
});

test("the product hold books day and month with its audit in one transaction", async () => {
  const budget = await load();
  clear(); dbNow = new Date("2026-10-08T13:59:59.999Z");
  const result = await budget.reservePromptRefinerAutoBudget(binding(key(1)) as never);
  assert.equal(result.reservedMicroUsd, 29_918n);
  assert.equal(result.dispatchAuthorized, false);
  assert.deepEqual(events, ["book:brisbane_day",
    "book:brisbane_month", "audit_write", "hold"]);
  assert.deepEqual([...buckets.values()], [29_918n, 29_918n]);
  await assert.rejects(budget.reservePromptRefinerAutoBudget(binding(key(1)) as never),
    /duplicate_request_key/);
  assert.deepEqual([...buckets.values()], [29_918n, 29_918n],
    "duplicate request cannot spend both windows twice");
});

test("a refused month rolls back the day and does not create a hold", async () => {
  const budget = await load();
  clear(); dbNow = new Date("2026-10-08T13:59:59.999Z");
  const windows = budget.promptRefinerAutoBudgetWindows(dbNow);
  buckets.set(`brisbane_month:${windows.monthStart.toISOString()}`,
    budget.PROMPT_REFINER_AUTO_MONTH_LIMIT_MICRO_USD);
  await assert.rejects(budget.reservePromptRefinerAutoBudget(binding(key(2)) as never),
    /budget_exhausted/);
  assert.equal(buckets.has(`brisbane_day:${windows.dayStart.toISOString()}`), false);
  assert.equal(holds.size, 0);
  assert.equal(events.includes("audit_write"), false);
});

test("an exhausted Brisbane day refuses before booking the month or audit", async () => {
  const budget = await load();
  clear(); dbNow = new Date("2026-10-08T13:59:59.999Z");
  const windows = budget.promptRefinerAutoBudgetWindows(dbNow);
  buckets.set(`brisbane_day:${windows.dayStart.toISOString()}`,
    budget.PROMPT_REFINER_AUTO_DAY_LIMIT_MICRO_USD);
  await assert.rejects(budget.reservePromptRefinerAutoBudget(binding(key(3)) as never),
    /budget_exhausted/);
  assert.equal(buckets.get(`brisbane_day:${windows.dayStart.toISOString()}`),
    budget.PROMPT_REFINER_AUTO_DAY_LIMIT_MICRO_USD);
  assert.equal(buckets.has(`brisbane_month:${windows.monthStart.toISOString()}`), false);
  assert.equal(holds.size, 0);
  assert.equal(events.includes("audit_write"), false);
});

test("invalid pins stop before either window or audit is touched", async () => {
  const budget = await load();
  clear();
  await assert.rejects(budget.reservePromptRefinerAutoBudget({
    ...binding(key(4)), candidateDigest: "unverified",
  } as never), /binding_invalid/);
  await assert.rejects(budget.reservePromptRefinerAutoBudget(binding("user-supplied")),
    /binding_invalid/);
  assert.deepEqual(events, []);
  assert.equal(buckets.size, 0);
});
