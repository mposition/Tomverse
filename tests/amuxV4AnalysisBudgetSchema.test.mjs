import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const migration = new URL(
  "../prisma/migrations/20261003100000_amux_v4_analysis_budget_ledger/migration.sql",
  import.meta.url);
const totalMigration = new URL(
  "../prisma/migrations/20261003110000_amux_v4_analysis_budget_total_check/migration.sql",
  import.meta.url);
const priceMigration = new URL(
  "../prisma/migrations/20261003120000_amux_v4_analysis_price_versions/migration.sql",
  import.meta.url);
const schema = new URL("../prisma/schema.prisma", import.meta.url);

test("AMUX v4 analysis budget schema is additive, dark and agent-only", async () => {
  const [sql, totalSql, priceSql, prisma] = await Promise.all([
    readFile(migration, "utf8"), readFile(totalMigration, "utf8"),
    readFile(priceMigration, "utf8"),
    readFile(schema, "utf8"),
  ]);
  assert.match(sql, /CREATE TABLE "AmuxIdeaAnalysisBudgetWindow"/);
  assert.match(sql, /CREATE TABLE "AmuxIdeaAnalysisBudgetHold"/);
  assert.match(sql, /"namespace" = 'agent\/amux-intake'/);
  assert.match(sql, /"limitMicroUsd" = 50000000/);
  assert.match(totalSql, /"AmuxIdeaAnalysisBudgetWindow_total_check"/);
  assert.match(totalSql, /"spentMicroUsd" <= "limitMicroUsd" - "reservedMicroUsd"/);
  assert.match(sql, /UNIQUE INDEX "AmuxIdeaAnalysisBudgetHold_previewId_key"/);
  assert.match(sql, /FOREIGN KEY \("previewId"\) REFERENCES "AmuxIdeaTransferPreview"\("id"\)/);
  assert.match(sql, /"status" IN \('reserved', 'in_flight', 'succeeded', 'failed',/);
  assert.match(sql, /"status" = 'owner_consumed'.*?"settledMicroUsd" = "reservedMicroUsd"/s);
  assert.match(sql, /"status" = 'released'.*?"settledMicroUsd" = 0/s);
  assert.match(sql, /"AmuxIdeaAnalysisBudgetHold_lifecycle_check" CHECK \(\(.*?\) IS TRUE/s);
  assert.doesNotMatch(sql, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE)\s+(?:INTO\s+|FROM\s+)?"?(?:Credit|Chat|Memory)/i);
  assert.match(prisma, /model AmuxIdeaAnalysisBudgetWindow \{/);
  assert.match(prisma, /model AmuxIdeaAnalysisBudgetHold \{/);
  assert.match(priceSql, /CREATE TABLE "AmuxIdeaAnalysisPriceVersion"/);
  assert.match(priceSql, /"AmuxIdeaAnalysisPriceVersion_one_active_key"/);
  assert.match(priceSql, /BEFORE INSERT OR UPDATE OR DELETE ON "AmuxIdeaAnalysisPriceVersion"/);
  assert.match(priceSql, /"AmuxIdeaAnalysisBudgetHold_priceVersion_fkey"/);
  assert.match(priceSql, /"AmuxIdeaAnalysisBudgetHold_new_price_required_check"[\s\S]*?NOT VALID/);
  assert.doesNotMatch(priceSql, /\bINSERT\s+INTO\s+"AmuxIdeaAnalysisPriceVersion"/i);
  assert.match(prisma, /model AmuxIdeaAnalysisPriceVersion \{/);
  assert.match(prisma, /priceVersionId\s+String\?/);
  assert.match(prisma, /previewId\s+String\s+@unique/);
});
