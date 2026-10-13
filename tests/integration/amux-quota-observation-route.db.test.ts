import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { GET, POST } from "@/app/api/internal/amux/quota/route";
import { takeAuditChainLock } from "@/lib/adminAudit";
import { prisma, prismaPoolUsage } from "@/lib/prisma";

// The quota route against PostgreSQL. On 2026-10-12 four
// tomverse-amux-v22-bridge@claude-* units halted with
// cause=quota_write_unknown after their quota POSTs answered 500. Each 500
// overlapped another quota POST and took about 230 ms: the route takes the
// global audit chain lock first, and a statement that waits for it is bound by
// the AMUX statement timeout (200 ms). The bridge halts on any answer it cannot
// read as "nothing was written", so every such contention stopped a worker.
// These tests hold the two contended resources for real and pin the answers
// the bridge can act on: 503 with a reason that says nothing committed, and an
// identical replay accepted once the contention is gone.

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

const WORKER = "claude-quota-db-test";
const secret = `amux-test-${randomUUID()}`;
const saved = {
  secret: process.env.TOMVERSE_AMUX_SYNC_SECRET,
  catalog: process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON,
  v22Catalog: process.env.TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON,
};
const restore = (name: string, value: string | undefined) => {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
};

before(() => {
  process.env.TOMVERSE_AMUX_SYNC_SECRET = secret;
  process.env.TOMVERSE_AMUX_WORKER_CATALOG_JSON = JSON.stringify([
    { worker_name: WORKER, provider: "CLAUDE", routing_roles: ["implementation"] },
  ]);
  process.env.TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON = JSON.stringify([
    { worker_name: WORKER, provider: "anthropic", model: "claude-opus-5-5",
      routing_roles: ["investigate"], tool_capabilities: ["repo_read"] },
  ]);
});

after(async () => {
  restore("TOMVERSE_AMUX_SYNC_SECRET", saved.secret);
  restore("TOMVERSE_AMUX_WORKER_CATALOG_JSON", saved.catalog);
  restore("TOMVERSE_AMUX_V22_WORKER_CATALOG_JSON", saved.v22Catalog);
  await prisma.$disconnect();
});

const observation = () => {
  const observedAt = new Date();
  return {
    observation_id: randomUUID(),
    worker: WORKER,
    provider: "anthropic",
    remaining_basis_points: 7400,
    confidence_basis_points: 10_000,
    exhausted: false,
    source: "provider_api",
    observed_at: observedAt.toISOString(),
    reset_at: new Date(observedAt.getTime() + 3_600_000).toISOString(),
  };
};

const post = (body: Record<string, unknown>) =>
  POST(new Request("https://test.invalid/api/internal/amux/quota", {
    method: "POST",
    headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  }));

const lookup = async (observationId: string) =>
  (await GET(new Request(
    `https://test.invalid/api/internal/amux/quota?observation_id=${observationId}`,
    { headers: { Authorization: `Bearer ${secret}` } },
  ))).json();

/** Holds `work`'s transaction open until `release` resolves. */
const holdTransaction = (
  work: (tx: Parameters<Parameters<typeof prisma.$transaction>[0]>[0]) => Promise<unknown>,
  release: Promise<void>,
) => {
  let started!: () => void;
  const ready = new Promise<void>((resolve) => { started = resolve; });
  const done = prisma.$transaction(async (tx) => {
    await work(tx);
    started();
    await release;
  }, { maxWait: 10_000, timeout: 20_000 });
  return { ready, done };
};

const releaseAfter = () => {
  let release!: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  return { released, release };
};

test("a quota write that waits too long for the audit chain lock answers deadline exceeded and writes nothing", async () => {
  const body = observation();
  const { released, release } = releaseAfter();
  const holder = holdTransaction((tx) => takeAuditChainLock(tx), released);
  await holder.ready;
  let response: Response;
  try {
    // The lock stays held well past the 200 ms statement timeout.
    response = await post(body);
  } finally {
    release();
    await holder.done;
  }
  assert.equal(response.status, 503);
  assert.equal((await response.json()).reason, "amux_database_deadline_exceeded");
  assert.deepEqual(await lookup(body.observation_id), { found: false });

  // Nothing was written, so the identical observation is simply recorded now.
  const replay = await post(body);
  assert.equal(replay.status, 200);
  assert.deepEqual(
    { ...(await replay.json()), created_at: undefined },
    { accepted: true, observation_id: body.observation_id, created_at: undefined },
  );
  assert.equal((await lookup(body.observation_id)).found, true);
});

test("a quota write that never got a pool connection answers database busy and writes nothing", async () => {
  const body = observation();
  const { released, release } = releaseAfter();
  // Occupy every connection of this process's pool for longer than the
  // route's connection wait (2 s), as web traffic did on 2026-10-12 13:01Z.
  const holders: Array<ReturnType<typeof holdTransaction>> = [];
  for (let index = 0; index < 32; index += 1) {
    const usage = prismaPoolUsage();
    if (usage.total > 0 && usage.idle === 0 && usage.waiting > 0) break;
    holders.push(holdTransaction((tx) => tx.$queryRaw`SELECT 1`, released));
    await delay(25);
  }
  await Promise.race([
    Promise.all(holders.slice(0, -1).map((holder) => holder.ready)),
    delay(5_000),
  ]);
  let response: Response;
  try {
    response = await post(body);
  } finally {
    release();
    await Promise.allSettled(holders.map((holder) => holder.done));
  }
  assert.equal(response.status, 503);
  assert.equal(response.headers.get("x-amux-incident-id"), null);
  assert.equal((await response.json()).reason, "amux_database_busy");
  assert.deepEqual(await lookup(body.observation_id), { found: false });

  const replay = await post(body);
  assert.equal(replay.status, 200);
  assert.equal((await replay.json()).accepted, true);
});
