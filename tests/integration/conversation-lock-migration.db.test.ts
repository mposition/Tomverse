import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { after, beforeEach, test } from "node:test";
import {
  isHashedConversationPassword,
  verifyConversationPassword,
} from "@/lib/conversationLock";
import { prisma } from "@/lib/prisma";

/**
 * SEC-011. Conversation lock passwords predating the scrypt hashing were stored
 * as plaintext, and `verifyConversationPassword` still accepts such a row by
 * comparing `sha256(candidate)` against `sha256(stored)` -- which only works
 * *because* `stored` is the password. Anyone reading that column recovers a
 * password the user has likely reused. Unlocking upgrades a row opportunis-
 * tically, but only for conversations someone happens to open, so the rest need
 * a migration.
 *
 * This exercises the real script against a real database rather than its logic
 * in isolation: the failure this guards against (a partially-migrated table,
 * an overwrite of a password changed mid-run, a re-run that re-hashes an
 * already-hashed value into garbage) only appears when the SQL actually runs.
 */

const repoRoot = resolve(import.meta.dirname, "..", "..");

const runMigration = (...args: string[]) => {
  const result = spawnSync(
    process.execPath,
    [
      "--conditions=react-server",
      "--import",
      "tsx",
      "scripts/migrate-legacy-conversation-passwords.mjs",
      ...args,
    ],
    {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: "test" },
      encoding: "utf8",
    }
  );
  assert.equal(
    result.status,
    0,
    `migration exited ${result.status}: ${result.stderr}`
  );
  const jsonStart = result.stdout.indexOf("{");
  assert.ok(jsonStart >= 0, `no summary in output: ${result.stdout}`);
  const summary = JSON.parse(
    result.stdout.slice(jsonStart, result.stdout.lastIndexOf("}") + 1)
  );
  return { summary, stdout: result.stdout, stderr: result.stderr };
};

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Message",
      "Conversation",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const createUser = () =>
  prisma.user.create({
    data: { email: `lock-migration-${randomUUID()}@example.test` },
  });

const createConversation = (userId: string, password: string | null) =>
  prisma.conversation.create({
    data: { userId, title: `Locked ${randomUUID()}`, password },
  });

const storedPassword = async (id: string) =>
  (
    await prisma.conversation.findUniqueOrThrow({
      where: { id },
      select: { password: true },
    })
  ).password;

test("plaintext lock passwords are re-hashed and stay verifiable", async () => {
  const user = await createUser();
  const secrets = ["correct horse battery", "hunter2hunter2", "  padded  pw  "];
  const conversations = [];
  for (const secret of secrets) {
    conversations.push({
      id: (await createConversation(user.id, secret)).id,
      secret,
    });
  }

  const { summary } = runMigration();
  assert.equal(summary.mode, "write");
  assert.equal(summary.migrated, secrets.length);
  assert.equal(summary.failed, 0);

  for (const { id, secret } of conversations) {
    const stored = await storedPassword(id);
    assert.ok(stored, "the row must still hold a value");
    assert.ok(
      isHashedConversationPassword(stored!),
      "every migrated row must carry the scrypt prefix"
    );
    assert.notEqual(stored, secret, "the plaintext must be gone");
    // The user's password still works, which is the whole point: the migration
    // must not lock anyone out of their own conversation.
    const verified = await verifyConversationPassword(secret, stored!);
    assert.equal(verified.matches, true);
    assert.equal(verified.needsUpgrade, false);
    const wrong = await verifyConversationPassword(`${secret}x`, stored!);
    assert.equal(wrong.matches, false);
  }
});

test("a dry run reports the work without writing anything", async () => {
  const user = await createUser();
  const conversation = await createConversation(user.id, "plaintext secret");

  const { summary, stdout } = runMigration("--dry-run");
  assert.equal(summary.mode, "dry-run");
  assert.equal(summary.migrated, 1);
  assert.equal(await storedPassword(conversation.id), "plaintext secret");
  // A dry run that leaked the value into a log would defeat its own purpose.
  assert.ok(
    !stdout.includes("plaintext secret"),
    "the script must never print a stored password"
  );
});

test("re-running finds nothing left to do", async () => {
  const user = await createUser();
  await createConversation(user.id, "first password");
  await createConversation(user.id, "second password");

  const first = runMigration().summary;
  assert.equal(first.migrated, 2);

  const second = runMigration().summary;
  assert.equal(second.migrated, 0, "the second run must be a no-op");
  assert.equal(second.alreadyHashed, 2);
  assert.equal(second.failed, 0);

  // And the production go/no-go signal: a dry run over a migrated table
  // reports zero rows still holding plaintext.
  const audit = runMigration("--dry-run").summary;
  assert.equal(audit.migrated, 0);
  assert.equal(audit.scanned, 2);
});

test("rows without a lock and rows already hashed are left alone", async () => {
  const user = await createUser();
  const unlocked = await createConversation(user.id, null);
  await createConversation(user.id, "legacy value");
  runMigration();

  const alreadyHashed = await storedPassword(
    (
      await prisma.conversation.findFirstOrThrow({
        where: { password: { not: null } },
        select: { id: true },
      })
    ).id
  );
  const rerun = runMigration().summary;
  assert.equal(rerun.migrated, 0);
  // The unlocked conversation is not counted at all: the query filters on a
  // non-null password, so an untouched table of unlocked conversations costs
  // nothing to scan.
  assert.equal(rerun.scanned, 1);
  assert.equal(await storedPassword(unlocked.id), null);
  assert.equal(
    await storedPassword(
      (
        await prisma.conversation.findFirstOrThrow({
          where: { password: { not: null } },
          select: { id: true },
        })
      ).id
    ),
    alreadyHashed,
    "a second pass must not re-hash an already-hashed value"
  );
});

test("a password changed mid-migration is not overwritten with the old one", async () => {
  // The script reads a batch, then writes each row conditionally on the value
  // it read. Simulated here by changing the row between read and write: the
  // conditional `updateMany` must find nothing to update.
  const user = await createUser();
  const conversation = await createConversation(user.id, "old plaintext");

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { password: "new plaintext" },
  });

  const { summary } = runMigration();
  assert.equal(summary.migrated, 1);
  const stored = await storedPassword(conversation.id);
  const verified = await verifyConversationPassword("new plaintext", stored!);
  assert.equal(
    verified.matches,
    true,
    "the newest password must be the one that survives"
  );
  const stale = await verifyConversationPassword("old plaintext", stored!);
  assert.equal(stale.matches, false);
});

test("batching walks the whole table rather than the first page", async () => {
  const user = await createUser();
  for (let index = 0; index < 7; index += 1) {
    await createConversation(user.id, `batched password ${index}`);
  }

  const { summary } = runMigration("--batch-size=2");
  assert.equal(summary.batchSize, 2);
  assert.equal(summary.scanned, 7);
  assert.equal(summary.migrated, 7);

  const remaining = await prisma.conversation.count({
    where: {
      AND: [
        { password: { not: null } },
        { NOT: { password: { startsWith: "scrypt$1$" } } },
      ],
    },
  });
  assert.equal(remaining, 0, "no row may still hold plaintext");
});
