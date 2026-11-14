import assert from "node:assert/strict";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// The v22 tick reads at most eight candidates by score. A Task whose
// dependency is unfinished never passes readiness, so the candidate query
// leaves it out: otherwise eight blocked Tasks with higher scores fill the
// window every tick and a ready Task below them is never read
// (production 2026-11-06: ready Tasks ranked 12th and 13th).

const root = resolve(import.meta.dirname, "../..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-11-06T00:00:00Z");
const queries: string[] = [];
const fragments: string[] = [];
const db = {
  $queryRaw: async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const sql = strings.join("?");
    queries.push(sql);
    for (const value of values) {
      if (value && typeof value === "object" && "sql" in value &&
          typeof (value as { sql: unknown }).sql === "string")
        fragments.push((value as { sql: string }).sql);
    }
    return sql.includes("clock_timestamp") ? [{ now }] : [];
  },
  $transaction: async (fn: (tx: unknown) => unknown) => fn(db),
};
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: db } });

test("the candidate window leaves out Tasks still waiting on a dependency", async () => {
  const previous = process.env.TOMVERSE_AMUX_V22_AUTO_PROMOTE;
  process.env.TOMVERSE_AMUX_V22_AUTO_PROMOTE = "enabled";
  try {
    const { tickV22AutoPromotion } = await import(mod("lib/amux/v22AutoPromotionService.ts"));
    assert.equal((await tickV22AutoPromotion()).reason, "no_candidate");
    const candidates = queries.find((sql) => sql.includes(`FROM "AmuxPortfolioScoreSnapshot"`));
    assert.ok(candidates, "the tick read its candidates");
    const flat = candidates.replace(/\s+/g, " ");
    // The same condition as readiness's dependency_incomplete (lib/amux/v4TaskReadyCore.ts).
    assert.match(flat, /NOT EXISTS \(SELECT 1 FROM "AmuxWorkDependency" d JOIN "AmuxWorkItem" dep ON dep\."id" = d\."dependencyId" WHERE d\."taskId" = w\."id" AND \(dep\."status" <> 'done' OR dep\."v4TerminalAt" IS NULL OR \?\)\)/);
    // ...and readiness's dependency_unpublished, from the one shared condition
    // (lib/amux/v4DependencyPublication.ts) on the same `dep` row.
    const unpublished = fragments.map((sql) => sql.replace(/\s+/g, " "))
      .find((sql) => sql.includes(`"AmuxV22TaskPatch"`));
    assert.ok(unpublished, "the window reads the unpublished-patch condition");
    assert.match(unpublished, /a\."taskId" = dep\."id"/);
    // The exclusion comes before the window is cut.
    assert.ok(flat.indexOf(`"AmuxWorkDependency"`) < flat.indexOf("LIMIT"));
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_V22_AUTO_PROMOTE;
    else process.env.TOMVERSE_AMUX_V22_AUTO_PROMOTE = previous;
  }
});
