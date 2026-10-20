import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { readAmuxPortfolioClock } from "../lib/amux/portfolioClock.ts";

test("portfolio timestamps use the database UTC clock even when the service is ahead", async () => {
  const databaseNow = new Date("2026-10-12T02:00:00.000Z");
  let statement;
  const tx = { $queryRaw: async (sql) => {
    statement = sql.join("");
    return [{ now: databaseNow }];
  } };
  assert.equal(await readAmuxPortfolioClock(tx), databaseNow);
  assert.match(statement, /clock_timestamp\(\) AT TIME ZONE 'UTC'/);
  // A rounding cast can return an instant up to 0.5 ms ahead of the clock the
  // assessment guard compares with; truncation never can.
  assert.match(statement, /date_trunc\('milliseconds', clock_timestamp\(\)/);
  assert.doesNotMatch(statement, /::TIMESTAMP\(3\)/i);
});

test("an unavailable database clock never falls back to application time", async () => {
  for (const rows of [[], [{ now: null }], [{ now: new Date(NaN) }], [{ now: "2026-10-12" }]]) {
    await assert.rejects(readAmuxPortfolioClock({ $queryRaw: async () => rows }),
      /amux_portfolio_clock_unavailable/);
  }
});

test("both portfolio writers persist only the database-derived timestamp", async () => {
  const assessment = await readFile(new URL("../lib/amux/portfolioAssessmentService.ts", import.meta.url), "utf8");
  const score = await readFile(new URL("../lib/amux/portfolioScoreService.ts", import.meta.url), "utf8");
  assert.match(assessment, /const now = await readAmuxPortfolioClock\(tx\)/);
  assert.match(assessment, /approvedAt: now/);
  assert.match(score, /computedAt: await readAmuxPortfolioClock\(tx\)/);
  assert.doesNotMatch(score, /computedAt: new Date\(\)/);
});
