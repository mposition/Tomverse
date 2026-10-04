// A migration that replaces `EmailDelivery_skip_reason_check` replaces the whole
// list, so every value an earlier migration allowed has to be restated.
//
// The release-notes migration (20260928210000) rewrote the list from an older
// copy and dropped `campaign_cancelled`, which 20260915150000 had added. Nothing
// failed until a DB suite cancelled a campaign and the table refused the skip.
// This compares every definition with the one before it, in migration order, so a
// value can leave only by a migration that says so here.

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const CONSTRAINT = '"EmailDelivery_skip_reason_check"';

/** Values that were removed on purpose, with the migration that removed them. */
const DELIBERATELY_REMOVED = new Map();

const definitions = () =>
  readdirSync("prisma/migrations")
    .filter((dir) => /^\d{14}_/.test(dir))
    .sort()
    .flatMap((dir) => {
      const sql = readFileSync(`prisma/migrations/${dir}/migration.sql`, "utf8");
      const start = sql.indexOf(`ADD CONSTRAINT ${CONSTRAINT}`);
      if (start < 0) return [];
      const end = sql.indexOf("));", start);
      const body = sql.slice(start, end).replace(/--[^\n]*/g, "");
      return [{ dir, values: new Set([...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1])) }];
    });

test("every skip reason an earlier migration allowed is still allowed", () => {
  const all = definitions();
  assert.ok(all.length > 1, "expected more than one definition of the constraint");
  for (let index = 1; index < all.length; index += 1) {
    const previous = all[index - 1];
    const current = all[index];
    for (const value of previous.values) {
      if (current.values.has(value)) continue;
      assert.equal(
        DELIBERATELY_REMOVED.get(value),
        current.dir,
        `${current.dir} drops '${value}', which ${previous.dir} allowed`
      );
    }
  }
});
