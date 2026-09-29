import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { PRODUCT_ANALYTICS_EVENT_NAMES } from "../lib/productAnalyticsShared.ts";

const migrationsDirectory = join(process.cwd(), "prisma", "migrations");
const constraintPattern =
  /ADD CONSTRAINT\s+"ProductAnalyticsEvent_name_check"\s+CHECK\s*\(\s*"eventName"\s+IN\s*\(([\s\S]*?)\)\s*\)\s*;/g;

const latestDatabaseEventNames = () => {
  let latest: string[] | null = null;
  for (const directory of readdirSync(migrationsDirectory).sort()) {
    const migrationPath = join(migrationsDirectory, directory, "migration.sql");
    let source: string;
    try {
      source = readFileSync(migrationPath, "utf8");
    } catch {
      continue;
    }

    for (const match of source.matchAll(constraintPattern)) {
      latest = Array.from(match[1].matchAll(/'([^']+)'/g), (item) => item[1]);
    }
  }
  return latest;
};

test("the latest database analytics constraint matches the application event registry", () => {
  const databaseEventNames = latestDatabaseEventNames();
  assert.ok(databaseEventNames, "No ProductAnalyticsEvent event-name constraint was found.");
  assert.equal(
    new Set(databaseEventNames).size,
    databaseEventNames.length,
    "The database analytics constraint contains duplicate event names."
  );
  assert.deepEqual(databaseEventNames, [...PRODUCT_ANALYTICS_EVENT_NAMES]);
});

const constraintNamesIn = (directory: string) => {
  const source = readFileSync(join(migrationsDirectory, directory, "migration.sql"), "utf8");
  const match = [...source.matchAll(constraintPattern)].at(-1);
  assert.ok(match, `${directory} rebuilds no ProductAnalyticsEvent event-name constraint.`);
  return new Set(Array.from(match[1].matchAll(/'([^']+)'/g), (item) => item[1]));
};

test("the 2026-08-30 rebuild keeps every name production's 2026-09-14 list allows", () => {
  // 20260914123000 reached production before 20260830090500 did, so on the
  // release that brings the earlier-named file there it runs second. Its list
  // replaces the 20260914 one in place, and it validates existing rows, so a
  // name missing here would fail the deploy or refuse those events for good.
  // CI cannot see this: it applies migrations to an empty database in name
  // order, where 20260914 always runs last.
  const later = constraintNamesIn("20260914123000_assistant_knowledge_guide_analytics_events");
  const earlier = constraintNamesIn("20260830090500_ai_review_evidence_chain_analytics_events");
  assert.deepEqual([...later].filter((name) => !earlier.has(name)), []);
  assert.deepEqual([...earlier].filter((name) => !later.has(name)), []);
});
