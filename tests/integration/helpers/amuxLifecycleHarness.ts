import assert from "node:assert/strict";
import { PrismaClient, type Prisma } from "@prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { Pool } from "pg";

import { resolvePostgresConnectionConfig } from "@/lib/postgresConnectionConfigCore.mjs";

/**
 * One card's whole lifecycle in one test, against PostgreSQL with every
 * migration trigger installed, through the product's own services.
 *
 * The services open their own transactions on the shared `prisma` client, so a
 * test could only chain them over committed rows, which it then had to clean
 * up with triggers off. This harness makes the shared client a view of ONE
 * outer transaction instead: `lib/prisma.ts` takes `globalThis.prisma` when it
 * is set, so the harness sets it, before any service module is imported, to a
 * proxy that
 *
 * - outside a lifecycle is the real client;
 * - inside one answers every read and write on the lifecycle's transaction,
 *   and runs a service's `$transaction(fn)` as a SAVEPOINT in it: released when
 *   `fn` returns, rolled back to when it throws, as that service's own
 *   transaction would commit or roll back. Before the release every deferred
 *   constraint is checked (`SET CONSTRAINTS ALL IMMEDIATE`), which is what a
 *   commit does, so a write production would refuse at commit is refused here.
 *
 * The lifecycle's outer transaction always rolls back: nothing a test writes
 * outlives it, and one fixture can be the same card in every test.
 *
 * What it does not reproduce: two transactions racing, and checks that compare
 * a row's transaction id with the current one (every write here shares one
 * id, so such a check can only pass more easily, never fail wrongly). Those
 * stay with the focused suites.
 *
 * Import this module FIRST and load service modules with `await import(...)`
 * after it; a static import of a service would create the real client before
 * the proxy is in place.
 */

const testRaw = process.env.TEST_DATABASE_URL?.trim();
if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
  throw new Error("REFUSE: DATABASE_URL must equal TEST_DATABASE_URL for this DB test");
}
{
  const url = new URL(testRaw);
  if (!(url.searchParams.get("schema") === "tomverse_amux_test" ||
    (decodeURIComponent(url.pathname.replace(/^\/+/, "")) === "tomverse_test" &&
      ["127.0.0.1", "localhost"].includes(url.hostname)))) {
    throw new Error("REFUSE: AMUX DB tests require the dedicated AMUX schema or the local canonical test database");
  }
}
if ((globalThis as { prisma?: unknown }).prisma !== undefined) {
  throw new Error("REFUSE: the lifecycle harness must be imported before lib/prisma.ts is loaded");
}

const config = resolvePostgresConnectionConfig(testRaw, { requireTestMarker: true });
const pool = new Pool({ connectionString: config.connectionString, options: config.poolOptions });
const real = new PrismaClient({
  adapter: new PrismaPg(pool, config.schema ? { schema: config.schema } : undefined) });

export type LifecycleTx = Prisma.TransactionClient;

let bound: LifecycleTx | null = null;
let savepoints = 0;

/** What a commit checks, then deferral again for the next nested transaction. */
async function commitBoundary(tx: LifecycleTx) {
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL DEFERRED");
}

async function nested<T>(tx: LifecycleTx, work: (tx: LifecycleTx) => Promise<T>): Promise<T> {
  const name = `lifecycle_${(savepoints += 1)}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    const result = await work(tx);
    await commitBoundary(tx);
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    return result;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    throw error;
  }
}

const proxy = new Proxy(real, {
  get(target, property) {
    const tx = bound;
    if (tx === null) {
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    }
    if (property === "$transaction") {
      return (work: unknown) => {
        if (typeof work !== "function") throw new Error("the lifecycle harness runs interactive transactions only");
        return nested(tx, work as (tx: LifecycleTx) => Promise<unknown>);
      };
    }
    if (property === "$disconnect" || property === "$connect") return async () => {};
    return Reflect.get(tx as object, property, tx);
  },
});
(globalThis as { prisma?: unknown }).prisma = proxy;

const ROLLBACK = new Error("lifecycle rollback");

/**
 * Runs one lifecycle in an outer transaction that always rolls back. `work`
 * gets the transaction for its fixture and its assertions; every service it
 * calls runs inside the same one.
 */
export async function lifecycle(work: (tx: LifecycleTx) => Promise<void>): Promise<void> {
  assert.equal(bound, null, "one lifecycle at a time");
  await assert.rejects(real.$transaction(async (tx) => {
    await tx.$executeRawUnsafe("SET LOCAL TIME ZONE 'UTC'");
    bound = tx;
    try {
      await work(tx);
      // The last service call's deferred checks, and anything the test wrote itself.
      await commitBoundary(tx);
    } finally {
      bound = null;
    }
    throw ROLLBACK;
  }, { timeout: 120_000, maxWait: 10_000 }), (error) => error === ROLLBACK);
}

/**
 * Call once the fixture is in place: what it wrote is checked as a commit
 * checks it, and deferral is put back. A fixture helper may leave some
 * constraint triggers IMMEDIATE (the shared seed does); a service that relies
 * on a deferred check would then be refused mid-transaction, which production
 * never does.
 */
export const fixtureCommitted = (tx: LifecycleTx) => commitBoundary(tx);

/** Rows a fixture has to place past their insert triggers; the lifecycle's own checks stay on. */
export async function withoutTriggers<T>(tx: LifecycleTx, work: () => Promise<T>): Promise<T> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = replica");
  try { return await work(); } finally {
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = origin");
  }
}

/** The fixture helpers' `{ query }` shape over the lifecycle's transaction. */
export function queryAdapter(tx: LifecycleTx) {
  return { query: async (sql: string, params: unknown[] = []) => {
    if (/^\s*SELECT\s+pg_advisory_xact_lock\b/i.test(sql)) {
      const rowCount = await tx.$executeRawUnsafe(sql, ...params);
      return { rows: [], rowCount };
    }
    if (/^\s*SELECT\b|\bRETURNING\b/i.test(sql)) {
      const rows = await tx.$queryRawUnsafe<unknown[]>(sql, ...params);
      return { rows, rowCount: rows.length };
    }
    const rowCount = await tx.$executeRawUnsafe(sql, ...params);
    return { rows: [], rowCount };
  } };
}

export async function closeLifecycleHarness() {
  await real.$disconnect();
  await pool.end().catch(() => {});
}
