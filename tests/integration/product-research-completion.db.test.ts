import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";

const url = new URL(process.env.TEST_DATABASE_URL ?? "postgresql://invalid/invalid");
if (!["postgres:", "postgresql:"].includes(url.protocol) ||
    !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
    !/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(url.pathname.slice(1))) {
  throw new Error("REFUSE: completion migration test requires a loopback test database");
}
const sql = (name: string) => readFileSync(new URL(`../../prisma/migrations/${name}/migration.sql`, import.meta.url), "utf8");

test("completion upgrade preserves existing rows and AMUX-link checks while admitting the new status", async () => {
  const client = new pg.Client({ connectionString: url.href });
  await client.connect();
  try {
    await client.query("BEGIN");
    const schema = `research_completion_${randomUUID().replaceAll("-", "")}`;
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET LOCAL search_path TO "${schema}"`);
    await client.query(sql("20261019130000_product_research_suggestion"));
    for (const status of ["open", "dismissed", "sent"]) {
      await client.query(`INSERT INTO "ProductResearchSuggestion"
        (id, kind, subject, title, area, severity, evidence, suggestion, status, "amuxIdeaId")
        VALUES ($1,'page','pricing.en','Contrast','ui','low','Observed','Increase contrast',$1,$2)`, [status, status === "sent" ? "idea-1" : null]);
    }
    const before = (await client.query('SELECT * FROM "ProductResearchSuggestion" ORDER BY id')).rows;
    await client.query(sql("20261109140000_product_research_suggestion_completed"));
    assert.deepEqual((await client.query('SELECT * FROM "ProductResearchSuggestion" ORDER BY id')).rows, before);
    await client.query(`UPDATE "ProductResearchSuggestion" SET status='completed', "statusChangedAt"=CURRENT_TIMESTAMP WHERE id='open'`);
    assert.equal((await client.query(`SELECT status FROM "ProductResearchSuggestion" WHERE id='open'`)).rows[0].status, "completed");
    for (const assignment of ["status='unknown'", "status='sent'"]) {
      await client.query("SAVEPOINT invalid_status");
      await assert.rejects(client.query(`UPDATE "ProductResearchSuggestion" SET ${assignment} WHERE id='open'`), { code: "23514" });
      await client.query("ROLLBACK TO SAVEPOINT invalid_status");
    }
  } finally {
    await client.query("ROLLBACK");
    await client.end();
  }
});
