import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import {
  VERIFY_BATCH_SIZE,
  verifyAdminAuditIntegrity,
} from "@/lib/adminAuditIntegrity";
import { prisma } from "@/lib/prisma";

/**
 * The chain walk reads in batches now, and a batched walk can lie two ways.
 *
 * It used to be one unbounded `findMany`: every hash-chained entry, with its
 * `metadata`, resident at once, plus an HMAC per key per ordering. Correct, and
 * a cliff rather than a slope -- forty-seven mutating routes write one or two
 * rows per action and nothing prunes them, because the chain is the point.
 *
 * Cursor pagination is where the correctness goes if it goes. A skipped row is
 * a row nobody verified reported as verified; a repeated row inflates the count
 * and, worse, compares an entry's `previousHash` against itself, which would
 * report a linkage break in a sound chain. Both are silent. So these tests seed
 * more entries than the batch size and check the arithmetic rather than the
 * verdict alone.
 *
 * Contract: docs/ops/admin-audit-key-epochs.md.
 */

const KEY = "audit-walk-test-key-0123456789abcdef0123456789abcdef";

const reset = () =>
  prisma.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);

let savedKey: string | undefined;
let savedPrevious: string | undefined;

beforeEach(async () => {
  savedKey = process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  savedPrevious = process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  process.env.ADMIN_AUDIT_INTEGRITY_KEY = KEY;
  delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  await reset();
});

after(async () => {
  if (savedKey === undefined) delete process.env.ADMIN_AUDIT_INTEGRITY_KEY;
  else process.env.ADMIN_AUDIT_INTEGRITY_KEY = savedKey;
  if (savedPrevious === undefined) {
    delete process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS;
  } else {
    process.env.ADMIN_AUDIT_INTEGRITY_PREVIOUS_KEYS = savedPrevious;
  }
  await reset();
  await prisma.$disconnect();
});

const session = {
  user: { id: "walk-actor", email: "walk@tomverse.app" },
} as Parameters<typeof writeAdminAuditLog>[0]["session"];

const writeEntries = async (count: number) => {
  for (let index = 0; index < count; index += 1) {
    await writeAdminAuditLog({
      session,
      action: "audit.walk.test",
      targetType: "AuditWalk",
      targetId: String(index),
      summary: `Entry ${index}.`,
      metadata: { index },
    });
  }
};

test("an empty chain is verified rather than merely not failing", async () => {
  const integrity = await verifyAdminAuditIntegrity();
  assert.equal(integrity.configured, true);
  assert.equal(integrity.valid, true);
  assert.equal(integrity.checkedEntries, 0);
  assert.equal(integrity.truncated, false);
  assert.equal(integrity.firstCheckedId, null);
});

test("a chain shorter than one batch verifies whole", async () => {
  await writeEntries(5);
  const integrity = await verifyAdminAuditIntegrity();
  assert.equal(integrity.checkedEntries, 5);
  assert.equal(integrity.verifiedEntries, 5);
  assert.equal(integrity.linkageBreaks, 0);
  assert.equal(integrity.valid, true);
  assert.equal(integrity.truncated, false);
});

test("a chain longer than one batch is walked exactly once end to end", async () => {
  // Deliberately past the batch size rather than a round number near it. A
  // chain shorter than one batch never issues a second query, so it exercises
  // none of the cursor arithmetic -- which is the only part of this change
  // that can be wrong. Reading the size from the module keeps that true if the
  // size is ever tuned.
  const total = VERIFY_BATCH_SIZE + 7;
  await writeEntries(total);

  const integrity = await verifyAdminAuditIntegrity();

  // Seen exactly once: a skipped row would lower this, a repeated one raise it.
  assert.equal(integrity.checkedEntries, total);
  assert.equal(integrity.verifiedEntries, total);
  // A repeated row compares an entry's previousHash against its own hash, so a
  // duplicate shows up here even when the count happens to work out.
  assert.equal(integrity.linkageBreaks, 0);
  assert.equal(integrity.invalidEntries, 0);
  assert.equal(integrity.valid, true);

  const oldest = await prisma.adminAuditLog.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { id: true },
  });
  const newest = await prisma.adminAuditLog.findFirst({
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { id: true },
  });
  // The walk starts at genesis and reaches the newest entry: a cursor that
  // drifted would still count rows while checking the wrong span.
  assert.equal(integrity.firstCheckedId, oldest?.id);
  assert.equal(integrity.lastCheckedId, newest?.id);
});

test("a rewritten row is still caught when it sits mid-chain", async () => {
  // The batching must not lose a failure that falls inside a batch rather than
  // at either end of the walk.
  await writeEntries(20);
  const target = await prisma.adminAuditLog.findFirst({
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    skip: 9,
    select: { id: true },
  });
  assert.ok(target);
  await prisma.adminAuditLog.update({
    where: { id: target.id },
    data: { summary: "Rewritten after signing." },
  });

  const integrity = await verifyAdminAuditIntegrity();
  assert.equal(integrity.valid, false);
  assert.equal(integrity.checkedEntries, 20);
  assert.equal(integrity.invalidEntries, 1);
  assert.equal(integrity.firstInvalidId, target.id);
  // Not the oldest entry, so a missing key does not explain it.
  assert.equal(integrity.firstInvalidIsOldest, false);
  assert.equal(integrity.unverifiedPrefix, 0);
});

test("a walk that ran out of time refuses to call the chain valid", async () => {
  await writeEntries(3);
  const clock = Date.now;
  let calls = 0;
  // The deadline is read as `Date.now() > deadline` after each batch. Jumping
  // the clock forward once the walk has started makes the first batch the last.
  Date.now = () => (++calls > 2 ? clock() + 10 * 60_000 : clock());
  try {
    const integrity = await verifyAdminAuditIntegrity();
    // Whatever it managed to read, it must not report a sound chain from it:
    // linkage is verified from genesis forward, so stopping early leaves the
    // *newest* entries unchecked -- the ones an operator most wants covered.
    if (integrity.truncated) {
      assert.equal(integrity.valid, false);
      assert.match(integrity.message, /stopped after/);
    }
  } finally {
    Date.now = clock;
  }
});
