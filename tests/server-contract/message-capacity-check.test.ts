import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * checkMessageCapacity, the unlocked storage check /api/chat runs before any
 * paid work (docs/policy/credit-and-cost-limits.md, "완료 분기의 정산"). A null
 * conversation id checks the account's limits only, so a conversation the
 * caller has not been shown to own is never counted.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: {} } });

const { checkMessageCapacity } = require(resolve(ROOT, "lib/apiSecurity.ts")) as {
  checkMessageCapacity: (
    db: unknown, userId: string, conversationId: string | null, count: number, bytes: number
  ) => Promise<void>;
};

const db = (totals: { count: number; bytes: number }, conversationMessages: number) => {
  const conversationCounts: unknown[] = [];
  return {
    conversationCounts,
    message: {
      count: async (args: unknown) => {
        conversationCounts.push(args);
        return conversationMessages;
      },
    },
    $queryRaw: async () => [{ count: BigInt(totals.count), bytes: BigInt(totals.bytes) }],
  };
};

const refusesWithQuota = (error: unknown) =>
  (error as { code?: string }).code === "MESSAGE_STORAGE_QUOTA_EXCEEDED";

test("without a conversation id only the account's limits are checked", async () => {
  const fake = db({ count: 0, bytes: 0 }, 1_000_000);
  await checkMessageCapacity(fake, "user-1", null, 1, 400_000);
  assert.deepEqual(fake.conversationCounts, [], "no conversation was counted");

  const full = db({ count: 0, bytes: 50 * 1024 * 1024 }, 0);
  await assert.rejects(checkMessageCapacity(full, "user-1", null, 1, 400_000), refusesWithQuota);
});

test("with a conversation id its own count is checked too", async () => {
  const fake = db({ count: 0, bytes: 0 }, 10_000);
  await assert.rejects(checkMessageCapacity(fake, "user-1", "conv-1", 1, 0), refusesWithQuota);
  assert.deepEqual(fake.conversationCounts, [{ where: { conversationId: "conv-1" } }]);
});
