import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { loadAuditRowById, loadAuditRows } from "@/lib/adminConsoleData";
import { prisma } from "@/lib/prisma";

// Opening one audit row by id, including one the recent window does not hold.
//
// Contract: docs/ui-contracts/admin-console-ia.md.
//
// What needs a database: the whole point is the relationship between two reads
// over the same table. `loadAuditRows` returns the newest N; the integrity
// checker walks oldest-first and stops at the first bad row, so the id it hands
// an operator is usually *older* than anything that window contains. Proving
// the id read is independent of the window needs both queries against real
// rows.

const reset = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "AdminAuditLog", "User" RESTART IDENTITY CASCADE`
  );

// `actorUserId` is a foreign key, so the actor has to exist. Written as a real
// row rather than left null: an audit entry with no actor is a different thing
// from one whose actor is an administrator, and this suite is about the latter.
const ACTOR_ID = "admin-actor-1";

beforeEach(async () => {
  await reset();
  await prisma.user.create({
    data: { id: ACTOR_ID, email: "owner@example.test" },
  });
});

after(async () => {
  await prisma.$disconnect();
});

const MINUTE = 60 * 1000;

const auditRow = async (input: { id: string; minutesAgo: number }) =>
  prisma.adminAuditLog.create({
    data: {
      id: input.id,
      actorUserId: ACTOR_ID,
      actorEmail: "owner@example.test",
      action: "app_settings.update_completed",
      targetType: "AppSetting",
      targetId: "guestDefaultModelId",
      summary: `Entry ${input.id}`,
      createdAt: new Date(Date.now() - input.minutesAgo * MINUTE),
    },
    select: { id: true },
  });

test("a row older than the window is still reachable by id", async () => {
  // The failure this fixes: the console said "entry X is invalid" and could not
  // show entry X, because X is exactly the row the newest-N list leaves out.
  const oldest = await auditRow({ id: "audit-oldest", minutesAgo: 500 });
  await auditRow({ id: "audit-newer-1", minutesAgo: 20 });
  await auditRow({ id: "audit-newer-2", minutesAgo: 10 });

  const window = await loadAuditRows(2);
  assert.deepEqual(
    window.map((row) => row.id),
    ["audit-newer-2", "audit-newer-1"],
    "the window must genuinely exclude the oldest row"
  );

  const found = await loadAuditRowById(oldest.id);
  assert.ok(found, "the id read must not depend on the window");
  assert.equal(found.id, "audit-oldest");
  assert.equal(found.summary, "Entry audit-oldest");
});

test("an id nothing matches is null, not an error", async () => {
  // A stale link and a deleted row are the same observation from here. The page
  // says so on screen rather than answering 404 for a workspace that exists.
  assert.equal(await loadAuditRowById("audit-does-not-exist"), null);
});

test("the row read carries the same shape the list does", async () => {
  // The panel renders both through one type. A read that dropped a field would
  // typecheck and then render blanks for a row opened by link only.
  await auditRow({ id: "audit-one", minutesAgo: 5 });
  const [listed] = await loadAuditRows(1);
  const byId = await loadAuditRowById("audit-one");
  assert.ok(byId);
  assert.deepEqual(Object.keys(byId).sort(), Object.keys(listed).sort());
});
