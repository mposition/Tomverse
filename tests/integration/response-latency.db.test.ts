import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";

const testUrl = process.env.RESPONSE_LATENCY_TEST_DATABASE_URL;
test("latency migration supports idempotent writes and seven-day retention", { skip: !testUrl }, async () => {
  const url = new URL(testUrl!);
  assert.ok(["127.0.0.1", "localhost"].includes(url.hostname), "Use an isolated local database");
  process.env.DATABASE_URL = testUrl;
  process.env.DIRECT_URL = testUrl;
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
