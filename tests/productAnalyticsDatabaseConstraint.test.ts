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
