import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";

const runnerTestUrl = process.env.TEST_DATABASE_URL?.trim();
const standaloneTestUrl = process.env.AMUX_CLI_USAGE_TEST_DATABASE_URL?.trim();
const testUrl = runnerTestUrl || standaloneTestUrl;
const url = testUrl ? new URL(testUrl) : null;
if (!url || !["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/^\/[A-Za-z0-9_-]+(?:[_-]test[0-9]*)$/i.test(url.pathname) ||
    url.search !== "" || url.hash !== "" ||
    (runnerTestUrl && standaloneTestUrl && runnerTestUrl !== standaloneTestUrl) ||
    process.env.DATABASE_URL !== testUrl ||
    (process.env.DIRECT_DATABASE_URL && process.env.DIRECT_DATABASE_URL !== testUrl)) {
  throw new Error("REFUSE: AMUX CLI usage schema test needs a dedicated loopback test database");
}

after(async () => { await prisma.$disconnect(); });

type UsageRow = {
  invocationId: string;
  cli: "codex" | "claude";
  selectedModelId: string;
  status: "succeeded" | "failed";
  completeness: "unknown" | "reported_partial" | "reported_complete";
  completedTurns: number;
  inputTokens: bigint | null;
  outputTokens: bigint | null;
  cacheReadInputTokens: bigint | null;
  cacheCreationInputTokens: bigint | null;
  inputTokensIncludeCacheRead: boolean;
  inputTokensIncludeCacheWrite: boolean | null;
  reasoningOutputIncludedInOutput: boolean | null;
  modelsJson: string;
};

const unknownRow = (overrides: Partial<UsageRow> = {}): UsageRow => ({
  invocationId: randomUUID(),
  cli: "codex",
  selectedModelId: "gpt-6-sol",
  status: "failed",
  completeness: "unknown",
  completedTurns: 0,
  inputTokens: null,
  outputTokens: null,
  cacheReadInputTokens: null,
  cacheCreationInputTokens: null,
  inputTokensIncludeCacheRead: true,
  inputTokensIncludeCacheWrite: null,
  reasoningOutputIncludedInOutput: true,
  modelsJson: "[]",
  ...overrides,
});

async function insertUsage(tx: Prisma.TransactionClient, row: UsageRow): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "AmuxCliUsageInvocation" (
      "invocationId", "contextKind", "cardId", "taskId", "runId", "attemptId", "workerId",
      "cli", "cliVersion", "authKind", "selectedModelId", "startedAt", "endedAt",
      "status", "completeness", "completedTurns", "inputTokens", "outputTokens",
      "cacheReadInputTokens", "cacheCreationInputTokens", "inputTokensIncludeCacheRead",
      "inputTokensIncludeCacheWrite", "reasoningOutputIncludedInOutput", "modelsJson",
      "receiptDigest", "recordedAt"
    ) VALUES (
      ${row.invocationId}::uuid, 'worker', 'card_1', 'task_1', 'run_1', 'attempt_1', 'worker_1',
      ${row.cli}, '1.2.3', 'subscription', ${row.selectedModelId}, now(), now(),
      ${row.status}, ${row.completeness}, ${row.completedTurns}, ${row.inputTokens},
      ${row.outputTokens}, ${row.cacheReadInputTokens}, ${row.cacheCreationInputTokens},
      ${row.inputTokensIncludeCacheRead}, ${row.inputTokensIncludeCacheWrite},
      ${row.reasoningOutputIncludedInOutput}, ${row.modelsJson}::jsonb,
      ${"a".repeat(64)}, '2020-01-01T00:00:00Z'::timestamptz
    )`;
}

test("DB owns the immutable clock and retains unknown as NULL", async () => {
  const row = unknownRow();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertUsage(tx, row);
    const stored = await tx.$queryRaw<Array<{
      inputTokens: bigint | null; recordedAt: Date; modelsJson: unknown;
    }>>`SELECT "inputTokens", "recordedAt", "modelsJson"
       FROM "AmuxCliUsageInvocation" WHERE "invocationId" = ${row.invocationId}::uuid`;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].inputTokens, null);
    assert.deepEqual(stored[0].modelsJson, []);
    assert.ok(stored[0].recordedAt.getTime() > Date.parse("2026-01-01T00:00:00Z"));
    await assert.rejects(tx.$executeRaw`
      UPDATE "AmuxCliUsageInvocation" SET "inputTokens" = 0
      WHERE "invocationId" = ${row.invocationId}::uuid`, /immutable/i);
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  const count = await prisma.$queryRaw<Array<{ count: bigint }>>`
    SELECT count(*) AS count FROM "AmuxCliUsageInvocation"
    WHERE "invocationId" = ${row.invocationId}::uuid`;
  assert.equal(count[0].count, BigInt(0));
});

test("DB rejects path-like model IDs and unknown usage with model detail", async () => {
  await assert.rejects(insertUsage(prisma, unknownRow({ selectedModelId: "./x" })),
    /AmuxCliUsageInvocation_identifiers_check/);
  await assert.rejects(insertUsage(prisma, unknownRow({ modelsJson: JSON.stringify([{
    modelId: "gpt-6-sol", observed: {
      inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0,
      cacheCreationInputTokens: null, reasoningOutputTokens: null,
    },
  }]) })), /AmuxCliUsageInvocation_models_check/);
});

test("DB preserves Claude partial totals without claiming a model breakdown", async () => {
  const row = unknownRow({
    cli: "claude", selectedModelId: "claude-opus-5.5", status: "failed",
    completeness: "reported_partial", completedTurns: 1,
    inputTokens: BigInt(10), outputTokens: BigInt(5), cacheReadInputTokens: BigInt(2),
    cacheCreationInputTokens: BigInt(1), inputTokensIncludeCacheRead: false,
    inputTokensIncludeCacheWrite: false, reasoningOutputIncludedInOutput: null,
  });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertUsage(tx, row);
    const stored = await tx.$queryRaw<Array<{ inputTokens: bigint; modelsJson: unknown }>>`
      SELECT "inputTokens", "modelsJson" FROM "AmuxCliUsageInvocation"
      WHERE "invocationId" = ${row.invocationId}::uuid`;
    assert.equal(stored[0].inputTokens, BigInt(10));
    assert.deepEqual(stored[0].modelsJson, []);
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
});
