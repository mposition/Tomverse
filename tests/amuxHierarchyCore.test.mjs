import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  AMUX_HIERARCHY_STALE_DAYS, amuxHierarchyArchivable, amuxHierarchyArchiveEnabled,
  amuxHierarchyClass, amuxHierarchyDefaultSort, amuxHierarchyMatches,
  amuxHierarchyRollupFromRow, amuxHierarchyStale, emptyAmuxHierarchyRollup,
  parseAmuxHierarchyCreatedWithin, parseAmuxHierarchyScope, parseAmuxHierarchySearch,
  parseAmuxHierarchySort, selectAmuxHierarchies, summarizeAmuxHierarchies,
} from "../lib/amux/adminHierarchyCore.ts";

const DAY = 86_400_000;
const NOW = Date.parse("2026-11-21T00:00:00.000Z");
const iso = (daysAgo) => new Date(NOW - daysAgo * DAY).toISOString();
const rollup = (over = {}) => ({ ...emptyAmuxHierarchyRollup(), ...over });
const fact = (id, createdDaysAgo, over = {}, activityDaysAgo = null) => ({ id,
  createdAt: iso(createdDaysAgo),
  rollup: rollup({ ...over, lastActivityAt: activityDaysAgo === null ? null : iso(activityDaysAgo) }) });

test("a hierarchy is active while a Task remains, complete when all are done, empty with none", () => {
  assert.equal(amuxHierarchyClass(rollup({ total: 4, done: 3, remaining: 1 })), "active");
  assert.equal(amuxHierarchyClass(rollup({ total: 4, done: 4 })), "complete");
  assert.equal(amuxHierarchyClass(rollup()), "empty");
  // Every Task cancelled: nothing is left and nothing was done.
  assert.equal(amuxHierarchyClass(rollup({ cancelled: 3 })), "empty");
});

test("rollup rows count cancelled Tasks apart so remaining never includes them", () => {
  const value = amuxHierarchyRollupFromRow({ total: 5, done: 2, cancelled: 3, review: 1,
    doing: 1, todo: 1, backlog: 0, attention: 0, openCards: 0,
    lastActivityAt: new Date("2026-11-20T03:00:00.000Z") });
  assert.equal(value.remaining, 3);
  assert.equal(value.cancelled, 3);
  assert.deepEqual(value.distribution, { done: 2, review: 1, doing: 1, todo: 1, backlog: 0, attention: 0 });
  assert.equal(value.lastActivityAt, "2026-11-20T03:00:00.000Z");
  assert.deepEqual(amuxHierarchyRollupFromRow(undefined), emptyAmuxHierarchyRollup());
});

test("archive is offered only with no Task left and no card the database guard counts as open", () => {
  assert.equal(amuxHierarchyArchivable(rollup({ total: 2, done: 2 })), true);
  assert.equal(amuxHierarchyArchivable(rollup()), true);
  assert.equal(amuxHierarchyArchivable(rollup({ total: 2, done: 1, remaining: 1 })), false);
  // An open Story (or an archived open card) still blocks the database archive.
  assert.equal(amuxHierarchyArchivable(rollup({ total: 2, done: 2, openCards: 1 })), false);
});

test("a hierarchy with work left stalls after the quiet period, measured from its last card change", () => {
  const active = { total: 3, done: 1, remaining: 2 };
  assert.equal(amuxHierarchyStale(fact("a", 30, active, AMUX_HIERARCHY_STALE_DAYS), NOW), true);
  assert.equal(amuxHierarchyStale(fact("a", 30, active, AMUX_HIERARCHY_STALE_DAYS - 1), NOW), false);
  // No card ever changed: the creation date stands in.
  assert.equal(amuxHierarchyStale(fact("a", 9, active), NOW), true);
  // A finished hierarchy is never "stalled".
  assert.equal(amuxHierarchyStale(fact("a", 30, { total: 3, done: 3 }, 20), NOW), false);
});

test("tabs filter by class, and each tab has its own default sort", () => {
  const facts = [
    fact("busy", 20, { total: 10, done: 2, remaining: 8 }, 0),
    fact("light", 5, { total: 3, done: 2, remaining: 1 }, 1),
    fact("done-old", 40, { total: 4, done: 4 }, 30),
    fact("done-new", 30, { total: 2, done: 2 }, 3),
    fact("empty", 25, {}),
  ];
  const pick = (scope, sort = amuxHierarchyDefaultSort(scope), createdWithinDays = null) =>
    selectAmuxHierarchies(facts, { scope, sort, createdWithinDays, nowMs: NOW }).map((item) => item.id);
  assert.deepEqual(pick("active"), ["busy", "light"]);
  // Clean-up starts with what has been quiet longest (an empty one never moved).
  assert.deepEqual(pick("cleanup"), ["done-old", "empty", "done-new"]);
  assert.deepEqual(pick("all"), ["busy", "light", "done-new", "empty", "done-old"]);
  assert.deepEqual(pick("all", "created"), ["light", "busy", "empty", "done-new", "done-old"]);
  assert.deepEqual(pick("all", "created", 7), ["light"]);
  // Oldest activity first: "light" last moved a day ago, "busy" today.
  assert.deepEqual(pick("active", "stale"), ["light", "busy"]);
});

test("the summary counts every class, the clean-up total and the Task totals", () => {
  const summary = summarizeAmuxHierarchies([
    fact("a", 20, { total: 10, done: 2, remaining: 8 }, 10),
    fact("b", 5, { total: 3, done: 2, remaining: 1 }, 1),
    fact("c", 40, { total: 4, done: 4 }, 30),
    fact("d", 25, {}),
  ], NOW);
  assert.deepEqual(summary, { active: 2, complete: 1, empty: 1, stale: 1, cleanup: 2, all: 4,
    tasksDone: 8, tasksTotal: 17, remaining: 9 });
});

test("query parameters are parsed strictly", () => {
  assert.equal(parseAmuxHierarchyScope(null), "active");
  assert.equal(parseAmuxHierarchyScope("cleanup"), "cleanup");
  assert.equal(parseAmuxHierarchyScope("archived"), null);
  assert.equal(parseAmuxHierarchySort(null, "cleanup"), "stale");
  assert.equal(parseAmuxHierarchySort("created", "active"), "created");
  assert.equal(parseAmuxHierarchySort("title", "active"), null);
  assert.equal(parseAmuxHierarchyCreatedWithin(null), null);
  assert.equal(parseAmuxHierarchyCreatedWithin("30"), 30);
  assert.equal(parseAmuxHierarchyCreatedWithin("31"), undefined);
});

test("search queries are trimmed, bounded and case- and width-insensitive", () => {
  assert.equal(parseAmuxHierarchySearch("  다운로드   안정화 "), "다운로드 안정화");
  assert.equal(parseAmuxHierarchySearch("   "), null);
  assert.equal(parseAmuxHierarchySearch("x".repeat(81)), null);
  assert.equal(parseAmuxHierarchySearch("a​b"), null);
  assert.equal(amuxHierarchyMatches("download", "Generated file DOWNLOAD"), true);
  assert.equal(amuxHierarchyMatches("ａｆ-12", null, "AF-12"), true);
  assert.equal(amuxHierarchyMatches("다운로드", "생성 파일 다운로드 안정화"), true);
  assert.equal(amuxHierarchyMatches("upload", "download", null), false);
});

test("the archive switch is off unless set to exactly 1", () => {
  assert.equal(amuxHierarchyArchiveEnabled({}), false);
  assert.equal(amuxHierarchyArchiveEnabled({ AMUX_HIERARCHY_ARCHIVE_ENABLED: "true" }), false);
  assert.equal(amuxHierarchyArchiveEnabled({ AMUX_HIERARCHY_ARCHIVE_ENABLED: "1" }), true);
});

test("the archive write stays out of the read-only board and view route", async () => {
  const read = (path) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const [grid, request, viewRoute, archiveRoute, service] = await Promise.all([
    read("components/admin/AmuxHierarchyGrid.tsx"),
    read("components/admin/amuxHierarchyArchiveRequest.ts"),
    read("app/api/admin/amux/execution-view/route.ts"),
    read("app/api/admin/amux/hierarchy-archive/route.ts"),
    read("lib/amux/adminHierarchyArchiveService.ts"),
  ]);
  assert.doesNotMatch(grid, /method: "(POST|PUT|PATCH|DELETE)"/);
  assert.match(request, /method: "POST"/);
  assert.doesNotMatch(viewRoute, /export async function (POST|PUT|PATCH|DELETE)/);
  assert.match(archiveRoute, /getAdminRole\(session\) !== "owner"/);
  assert.match(archiveRoute, /assertRecentAdminAuthentication\(session\)/);
  assert.match(archiveRoute, /hasValidMutationOrigin\(request\)/);
  // The audit entry is written in the same transaction as the archive.
  assert.match(service, /takeAuditChainLock\(tx\)/);
  assert.match(service, /writeAdminAuditLog\(\{ tx,/);
  assert.match(service, /amuxHierarchyArchiveEnabled\(process\.env\)/);
  // Cards under the subtree, Story-linked ones too, are locked before the work is counted.
  const cardLock = service.indexOf('FROM "AmuxWorkItem" card');
  assert.ok(cardLock > 0 && /ORDER BY card\."id" FOR UPDATE/.test(service.slice(cardLock)));
  assert.ok(cardLock < service.indexOf("readAmuxHierarchyRollups(tx, named)"));
});
