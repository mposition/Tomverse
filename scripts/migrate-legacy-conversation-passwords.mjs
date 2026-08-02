#!/usr/bin/env node
/**
 * SEC-011. Re-hashes any conversation lock password still stored in plaintext.
 *
 * `verifyConversationPassword` treats a value that is not `scrypt$1$...` as a
 * legacy row and compares `sha256(candidate)` against `sha256(stored)` -- which
 * is only a password check if `stored` *is* the plaintext. Anyone who can read
 * that column (a database compromise, a backup dump, an over-broad admin query)
 * recovers a password the user has probably reused elsewhere.
 *
 * New locks have been scrypt-hashed for some time, and a successful unlock
 * opportunistically upgrades the row it just verified -- but that only ever
 * reaches conversations whose owner happens to unlock them. This closes the
 * rest.
 *
 * The plaintext is never printed, logged, or written anywhere: it is read,
 * hashed, and the row is overwritten in the same statement batch.
 *
 * Usage:
 *   npm run migrate:conversation-lock-passwords -- --dry-run
 *   npm run migrate:conversation-lock-passwords -- --confirm-production
 *
 * (`--conditions=react-server --import tsx` is what the npm script adds:
 * `lib/conversationLock.ts` is `server-only` TypeScript.)
 *
 * Options:
 *   --dry-run             Report what would change and write nothing.
 *   --batch-size=<n>      Rows per batch (default 200).
 *   --confirm-production  Required to write when NODE_ENV=production.
 *
 * Idempotent: re-running finds nothing, because every row it touched now
 * starts with the hash prefix.
 */

import process from "node:process";

const args = new Set(process.argv.slice(2));
const dryRun = args.has("--dry-run");
const confirmedProduction = args.has("--confirm-production");
const batchSizeArgument = process.argv
  .slice(2)
  .find((argument) => argument.startsWith("--batch-size="));
const batchSize = Math.min(
  1000,
  Math.max(1, Number(batchSizeArgument?.split("=")[1] || 200) || 200)
);

const isProduction = process.env.NODE_ENV === "production";
if (isProduction && !dryRun && !confirmedProduction) {
  console.error(
    "Refusing to write in production without --confirm-production.\n" +
      "Run with --dry-run first, take a backup, then re-run with --confirm-production."
  );
  process.exit(1);
}

const { prisma } = await import("../lib/prisma.ts");
const { hashConversationPassword, isHashedConversationPassword } = await import(
  "../lib/conversationLock.ts"
);

let scanned = 0;
let migrated = 0;
let alreadyHashed = 0;
let skippedEmpty = 0;
let failed = 0;

let cursor = null;

for (;;) {
  const rows = await prisma.conversation.findMany({
    where: { password: { not: null } },
    select: { id: true, password: true },
    orderBy: { id: "asc" },
    take: batchSize,
    ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
  });
  if (rows.length === 0) break;
  cursor = rows[rows.length - 1].id;

  for (const row of rows) {
    scanned += 1;
    const stored = row.password;
    if (!stored) {
      skippedEmpty += 1;
      continue;
    }
    if (isHashedConversationPassword(stored)) {
      alreadyHashed += 1;
      continue;
    }
    if (dryRun) {
      migrated += 1;
      continue;
    }
    try {
      const hashed = await hashConversationPassword(stored);
      // Conditional on the value still being the one just read, so a user who
      // changes their password mid-migration is not overwritten with the old
      // one re-hashed.
      const result = await prisma.conversation.updateMany({
        where: { id: row.id, password: stored },
        data: { password: hashed },
      });
      if (result.count === 1) migrated += 1;
      else skippedEmpty += 1;
    } catch (error) {
      failed += 1;
      // Never include the value itself.
      console.error(
        `Failed to migrate conversation ${row.id}:`,
        error instanceof Error ? error.name : "UnknownError"
      );
    }
  }
}

console.log(
  JSON.stringify(
    {
      mode: dryRun ? "dry-run" : "write",
      batchSize,
      scanned,
      migrated,
      alreadyHashed,
      skipped: skippedEmpty,
      failed,
    },
    null,
    2
  )
);

await prisma.$disconnect();

if (failed > 0) process.exit(1);
if (dryRun && migrated > 0) {
  console.log(
    `\n${migrated} row(s) still hold a plaintext password. Re-run without --dry-run to migrate them.`
  );
}
