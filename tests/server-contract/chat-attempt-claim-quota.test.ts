import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

/**
 * The attempt creation caps are a hard storage bound, and every row counts
 * toward them (docs/policy/chat-durable-draft-and-attempt-recovery.md
 * section 3) -- an attempt refused before dispatch (`failed / request_refused`,
 * empty) included. Those rows are never deleted, so leaving them out of the
 * count would let storage grow without bound (B3 review, 2026-11-28: the
 * change that excluded them was reverted). The real
 * lib/chatResponseAttemptPersistence.ts runs against a fake transaction that
 * records what the caps were asked.
 */

const ROOT = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(ROOT, path)).href;
const require = createRequire(import.meta.url);

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL ||= "postgresql://e2e:e2e@127.0.0.1:1/e2e?connect_timeout=1";

const counts: Array<{ where: Record<string, unknown> }> = [];
let counted = 0;

const tx = {
  $executeRaw: async () => 0,
  $queryRaw: async () => [{ now: new Date() }],
  conversation: { findFirst: async () => ({ id: "conv-quota", chatRecoveryEpoch: 0 }) },
  chatResponseAttempt: {
    findFirst: async () => null,
    count: async (args: { where: Record<string, unknown> }) => {
      counts.push(args);
      return counted;
    },
    create: async ({ data }: { data: Record<string, unknown> }) => ({
      ...data,
      actualModelId: null,
      provider: null,
      status: "claimed",
      partialContent: "",
      checkpointRevision: 0,
      finishReason: null,
      failureCode: null,
      terminalAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
};

mock.module(mod("lib/prisma.ts"), {
  namedExports: { prisma: { $transaction: async (fn: (client: typeof tx) => Promise<unknown>) => fn(tx) } },
});

const persistence = require(resolve(ROOT, "lib/chatResponseAttemptPersistence.ts")) as {
  claimChatResponseAttempt: (input: Record<string, unknown>) => Promise<{ disposition: string }>;
  ChatAttemptCapacityError: new () => Error;
};

const claim = () => persistence.claimChatResponseAttempt({
  userId: "user-quota",
  assistantMessageId: "assistant-quota-1",
  conversationId: "conv-quota",
  sourceUserMessageId: "user-message-quota",
  requestedModelId: "gpt-5-4-mini",
  requestPayloadDigest: "a".repeat(64),
  expectedRecoveryEpoch: 0,
  ownerId: "worker-quota",
  leaseExpiresAt: new Date(Date.now() + 60_000),
});

test("both creation caps count every attempt row, refused ones included", async () => {
  counts.length = 0;
  counted = 0;
  assert.equal((await claim()).disposition, "claimed");
  assert.equal(counts.length, 2);
  assert.deepEqual(counts[0].where, { userId: "user-quota", conversationId: "conv-quota" });
  assert.deepEqual(counts[1].where, { userId: "user-quota" });
});

test("a full conversation is refused a new identity", async () => {
  counts.length = 0;
  counted = 2_000;
  await assert.rejects(claim(), (error) => error instanceof persistence.ChatAttemptCapacityError);
});
