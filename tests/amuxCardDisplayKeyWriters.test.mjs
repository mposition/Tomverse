import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { AMUX_CARD_DISPLAY_PATH_PREFIX } from "../lib/amux/cardDisplayKeyCore.ts";

// docs/policy/amux-card-display-key.md §2-1 and §4: every card a writer creates
// gets its number in the same transaction, from its registration path's prefix.
// This finds every place application code creates an AmuxWorkItem, so a new
// creation path fails here until it is numbered or named as pending.

const root = process.cwd();
const sourceFiles = (directory) =>
  readdirSync(join(root, directory), { recursive: true })
    .map((name) => `${directory}/${String(name).replaceAll("\\", "/")}`)
    .filter((path) => /\.(?:ts|tsx|mts|mjs)$/.test(path));
const read = (path) => readFileSync(join(root, path), "utf8").replace(/\r\n/g, "\n");

const CREATES_CARD = /\.amuxWorkItem\.(?:create|createMany|upsert)\s*\(|INSERT\s+INTO\s+(?:public\.)?"AmuxWorkItem"/;

/** Each creating file and the policy §4 path it numbers under. */
const NUMBERED = {
  "lib/amux/intakeRegistration.ts": "conversationIntake",
  "lib/amux/localIntakeRegistration.ts": "localIntake",
  "lib/amux/agentIntake.ts": "engineeringAgent",
  "lib/amux/boardImportService.ts": "workboardImport",
  "app/api/internal/amux/tasks/route.ts": "snapshotSync",
};

/**
 * Not numbered yet, each with the stage that numbers it. Shrinks only.
 * The v4 idea path takes its Feature's prefix, which needs the intake
 * proposal change of stage S3b; its cards are numbered by the backfill until
 * then.
 */
const PENDING = {
  "lib/amux/ideaUnitDecisionStore.ts": "S3b",
};

const creators = [...sourceFiles("lib"), ...sourceFiles("app")]
  .filter((path) => CREATES_CARD.test(read(path)))
  .sort();

test("every file that creates a card is numbered or named as pending", () => {
  assert.deepEqual(creators, [...Object.keys(NUMBERED), ...Object.keys(PENDING)].sort());
});

test("each numbered writer allocates from its own path's prefix and writes the key it got", () => {
  for (const [path, entry] of Object.entries(NUMBERED)) {
    const source = read(path);
    assert.ok(entry in AMUX_CARD_DISPLAY_PATH_PREFIX, `${path}: ${entry} is not a policy §4 path`);
    const allocations = [...source.matchAll(/allocateAmuxCardDisplayKey\(tx, AMUX_CARD_DISPLAY_PATH_PREFIX\.(\w+)\)/g)];
    assert.deepEqual(allocations.map((match) => match[1]), [entry], `${path} allocates once, under ${entry}`);
    // The allocation sits just before the one create it numbers, which then
    // carries the allocated key.
    const allocationAt = allocations[0].index;
    const createAt = source.indexOf(".amuxWorkItem.create(", allocationAt);
    assert.ok(createAt > allocationAt, `${path}: the create follows the allocation`);
    assert.equal(source.indexOf(".amuxWorkItem.create("), createAt, `${path}: no create precedes the allocation`);
    const createCall = source.slice(createAt, source.indexOf(");", createAt));
    assert.match(createCall, /\bdisplayKey\b/, `${path}: the create writes displayKey`);
  }
});

test("no writer spends a number on a skipped upsert", () => {
  // The issue trigger records a number before the row is written
  // (prisma/migrations/20261014100000_amux_card_display_key), so an
  // INSERT ... ON CONFLICT DO NOTHING that skips the card would still spend it.
  for (const path of Object.keys(NUMBERED)) {
    assert.doesNotMatch(read(path), /\.amuxWorkItem\.upsert\s*\(|ON CONFLICT[^;]*DO NOTHING/i, path);
  }
});
