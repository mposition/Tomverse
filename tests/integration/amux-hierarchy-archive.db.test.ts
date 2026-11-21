import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";

// First: the harness puts the shared client inside one rollback-only
// transaction before any service module creates the real one.
import { closeLifecycleHarness, lifecycle, withoutTriggers, type LifecycleTx } from
  "./helpers/amuxLifecycleHarness";

// Owner decision 2026-11-21: the Execution board's hierarchy list rolls up the
// Task cards under each hierarchy, and the owner can archive a hierarchy with
// no work left. Checked against PostgreSQL with every node trigger installed:
// the parent guard (no active child, no open card under a Feature, read
// committed only, no reactivation) and the database-set retention clock.
//
// Card rows are fixture shape only. Inside the rolled-back transaction the card
// table's CHECKs are dropped and cards are placed without their insert triggers,
// so a test can say "a done Task under this Feature" without a full intake
// chain. Nothing about nodes, the audit chain or the archive path is relaxed.

process.env.ADMIN_AUDIT_INTEGRITY_KEY = "synthetic-amux-hierarchy-archive-audit-key-2026";
process.env.AMUX_HIERARCHY_ARCHIVE_ENABLED = "1";
Object.assign(process.env, { NODE_ENV: "test" });

const load = async () => ({
  ...(await import("@/lib/amux/adminHierarchyArchiveService")),
  ...(await import("@/lib/amux/adminHierarchyRollupStore")),
  ...(await import("@/lib/amux/adminHierarchyCore")),
  prisma: (await import("@/lib/prisma")).prisma,
});

after(async () => { await closeLifecycleHarness(); });

const session = { user: { id: "owner-synthetic", email: "owner@tomverse.test" }, expires: "2099-01-01" };
const request = () => new Request("https://tomverse.test/api/admin/amux/hierarchy-archive",
  { method: "POST", headers: { "user-agent": "hierarchy-archive-db-test" } });

async function relaxCardFixtureChecks(tx: LifecycleTx) {
  const checks = await tx.$queryRaw<Array<{ conname: string }>>`
    SELECT conname FROM pg_constraint
    WHERE conrelid = '"AmuxWorkItem"'::regclass AND contype = 'c'`;
  for (const { conname } of checks)
    await tx.$executeRawUnsafe(`ALTER TABLE "AmuxWorkItem" DROP CONSTRAINT "${conname}"`);
}

async function node(tx: LifecycleTx, level: "initiative" | "epic" | "feature", parentId: string | null) {
  const id = randomUUID();
  await tx.$executeRawUnsafe(
    `INSERT INTO "AmuxPortfolioNode"
     ("id", "level", "parentId", "state", "revision", "titleCiphertext",
      "contentKeyId", "contentKeyVersion", "contentDigest", "contentDigestKeyId",
      "approvedByUserId", "authorizationAuditLogId", "updatedAt")
     VALUES ($1, $2, $3, 'active', 0, $4, 'synthetic', 1, $5, 'synthetic',
             'synthetic', $6, CURRENT_TIMESTAMP)`,
    id, level, parentId, Buffer.from("synthetic-only", "utf8"), "a".repeat(64), randomUUID());
  return id;
}

async function card(tx: LifecycleTx, input: { status: string; feature?: string | null;
  story?: string | null; type?: "task" | "story"; archived?: boolean; updatedAt?: string;
  displayKey?: string }) {
  const id = randomUUID();
  await withoutTriggers(tx, () => tx.$executeRawUnsafe(
    `INSERT INTO "AmuxWorkItem" ("id", "title", "sourceSystem", "cardType", "status",
       "parentFeatureNodeId", "parentStoryCardId", "archivedAt", "updatedAt", "displayKey")
     VALUES ($1, 'hierarchy probe', 'admin-idea-v4', $2, $3, $4, $5,
       ${input.archived ? "CURRENT_TIMESTAMP" : "NULL"}, $6::timestamp, $7)`,
    id, input.type ?? "task", input.status, input.feature ?? null, input.story ?? null,
    input.updatedAt ?? "2026-11-20 10:00:00", input.displayKey ?? null));
  return id;
}

test("a hierarchy rolls up every Task under it once, with cancelled and archived cards apart", async () => {
  const { readAmuxHierarchyRollups } = await load();
  await lifecycle(async (tx) => {
    await relaxCardFixtureChecks(tx);
    const initiative = await node(tx, "initiative", null);
    const epic = await node(tx, "epic", initiative);
    const f1 = await node(tx, "feature", epic);
    const f2 = await node(tx, "feature", epic);
    await card(tx, { status: "done", feature: f1 });
    await card(tx, { status: "done", feature: f1 });
    await card(tx, { status: "review", feature: f1, updatedAt: "2026-11-21 03:00:00" });
    await card(tx, { status: "cancelled", feature: f1 });
    // Archived and still open: out of the totals, but the archive guard counts it.
    await card(tx, { status: "todo", feature: f1, archived: true, updatedAt: "2026-11-22 00:00:00" });
    const story = await card(tx, { status: "done", feature: f2, type: "story" });
    await card(tx, { status: "doing", story });
    await card(tx, { status: "blocked", story });
    // Linked both ways: counted once.
    await card(tx, { status: "done", feature: f2, story });
    const rollups = await readAmuxHierarchyRollups(tx, [initiative, epic, f2]);
    const top = rollups.get(initiative)!;
    assert.deepEqual({ total: top.total, done: top.done, cancelled: top.cancelled,
      remaining: top.remaining, openCards: top.openCards },
    { total: 6, done: 3, cancelled: 1, remaining: 3, openCards: 2 });
    assert.deepEqual(top.distribution, { done: 3, review: 1, doing: 1, todo: 0, backlog: 0, attention: 1 });
    assert.equal(top.lastActivityAt, "2026-11-21T03:00:00.000Z");
    assert.deepEqual(rollups.get(epic), top);
    const feature = rollups.get(f2)!;
    assert.deepEqual({ total: feature.total, done: feature.done, remaining: feature.remaining,
      openCards: feature.openCards }, { total: 3, done: 1, remaining: 2, openCards: 0 });
  });
});

test("archive takes a finished hierarchy and its subtree, sets the clock and audits it", async () => {
  const { archiveAmuxHierarchyNodes, AmuxHierarchyArchiveRefusal, AMUX_HIERARCHY_ARCHIVE_ACTION } = await load();
  await lifecycle(async (tx) => {
    await relaxCardFixtureChecks(tx);
    const initiative = await node(tx, "initiative", null);
    const epic = await node(tx, "epic", initiative);
    const feature = await node(tx, "feature", epic);
    const emptyEpic = await node(tx, "epic", initiative);
    await card(tx, { status: "done", feature });
    await card(tx, { status: "cancelled", feature });
    const result = await archiveAmuxHierarchyNodes({ session, request: request(), nodeIds: [initiative] });
    assert.equal(result.archived.length, 1);
    assert.deepEqual(new Set(result.archived[0].archivedNodeIds), new Set([initiative, epic, feature, emptyEpic]));
    const rows = await tx.$queryRaw<Array<{ id: string; state: string; archivedAt: Date; contentPurgeAfter: Date }>>`
      SELECT "id", "state", "archivedAt", "contentPurgeAfter" FROM "AmuxPortfolioNode"
      WHERE "id" = ANY(${[initiative, epic, feature, emptyEpic]}::text[])`;
    assert.equal(rows.length, 4);
    for (const row of rows) {
      assert.equal(row.state, "archived");
      assert.equal(row.contentPurgeAfter.getTime() - row.archivedAt.getTime(), 90 * 86_400_000);
    }
    const audits = await tx.adminAuditLog.findMany({ where: { action: AMUX_HIERARCHY_ARCHIVE_ACTION, targetId: initiative } });
    assert.equal(audits.length, 1);
    assert.equal(audits[0].actorUserId, session.user.id);
    assert.equal(typeof audits[0].entryHash, "string");
    const metadata = audits[0].metadata as { archivedNodeIds: string[]; tasksDone: number; tasksCancelled: number };
    assert.equal(metadata.archivedNodeIds.length, 4);
    assert.equal(metadata.tasksDone, 1);
    assert.equal(metadata.tasksCancelled, 1);
    // Archive is one-way: a second archive names it, and the database refuses reactivation.
    await assert.rejects(archiveAmuxHierarchyNodes({ session, request: request(), nodeIds: [initiative] }),
      (error: unknown) => error instanceof AmuxHierarchyArchiveRefusal && error.code === "not_active");
    await tx.$executeRawUnsafe("SAVEPOINT reactivate");
    await assert.rejects(tx.$executeRawUnsafe(
      `UPDATE "AmuxPortfolioNode" SET "state" = 'active' WHERE "id" = $1`, initiative), /reactivation/);
    await tx.$executeRawUnsafe("ROLLBACK TO SAVEPOINT reactivate");
  });
});

test("archive refuses work left or an open card and writes nothing", async () => {
  const { archiveAmuxHierarchyNodes, AmuxHierarchyArchiveRefusal, AMUX_HIERARCHY_ARCHIVE_ACTION } = await load();
  await lifecycle(async (tx) => {
    await relaxCardFixtureChecks(tx);
    const busy = await node(tx, "initiative", null);
    const busyFeature = await node(tx, "feature", await node(tx, "epic", busy));
    await card(tx, { status: "done", feature: busyFeature });
    await card(tx, { status: "doing", feature: busyFeature });
    // Every Task done, but its Story is still open: the database would refuse.
    const storyLeft = await node(tx, "initiative", null);
    const storyFeature = await node(tx, "feature", await node(tx, "epic", storyLeft));
    await card(tx, { status: "done", feature: storyFeature });
    await card(tx, { status: "todo", feature: storyFeature, type: "story" });
    const refusal = (code: string) => (error: unknown) =>
      error instanceof AmuxHierarchyArchiveRefusal && error.code === code;
    await assert.rejects(archiveAmuxHierarchyNodes({ session, request: request(), nodeIds: [busy] }),
      refusal("remaining_work"));
    await assert.rejects(archiveAmuxHierarchyNodes({ session, request: request(), nodeIds: [storyLeft] }),
      refusal("open_cards"));
    // One refusal stops the whole request, including the finished one beside it.
    const finished = await node(tx, "initiative", null);
    await assert.rejects(archiveAmuxHierarchyNodes({ session, request: request(), nodeIds: [finished, busy] }),
      refusal("remaining_work"));
    await assert.rejects(archiveAmuxHierarchyNodes({ session, request: request(), nodeIds: [randomUUID()] }),
      refusal("not_found"));
    const states = await tx.$queryRaw<Array<{ state: string }>>`
      SELECT "state" FROM "AmuxPortfolioNode" WHERE "id" = ANY(${[busy, storyLeft, finished]}::text[])`;
    assert.deepEqual(states.map((row) => row.state), ["active", "active", "active"]);
    assert.equal(await tx.adminAuditLog.count({ where: { action: AMUX_HIERARCHY_ARCHIVE_ACTION,
      targetId: { in: [busy, storyLeft, finished] } } }), 0);
  });
});

test("archive stays off without the switch", async () => {
  const { archiveAmuxHierarchyNodes, AmuxHierarchyArchiveRefusal } = await load();
  delete process.env.AMUX_HIERARCHY_ARCHIVE_ENABLED;
  try {
    await assert.rejects(archiveAmuxHierarchyNodes({ session, request: request(), nodeIds: ["any"] }),
      (error: unknown) => error instanceof AmuxHierarchyArchiveRefusal && error.code === "disabled");
  } finally { process.env.AMUX_HIERARCHY_ARCHIVE_ENABLED = "1"; }
});

test("the top level sorts hierarchies into tabs, and search finds a card by number with its ancestors", async () => {
  const { readAmuxExecutionHierarchy, readAmuxExecutionHierarchySearch } =
    await import("@/lib/amux/adminExecutionRead");
  await lifecycle(async (tx) => {
    await relaxCardFixtureChecks(tx);
    const busy = await node(tx, "initiative", null);
    const busyEpic = await node(tx, "epic", busy);
    const busyFeature = await node(tx, "feature", busyEpic);
    await card(tx, { status: "doing", feature: busyFeature });
    const matched = await card(tx, { status: "done", feature: busyFeature, displayKey: "AMUX-HIERX-007" });
    const finished = await node(tx, "initiative", null);
    await card(tx, { status: "done", feature: await node(tx, "feature", await node(tx, "epic", finished)) });
    const empty = await node(tx, "initiative", null);
    type Item = { id: string; type: string; archivable?: boolean };
    const read = async (scope: "active" | "cleanup" | "all") => {
      const items: Item[] = [];
      for (let page = 0; ; page += 1) {
        const result = (await readAmuxExecutionHierarchy({ kind: "root" }, page,
          { scope, sort: scope === "cleanup" ? "stale" : "remaining", createdWithinDays: null }))!;
        assert.ok("summary" in result, "the top level carries its summary");
        items.push(...(result.items as Item[]));
        if ((page + 1) * result.pageSize >= result.total)
          return { ids: items.map((item) => item.id), items, result };
      }
    };
    const active = await read("active");
    assert.ok(active.ids.includes(busy));
    assert.ok(!active.ids.includes(finished) && !active.ids.includes(empty));
    const cleanup = await read("cleanup");
    assert.ok(cleanup.ids.includes(finished) && cleanup.ids.includes(empty) && !cleanup.ids.includes(busy));
    const summary = "summary" in active.result ? active.result.summary : null;
    assert.ok(summary && summary.cleanup >= 2 && summary.active >= 1);
    assert.equal("archiveEnabled" in active.result && active.result.archiveEnabled, true);
    assert.equal(cleanup.items.find((item) => item.id === finished)?.archivable, true);
    assert.equal(active.items.find((item) => item.id === busy)?.archivable, false);

    const search = await readAmuxExecutionHierarchySearch("hierx-007");
    assert.equal(search.matchedCards, 1);
    const path = search.rows.map((row) => [row.item.id, row.depth, row.match]);
    assert.deepEqual(path, [[busy, 0, false], [busyEpic, 1, false], [busyFeature, 2, false], [matched, 3, true]]);
  });
});
