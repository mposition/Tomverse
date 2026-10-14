import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import {
  AMUX_CARD_DISPLAY_KEY_PATTERN,
  AMUX_CARD_DISPLAY_MAX_NUMBER,
  AMUX_CARD_DISPLAY_PREFIX_PATTERN,
  AMUX_CARD_DISPLAY_RESERVED_PREFIXES,
  amuxFeatureDisplayPrefixCandidates,
  formatAmuxCardDisplayKey,
  pickAmuxFeatureDisplayPrefix,
  isAmuxCardDisplayKey,
  isAmuxCardDisplayPrefix,
  isAmuxFeatureDisplayPrefix,
  parseAmuxCardDisplayKey,
} from "../lib/amux/cardDisplayKeyCore.ts";

// docs/policy/amux-card-display-key.md §2-§4. The database enforces the same
// rules (prisma/migrations/20261014100000_amux_card_display_key); the last
// tests compare the two so neither moves alone.

const MIGRATION = "prisma/migrations/20261014100000_amux_card_display_key/migration.sql";
const migration = readFileSync(MIGRATION, "utf8").replace(/\r\n/g, "\n");
const statements = migration.split("\n").filter((line) => !line.startsWith("--")).join("\n");

test("formats the policy's own example and pads to three digits", () => {
  assert.equal(formatAmuxCardDisplayKey("GITHUB", 1), "AMUX-GITHUB-001");
  assert.equal(formatAmuxCardDisplayKey("GITHUB", 42), "AMUX-GITHUB-042");
  assert.equal(formatAmuxCardDisplayKey("GITHUB", 999), "AMUX-GITHUB-999");
  assert.equal(formatAmuxCardDisplayKey("GITHUB", 1000), "AMUX-GITHUB-1000");
  assert.equal(formatAmuxCardDisplayKey("A1", AMUX_CARD_DISPLAY_MAX_NUMBER), "AMUX-A1-999999999");
});

test("refuses a malformed prefix or an out-of-range number", () => {
  for (const prefix of ["", "A", "github", "GIT-HUB", "GIT_HUB", "ABCDEFGHIJKLMNOPQ", " GITHUB", "ÄB"]) {
    assert.throws(() => formatAmuxCardDisplayKey(prefix, 1), /prefix is invalid/, prefix);
  }
  for (const number of [0, -1, 1.5, Number.NaN, AMUX_CARD_DISPLAY_MAX_NUMBER + 1]) {
    assert.throws(() => formatAmuxCardDisplayKey("GITHUB", number), /out of range/, String(number));
  }
});

test("accepts exactly the keys the formatter can produce", () => {
  for (const key of ["AMUX-GITHUB-001", "AMUX-AB-010", "AMUX-ENG-100", "AMUX-X9-1000", "AMUX-ABCDEFGHIJKLMNOP-999999999"]) {
    assert.ok(isAmuxCardDisplayKey(key), key);
  }
  for (const key of [
    "AMUX-GITHUB-000", "AMUX-GITHUB-01", "AMUX-GITHUB-1", "AMUX-GITHUB-0001", "AMUX-GITHUB-01000",
    "AMUX-GITHUB-1000000000", "amux-GITHUB-001", "AMUX-github-001", "AMUX-G-001", "TASK-GITHUB-001",
    "AMUX-GITHUB-001 ", "AMUX-GIT-HUB-001", null, 1,
  ]) {
    assert.ok(!isAmuxCardDisplayKey(key), String(key));
  }
});

test("parse is the inverse of format", () => {
  for (const [prefix, number] of [["GITHUB", 1], ["ENG", 57], ["A1", 1000], ["ABCDEFGHIJKLMNOP", 999_999_999]]) {
    assert.deepEqual(parseAmuxCardDisplayKey(formatAmuxCardDisplayKey(prefix, number)), { prefix, number });
  }
  assert.equal(parseAmuxCardDisplayKey("AMUX-GITHUB-000"), null);
  assert.equal(parseAmuxCardDisplayKey(undefined), null);
});

test("reserved path prefixes are valid card prefixes but never Feature prefixes", () => {
  assert.deepEqual([...AMUX_CARD_DISPLAY_RESERVED_PREFIXES],
    ["WORKBOARD", "INTAKE", "LOCAL", "ENG", "IDEA", "SYNC", "LEGACY"]);
  for (const prefix of AMUX_CARD_DISPLAY_RESERVED_PREFIXES) {
    assert.ok(isAmuxCardDisplayPrefix(prefix), prefix);
    assert.ok(!isAmuxFeatureDisplayPrefix(prefix), prefix);
  }
  assert.ok(isAmuxFeatureDisplayPrefix("GITHUB"));
  assert.ok(!isAmuxFeatureDisplayPrefix("github"));
});

test("a taken Feature prefix falls back to the first free numbered variant within 16 characters", () => {
  // docs/policy/amux-intake.md v17 item 3.
  const candidates = amuxFeatureDisplayPrefixCandidates("GITHUB");
  assert.equal(candidates.length, 99);
  assert.deepEqual(candidates.slice(0, 3), ["GITHUB", "GITHUB2", "GITHUB3"]);
  assert.equal(candidates.at(-1), "GITHUB99");
  assert.equal(pickAmuxFeatureDisplayPrefix(candidates, new Set()), "GITHUB");
  assert.equal(pickAmuxFeatureDisplayPrefix(candidates, new Set(["GITHUB", "GITHUB2"])), "GITHUB3");
  assert.equal(pickAmuxFeatureDisplayPrefix(candidates, new Set(candidates)), null);

  const long = amuxFeatureDisplayPrefixCandidates("ABCDEFGHIJKLMNOP");
  assert.deepEqual(long.slice(0, 2), ["ABCDEFGHIJKLMNOP", "ABCDEFGHIJKLMNO2"]);
  assert.equal(long.at(-1), "ABCDEFGHIJKLMN99");
  assert.ok(long.every((prefix) => prefix.length <= 16 && isAmuxFeatureDisplayPrefix(prefix)));

  for (const proposal of [undefined, null, "github", "ENG", "A"]) {
    assert.deepEqual(amuxFeatureDisplayPrefixCandidates(proposal), [], String(proposal));
  }
  // A reserved prefix never appears as a variant either (ENG2 is not ENG).
  assert.deepEqual(amuxFeatureDisplayPrefixCandidates("EN").slice(0, 2), ["EN", "EN2"]);
});

test("the migration's CHECKs use the core's own patterns and reserved list", () => {
  assert.ok(statements.includes(`"displayKey" ~ '${AMUX_CARD_DISPLAY_KEY_PATTERN}'`));
  // The issued-number ledger and the issue trigger use the same pattern.
  assert.equal(statements.split(`'${AMUX_CARD_DISPLAY_KEY_PATTERN}'`).length - 1, 3);
  assert.ok(statements.includes(`"displayPrefix" ~ '${AMUX_CARD_DISPLAY_PREFIX_PATTERN}'`));
  assert.ok(statements.includes(`"prefix" ~ '${AMUX_CARD_DISPLAY_PREFIX_PATTERN}'`));
  assert.ok(statements.includes(`CHECK ("lastNumber" BETWEEN 1 AND ${AMUX_CARD_DISPLAY_MAX_NUMBER})`));
  const reserved = statements.match(/"displayPrefix" <> ALL \(ARRAY\[([^\]]*)\]::TEXT\[\]\)/);
  assert.ok(reserved, "the reserved list is in the Feature prefix CHECK");
  assert.deepEqual(Array.from(reserved[1].matchAll(/'([^']*)'/g), (match) => match[1]),
    [...AMUX_CARD_DISPLAY_RESERVED_PREFIXES]);
  assert.match(statements, /"level" = 'feature'/);
});

test("the migration is additive and writes no row", () => {
  assert.match(statements, /^BEGIN;$/m);
  assert.match(statements, /^COMMIT;$/m);
  assert.doesNotMatch(statements, /\bDROP\b|\bTRUNCATE\s+TABLE\b|\bVALIDATE\b|\bUPDATE\s+"|\bDELETE\s+FROM\b/i);
  // The only INSERT is the issue trigger recording a card's first number, in
  // the ledger of the card table's own schema.
  assert.equal((statements.match(/\bINSERT\s+INTO\b/gi) ?? []).length, 1);
  assert.match(statements,
    /'INSERT INTO %I\.%I \("displayKey", "workItemId"\) VALUES \(\$1, \$2\)',\n\s+TG_TABLE_SCHEMA, 'AmuxCardDisplayKeyIssued'\n\s+\) USING NEW\."displayKey", NEW\."id";/);
  assert.match(statements, /BEFORE INSERT ON "AmuxWorkItem"\nFOR EACH ROW\nWHEN \(NEW\."displayKey" IS NOT NULL\)/);
  assert.match(statements,
    /BEFORE UPDATE ON "AmuxWorkItem"\nFOR EACH ROW\nWHEN \(OLD\."displayKey" IS NULL AND NEW\."displayKey" IS NOT NULL\)/);
  assert.match(statements, /BEFORE UPDATE OR DELETE ON "AmuxCardDisplayKeyIssued"/);
  assert.match(statements, /BEFORE TRUNCATE ON "AmuxCardDisplayKeyIssued"/);
  // No foreign key, so a deleted card's number stays issued.
  assert.doesNotMatch(statements, /REFERENCES/);
  assert.equal((statements.match(/^ALTER TABLE "[A-Za-z]+" ADD COLUMN /gm) ?? []).length, 2);
  assert.match(statements, /ALTER TABLE "AmuxWorkItem" ADD COLUMN "displayKey" TEXT;/);
  assert.match(statements, /ALTER TABLE "AmuxPortfolioNode" ADD COLUMN "displayPrefix" TEXT;/);
  assert.match(statements, /CREATE UNIQUE INDEX "AmuxWorkItem_displayKey_key" ON "AmuxWorkItem"\("displayKey"\);/);
  assert.match(statements, /CREATE UNIQUE INDEX "AmuxPortfolioNode_displayPrefix_key" ON "AmuxPortfolioNode"\("displayPrefix"\);/);
  // The immutability triggers fire only when a set value would change.
  assert.match(statements,
    /BEFORE UPDATE ON "AmuxWorkItem"\nFOR EACH ROW\nWHEN \(OLD\."displayKey" IS NOT NULL AND NEW\."displayKey" IS DISTINCT FROM OLD\."displayKey"\)/);
  assert.match(statements,
    /BEFORE UPDATE ON "AmuxPortfolioNode"\nFOR EACH ROW\nWHEN \(OLD\."displayPrefix" IS NOT NULL AND NEW\."displayPrefix" IS DISTINCT FROM OLD\."displayPrefix"\)/);
  assert.match(statements, /BEFORE INSERT OR UPDATE OR DELETE ON "AmuxCardDisplayKeyCounter"/);
  assert.match(statements, /BEFORE TRUNCATE ON "AmuxCardDisplayKeyCounter"/);
});

test("the allocator is one bound INSERT ... ON CONFLICT that advances by one", () => {
  const allocator = readFileSync("lib/amux/cardDisplayKeyAllocator.ts", "utf8").replace(/\r\n/g, "\n");
  // Two statements: the counter's one INSERT, and the read-only Feature prefix lookup.
  assert.equal((allocator.match(/\.\$queryRaw\b/g) ?? []).length, 2);
  assert.equal((allocator.match(/\bINSERT INTO\b/g) ?? []).length, 1);
  assert.match(allocator, /SELECT "displayPrefix" FROM "AmuxPortfolioNode"\n\s+WHERE "displayPrefix" = ANY\(\$\{candidates\}::TEXT\[\]\)/);
  assert.doesNotMatch(allocator, /\$queryRawUnsafe|\$executeRawUnsafe|Prisma\.raw/);
  assert.match(allocator, /VALUES \(\$\{prefix\}, 1\)/);
  assert.match(allocator,
    /ON CONFLICT \("prefix"\) DO UPDATE\n\s+SET "lastNumber" = "AmuxCardDisplayKeyCounter"\."lastNumber" \+ 1\n\s+RETURNING "lastNumber"/);
  assert.match(allocator, /if \(!isAmuxCardDisplayPrefix\(prefix\)\)/);
});
