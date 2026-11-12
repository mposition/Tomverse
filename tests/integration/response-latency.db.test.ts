import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

async function testPrisma() {
  assert.equal(process.env.NODE_ENV, "test", "Use the DB integration runner");
  const testUrl = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(testUrl, "TEST_DATABASE_URL must name a dedicated test database");
  assert.equal(process.env.DATABASE_URL, testUrl, "The runner must bind the test database");
  const url = new URL(testUrl);
  const marker = `${decodeURIComponent(url.pathname.slice(1))}_${url.searchParams.get("schema") || ""}`;
  assert.match(marker, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i);
  delete process.env.E2E_DISABLE_DATABASE;
  return (await import("../../lib/prisma")).prisma;
}

test("latency migration supports idempotent writes and seven-day retention", async () => {
  const prisma = await testPrisma();
  const { recordResponseLatency, purgeResponseLatencySamples } = await import("../../lib/responseLatencyStore");
  const id = `${randomUUID()}:client`;
  const oldId = `${randomUUID()}:client`;
  const sample = { product: "chat" as const, mode: "auto" as const, source: "client" as const,
    modelId: null, provider: null, outcome: "completed" as const, timings: { firstContentMs: 12 } };
  try {
    await Promise.all([recordResponseLatency(id, sample), recordResponseLatency(id, sample)]);
    assert.equal(await prisma.responseLatencySample.count({ where: { id } }), 1);
    await recordResponseLatency(id, { ...sample, timings: { firstContentMs: 999 } });
    assert.deepEqual((await prisma.responseLatencySample.findUniqueOrThrow({ where: { id } })).timings, { firstContentMs: 12 });
    await recordResponseLatency(oldId, sample);
    const now = new Date();
    await prisma.responseLatencySample.update({ where: { id: oldId }, data: { createdAt: new Date(now.getTime() - 8 * 86_400_000) } });
    await purgeResponseLatencySamples(now);
    assert.equal(await prisma.responseLatencySample.count({ where: { id: oldId } }), 0);
    assert.equal(await prisma.responseLatencySample.count({ where: { id } }), 1);
  } finally {
    await prisma.responseLatencySample.deleteMany({ where: { id: { in: [id, oldId] } } });
    await prisma.$disconnect();
  }
});

test("daily presearch percentiles pair successful attempts and keep missing or failed starts in the ten-second denominator", async () => {
  const prisma = await testPrisma();
  const { readChatPresearchLatency } = await import("../../lib/chatPresearchLatency");
  const now = new Date("2011-01-16T03:00:00.000Z");
  const prefix = randomUUID();
  const sample = (id: string, source: "server" | "client", hoursAgo: number, outcome = "completed",
    timings: Record<string, number> = { presearchMs: 100 }) => ({
    id: `${prefix}-${id}:${source}`, source, product: "chat", mode: "auto", outcome, timings,
    createdAt: new Date(now.getTime() - hoursAgo * 3_600_000),
  });
  const pair = (id: string, hoursAgo: number, completionMs: number, firstContentMs: number) => [
    sample(id, "server", hoursAgo), sample(id, "client", hoursAgo, "completed", { firstContentMs, completionMs }),
  ];
  try {
    await prisma.responseLatencySample.createMany({ data: [
      ...pair("boundary", 24, 10_000, 3_900),
      sample("slow", "server", 1, "completed", { presearchMs: 120, providerToContentMs: 4_000 }),
      sample("slow", "client", 1, "completed", { firstContentMs: 13_000, completionMs: 19_000 }),
      sample("no-first", "server", 1), sample("no-first", "client", 1, "completed", { completionMs: 5_000 }),
      sample("cancel", "server", 1), sample("cancel", "client", 1, "cancelled", { completionMs: 10 }),
      sample("failed", "server", 1, "failed_before_stream"),
      sample("missing", "server", 1),
      sample("wrong-mode", "server", 1), { ...sample("wrong-mode", "client", 1), mode: "manual" },
      ...pair("week-boundary", 168, 3_000, 1_000), ...pair("expired", 169, 3, 1), ...pair("cutoff", 0, 3, 1),
      { ...sample("manual", "server", 1), mode: "manual" },
      { ...sample("review", "server", 1), product: "review" },
      sample("no-search", "server", 1, "completed", { routingMs: 1 }),
    ] });
    const daily = await readChatPresearchLatency(now);
    assert.equal(daily.asOf, now.toISOString());
    const slowStages = { timedSlowCompleted: 1, slowBeforeProviderEstimateP50Ms: 9_000,
      slowProviderToContentP50Ms: 4_000, slowContentToEndP50Ms: 6_000 };
    assert.deepEqual(daily.windows, [
      { hours: 24, serverAttempts: 7, paired: 4, missingClient: 3, failed: 1, cancelled: 1,
        completed: 3, completedWithFirstContent: 2, withinTenSeconds: 1, withinTenSecondsRate: 1 / 7,
        firstP50Ms: 3900, firstP95Ms: 13000, completionP50Ms: 10000, completionP95Ms: 19000, ...slowStages },
      { hours: 168, serverAttempts: 8, paired: 5, missingClient: 3, failed: 1, cancelled: 1,
        completed: 4, completedWithFirstContent: 3, withinTenSeconds: 2, withinTenSecondsRate: 2 / 8,
        firstP50Ms: 3900, firstP95Ms: 13000, completionP50Ms: 5000, completionP95Ms: 19000, ...slowStages },
    ]);
    // Inconsistent clocks must not give just one stage a different cohort.
    await prisma.responseLatencySample.update({ where: { id: `${prefix}-slow:server` },
      data: { timings: { presearchMs: 120, providerToContentMs: 13_001 } } });
    const inconsistent = (await readChatPresearchLatency(now)).windows[0];
    assert.equal(inconsistent.completionP95Ms, 19_000);
    assert.equal(inconsistent.timedSlowCompleted, 0);
    assert.equal(inconsistent.slowBeforeProviderEstimateP50Ms, null);
    assert.equal(inconsistent.slowProviderToContentP50Ms, null);
    assert.equal(inconsistent.slowContentToEndP50Ms, null);
    const empty = await readChatPresearchLatency(new Date("2010-01-01T00:00:00.000Z"));
    assert.equal(empty.windows.length, 2);
    for (const window of empty.windows) {
      assert.equal(window.serverAttempts, 0);
      assert.equal(window.withinTenSecondsRate, null);
      assert.equal(window.completionP95Ms, null);
      assert.equal(window.timedSlowCompleted, 0);
      assert.equal(window.slowBeforeProviderEstimateP50Ms, null);
      assert.equal(window.slowProviderToContentP50Ms, null);
      assert.equal(window.slowContentToEndP50Ms, null);
    }
  } finally {
    await prisma.responseLatencySample.deleteMany({ where: { id: { startsWith: prefix } } });
    await prisma.$disconnect();
  }
});
