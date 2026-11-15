import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  AMUX_IDEA_TITLE_MAX,
  amuxIdeaName,
  amuxIdeaNameText,
  amuxIdeaTitleFromText,
} from "../lib/amux/ideaTitleCore.ts";
import { suggestionIdeaText } from "../lib/productResearchScoutCore.ts";

test("the title is the first line, trimmed, without the Scout prefix", () => {
  assert.equal(amuxIdeaTitleFromText("  Fix the login banner  \nmore detail\nand more"), "Fix the login banner");
  assert.equal(amuxIdeaTitleFromText("one\r\ntwo"), "one");
  assert.equal(amuxIdeaTitleFromText("[Scout 제안] 가격 표가 잘립니다\n대상: home.en"), "가격 표가 잘립니다");
  assert.equal(amuxIdeaTitleFromText(suggestionIdeaText({ subject: "home.en", title: "Hero copy is vague",
    area: "copy", severity: "low", evidence: "e", suggestion: "s" })), "Hero copy is vague");
  // Only a leading prefix is removed.
  assert.equal(amuxIdeaTitleFromText("Keep [Scout 제안] inside"), "Keep [Scout 제안] inside");
  assert.equal(amuxIdeaTitleFromText("a\t\tb\u0007c"), "a b c");
});

test("a blank first line gives way to the first line with text; no text gives no title", () => {
  assert.equal(amuxIdeaTitleFromText("\n   \n  Second line wins\nthird"), "Second line wins");
  assert.equal(amuxIdeaTitleFromText(""), null);
  assert.equal(amuxIdeaTitleFromText(" \n\t\n"), null);
  assert.equal(amuxIdeaTitleFromText("[Scout 제안]   \nbody"), null);
});

test("a long first line is kept whole (owner direction 2026-11-15)", () => {
  const long = `${"y".repeat(500)} ${"한".repeat(300)} ${"😀".repeat(100)}`;
  assert.equal(amuxIdeaTitleFromText(`${long}\nrest`, false), long);
  assert.equal(amuxIdeaTitleFromText(`${long}\nrest`), long, "the new behaviour is the default");
  assert.ok(!amuxIdeaTitleFromText(`${"z".repeat(78)}  tail tail`, false).includes("…"));
});

test("with the legacy switch a long first line is cut to 80 characters with an ellipsis, counting code points", () => {
  assert.equal(AMUX_IDEA_TITLE_MAX, 80);
  const exact = "x".repeat(80);
  assert.equal(amuxIdeaTitleFromText(exact, true), exact);
  const cut = amuxIdeaTitleFromText(`${"y".repeat(81)}\nrest`, true);
  assert.equal(cut, `${"y".repeat(79)}…`);
  const emoji = amuxIdeaTitleFromText("😀".repeat(100), true);
  assert.equal(Array.from(emoji).length, 80);
  assert.equal(emoji, `${"😀".repeat(79)}…`);
  assert.equal(amuxIdeaTitleFromText(`${"z".repeat(78)}  tail tail`, true), `${"z".repeat(78)}…`);
  const previous = process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS;
  process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS = "enabled";
  try {
    assert.equal(amuxIdeaTitleFromText(`${"y".repeat(81)}`), `${"y".repeat(79)}…`, "the switch is read from the environment");
  } finally {
    if (previous === undefined) delete process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS;
    else process.env.TOMVERSE_AMUX_INTAKE_LEGACY_LIMITS = previous;
  }
});

test("an idea is named by its card key, then its title with the short id, then the short id", () => {
  const requestId = "4ed13f4c-1111-4111-8111-111111111111";
  assert.deepEqual(amuxIdeaName({ displayKey: "AMUX-12", title: "Title", requestId }, "Idea"),
    { primary: "AMUX-12", shortId: null });
  assert.deepEqual(amuxIdeaName({ displayKey: null, title: "Title", requestId }, "Idea"),
    { primary: "Title", shortId: "4ed13f4c" });
  assert.deepEqual(amuxIdeaName({ displayKey: null, title: null, requestId }, "Idea"),
    { primary: "Idea 4ed13f4c", shortId: null });
  assert.deepEqual(amuxIdeaName({ displayKey: null, requestId }, "아이디어"),
    { primary: "아이디어 4ed13f4c", shortId: null });
  assert.equal(amuxIdeaNameText({ displayKey: null, title: "Title", requestId }, "Idea"), "Title (4ed13f4c)");
});

test("the migration backfills only sent Scout ideas whose body still exists, with the same cut", () => {
  const sql = readFileSync(new URL("../prisma/migrations/20261104130000_amux_idea_title/migration.sql",
    import.meta.url), "utf8");
  assert.match(sql, /ADD COLUMN "title" TEXT;/);
  assert.match(sql, /"AmuxIdeaSubmission_title_check" CHECK/);
  assert.match(sql, /"rawPurgedAt" IS NULL AND "rawCiphertext" IS NOT NULL/);
  assert.match(sql, /char_length\("title"\) BETWEEN 1 AND 80/);
  assert.match(sql, /FROM "ProductResearchSuggestion" s/);
  assert.match(sql, /left\(source\."title", 79\)\) \|\| '…'/);
  // The raw purge clears the title in the same update that clears the body.
  const purge = readFileSync(new URL("../lib/amux/ideaRawRetentionService.ts", import.meta.url), "utf8");
  assert.match(purge, /data: \{ rawCiphertext: null, rawKeyId: null, rawKeyVersion: null, title: null,/);
});

test("the 2026-11-15 migration drops only the length cap and keeps the purge rule", () => {
  const dir = "../prisma/migrations/20261116010700_amux_idea_title_no_length_cap/";
  const sql = readFileSync(new URL(`${dir}migration.sql`, import.meta.url), "utf8");
  const statements = sql.split(/\r?\n/).filter((line) => !line.startsWith("--")).join("\n");
  assert.match(statements, /DROP CONSTRAINT "AmuxIdeaSubmission_title_check",\s*ADD CONSTRAINT "AmuxIdeaSubmission_title_check" CHECK/);
  assert.match(statements, /"rawPurgedAt" IS NULL AND "rawCiphertext" IS NOT NULL/);
  assert.match(statements, /char_length\("title"\) >= 1/);
  assert.doesNotMatch(statements, /80|<=|BETWEEN|UPDATE|DELETE/);
  const sidecar = JSON.parse(readFileSync(new URL(`${dir}baseline-check.json`, import.meta.url), "utf8"));
  assert.deepEqual(sidecar.replacedChecks.map((check) => [check.table, check.constraint]),
    [["AmuxIdeaSubmission", "AmuxIdeaSubmission_title_check"]]);
});
