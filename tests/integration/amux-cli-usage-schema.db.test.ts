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
  contextKind: "worker" | "idea_analysis";
  workerRole: string;
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
  contextKind: "worker",
  workerRole: "review",
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
      "invocationId", "contextKind", "workerRole", "cardId", "taskId", "runId", "attemptId", "workerId",
      "ideaId", "chunkIndex", "agentId",
      "cli", "cliVersion", "authKind", "selectedModelId", "startedAt", "endedAt",
      "status", "completeness", "completedTurns", "inputTokens", "outputTokens",
      "cacheReadInputTokens", "cacheCreationInputTokens", "inputTokensIncludeCacheRead",
      "inputTokensIncludeCacheWrite", "reasoningOutputIncludedInOutput", "modelsJson",
      "receiptDigest", "recordedAt"
    ) VALUES (
      ${row.invocationId}::uuid, ${row.contextKind}, ${row.workerRole},
      ${row.contextKind === "worker" ? "card_1" : null},
      ${row.contextKind === "worker" ? "task_1" : null},
      ${row.contextKind === "worker" ? "run_1" : null},
      ${row.contextKind === "worker" ? "attempt_1" : null},
      ${row.contextKind === "worker" ? "worker_1" : null},
      ${row.contextKind === "idea_analysis" ? "idea_1" : null},
      ${row.contextKind === "idea_analysis" ? 0 : null},
      ${row.contextKind === "idea_analysis" ? "amux-intake" : null},
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
      workerRole: string;
    }>>`SELECT "inputTokens", "recordedAt", "modelsJson", "workerRole"
       FROM "AmuxCliUsageInvocation" WHERE "invocationId" = ${row.invocationId}::uuid`;
    assert.equal(stored.length, 1);
    assert.equal(stored[0].inputTokens, null);
    assert.deepEqual(stored[0].modelsJson, []);
    assert.equal(stored[0].workerRole, "review");
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

test("the DB refuses rewriting an invocation-time role snapshot", async () => {
  const row = unknownRow();
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertUsage(tx, row);
    await tx.$executeRaw`
      UPDATE "AmuxCliUsageInvocation" SET "workerRole" = 'implement'
      WHERE "invocationId" = ${row.invocationId}::uuid`;
  }), /immutable/i);
});

test("DB binds the invocation-time role to its worker or idea context", async () => {
  await assert.rejects(insertUsage(prisma, unknownRow({ workerRole: "idea_analysis" })),
    /AmuxCliUsageInvocation_workerRole_context_check/);
  await assert.rejects(insertUsage(prisma, unknownRow({ workerRole: "super_admin" })),
    /AmuxCliUsageInvocation_workerRole_check/);
  const idea = unknownRow({ contextKind: "idea_analysis", workerRole: "idea_analysis" });
  await assert.rejects(prisma.$transaction(async (tx) => {
    await insertUsage(tx, idea);
    const stored = await tx.$queryRaw<Array<{ workerRole: string; contextKind: string }>>`
      SELECT "workerRole", "contextKind" FROM "AmuxCliUsageInvocation"
      WHERE "invocationId" = ${idea.invocationId}::uuid`;
    assert.deepEqual(stored, [{ workerRole: "idea_analysis", contextKind: "idea_analysis" }]);
    throw new Error("synthetic rollback");
  }), /synthetic rollback/);
  await assert.rejects(insertUsage(prisma, unknownRow({
    contextKind: "idea_analysis", workerRole: "review",
  })), /AmuxCliUsageInvocation_workerRole_context_check/);
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

const fenceNamespace = 1095587160;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function withFenceSchema(run: (schema: string) => Promise<void>): Promise<void> {
  // This is a dedicated loopback test DB. The random schema contains only two
  // synthetic tables and is the exact target of the finally cleanup.
  const schema = `amux_cli_fence_${randomUUID().replaceAll("-", "")}`;
  await prisma.$executeRawUnsafe(`CREATE SCHEMA "${schema}"`);
  try {
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."AmuxCliUsageAggregateFinalization"
      ("year" INTEGER NOT NULL, "providerScopeKey" TEXT NOT NULL)`);
    await prisma.$executeRawUnsafe(`CREATE TABLE "${schema}"."AmuxCliUsageInvocation"
      ("recordedAt" TIMESTAMPTZ(3) NOT NULL DEFAULT now())`);
    await prisma.$executeRawUnsafe(`CREATE TRIGGER "AmuxCliUsageInvocation_set_recordedAt"
      BEFORE INSERT ON "${schema}"."AmuxCliUsageInvocation" FOR EACH ROW
      EXECUTE FUNCTION public.amux_cli_usage_set_recorded_at()`);
    await run(schema);
  } finally {
    await prisma.$executeRawUnsafe(`DROP SCHEMA "${schema}" CASCADE`);
  }
}

async function waitForAdvisoryWait(year: number): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const locks = await prisma.$queryRaw<Array<{ waiting: bigint }>>`
      SELECT count(*) AS waiting FROM pg_locks
      WHERE locktype = 'advisory' AND classid = ${fenceNamespace}::oid
        AND objid = ${year}::oid AND granted IS FALSE`;
    if ((locks[0]?.waiting ?? BigInt(0)) > BigInt(0)) return;
    await sleep(40);
  }
  throw new Error("the second connection never waited on the advisory year lock");
}

test("a committed seal makes a waiting READ COMMITTED receipt fail", async () => {
  await withFenceSchema(async (schema) => {
    const year = new Date().getUTCFullYear();
    let sealReady = false;
    let releaseSeal!: () => void;
    let signalSealed!: () => void;
    const holdSeal = new Promise<void>((resolve) => { releaseSeal = resolve; });
    const sealed = new Promise<void>((resolve) => { signalSealed = resolve; });
    const seal = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${fenceNamespace},
        ${year})::TEXT AS locked`;
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."AmuxCliUsageAggregateFinalization"
        ("year", "providerScopeKey") VALUES (${year}, 'actualProviderUnknown')`);
      sealReady = true;
      signalSealed();
      await holdSeal;
    }, { timeout: 10_000 }).then(() => null, (error: unknown) => {
      signalSealed();
      return error;
    });
    await sealed;
    assert.equal(sealReady, true);
    const late = prisma.$executeRawUnsafe(
      `INSERT INTO "${schema}"."AmuxCliUsageInvocation" DEFAULT VALUES`,
    ).then(() => null, (error: unknown) => error);
    try {
      await waitForAdvisoryWait(year);
    } finally {
      releaseSeal();
    }
    assert.equal(await seal, null);
    assert.match(String(await late), /AMUX CLI usage year has an immutable finalization/);
    const rows = await prisma.$queryRawUnsafe<Array<{ count: bigint }>>(
      `SELECT count(*) AS count FROM "${schema}"."AmuxCliUsageInvocation"`,
    );
    assert.equal(rows[0].count, BigInt(0));
  });
});

test("a committed receipt is visible to the finalizer after its exclusive lock", async () => {
  await withFenceSchema(async (schema) => {
    const year = new Date().getUTCFullYear();
    let receiptReady = false;
    let releaseReceipt!: () => void;
    let signalInserted!: () => void;
    const holdReceipt = new Promise<void>((resolve) => { releaseReceipt = resolve; });
    const inserted = new Promise<void>((resolve) => { signalInserted = resolve; });
    const receipt = prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."AmuxCliUsageInvocation"
        DEFAULT VALUES`);
      receiptReady = true;
      signalInserted();
      await holdReceipt;
    }, { timeout: 10_000 }).then(() => null, (error: unknown) => {
      signalInserted();
      return error;
    });
    await inserted;
    assert.equal(receiptReady, true);
    const finalizer = prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(${fenceNamespace},
        ${year})::TEXT AS locked`;
      return tx.$queryRawUnsafe<Array<{ count: bigint }>>(
        `SELECT count(*) AS count FROM "${schema}"."AmuxCliUsageInvocation"`,
      );
    }, { timeout: 10_000 }).then((rows) => ({ rows, error: null }),
      (error: unknown) => ({ rows: null, error }));
    try {
      await waitForAdvisoryWait(year);
    } finally {
      releaseReceipt();
    }
    assert.equal(await receipt, null);
    const outcome = await finalizer;
    assert.equal(outcome.error, null);
    assert.equal(outcome.rows?.[0].count, BigInt(1));
  });
});

test("the trigger rejects repeatable-read and keeps a UTC instant under a non-UTC session", async () => {
  await withFenceSchema(async (schema) => {
    await assert.rejects(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."AmuxCliUsageInvocation"
        DEFAULT VALUES`);
    }, { isolationLevel: "RepeatableRead" }), /requires READ COMMITTED/);
    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SET LOCAL TIME ZONE 'Pacific/Kiritimati'`;
      await tx.$executeRawUnsafe(`INSERT INTO "${schema}"."AmuxCliUsageInvocation"
        DEFAULT VALUES`);
      const rows = await tx.$queryRawUnsafe<Array<{ recordedAt: Date }>>(
        `SELECT "recordedAt" FROM "${schema}"."AmuxCliUsageInvocation"`,
      );
      assert.equal(rows[0].recordedAt.getUTCFullYear(), new Date().getUTCFullYear());
      const locks = await tx.$queryRaw<Array<{ objid: bigint }>>`
        SELECT objid::BIGINT AS objid FROM pg_locks
        WHERE locktype = 'advisory' AND classid = ${fenceNamespace}::oid
          AND pid = pg_backend_pid() AND granted IS TRUE`;
      assert.ok(locks.some((row) => row.objid === BigInt(rows[0].recordedAt.getUTCFullYear())));
    });
  });
});
