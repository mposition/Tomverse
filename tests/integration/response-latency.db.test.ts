import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

test("latency migration supports idempotent writes and seven-day retention", async () => {
  assert.equal(process.env.NODE_ENV, "test", "Use the DB integration runner");
  const testUrl = process.env.TEST_DATABASE_URL?.trim();
  assert.ok(testUrl, "TEST_DATABASE_URL must name a dedicated test database");
  assert.equal(process.env.DATABASE_URL, testUrl, "The runner must bind the test database");
  const url = new URL(testUrl);
  const marker = `${decodeURIComponent(url.pathname.slice(1))}_${url.searchParams.get("schema") || ""}`;
  assert.match(marker, /(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i);
  delete process.env.E2E_DISABLE_DATABASE;
  const { prisma } = await import("../../lib/prisma");
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
