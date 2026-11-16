import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Owner direction 2026-11-15: one refresh pass extends every due Task its
// time budget leaves room for. No per-tick count, no cut of the due list; a
// score past its baseline is due too.

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (relative: string) => pathToFileURL(resolve(ROOT, relative)).href;

type DueRead = { strings: readonly string[]; values: unknown[] };
const reads: DueRead[] = [];
let dueIds: string[] = [];
const written: string[] = [];

const fakeTx = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    if (sql.includes("WITH clock")) {
      reads.push({ strings: [...strings], values });
      return dueIds.map((taskId) => ({ taskId }));
    }
    return [];
  },
};

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });
mock.module(mod("lib/amux/autoPromotionService.ts"), {
  namedExports: {
    TICK_TRANSACTION_LIMITS: {},
    // The read transaction runs its callback on the fake client; each Task's
    // own transaction is answered as refreshed without touching a database,
    // so only the pass's own limits decide how many it writes.
    withAutoTransaction: async (taskId: string | null, _limits: unknown,
      work: (tx: unknown, now: Date, record: () => void) => Promise<unknown>) => {
      if (taskId === null) return work(fakeTx, new Date(), () => {});
      written.push(taskId);
      return { state: "refreshed", taskId, scoreId: `score-${taskId}`,
        activeStaleAt: new Date().toISOString(), baselineStaleAt: new Date().toISOString() };
    },
  },
});

const pass = async (hasBudget?: () => boolean) => {
  reads.length = 0;
  written.length = 0;
  const { refreshDueAmuxPortfolioScores } = await import(mod("lib/amux/portfolioScoreService.ts"));
  return refreshDueAmuxPortfolioScores({
    digestKey: { digestKeyId: "k", digestKey: Buffer.alloc(32) }, hasBudget });
};

test("a pass refreshes every due Task, with no per-tick count and an uncut due list", async () => {
  dueIds = Array.from({ length: 20 }, (_, index) => `task-${String(index).padStart(2, "0")}`);
  const result = await pass();
  assert.equal(result.refreshed, 20);
  assert.deepEqual(written, dueIds);
  assert.equal(reads.length, 1);
  const [read] = reads;
  // The due read has no LIMIT and no baseline filter.
  assert.doesNotMatch(read.strings.join("?"), /LIMIT/);
});

test("the time budget still ends a pass", async () => {
  dueIds = Array.from({ length: 20 }, (_, index) => `task-${index}`);
  let left = 3;
  const result = await pass(() => left-- > 0);
  // One check before the read, then one before each Task.
  assert.equal(result.refreshed, 2);
});
