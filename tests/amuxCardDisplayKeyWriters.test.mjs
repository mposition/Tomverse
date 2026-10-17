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

/**
 * Each creating file and the prefix it numbers under: a policy §4 path, or
 * `feature` for the v4 idea path, whose card takes its Feature's prefix
 * (docs/policy/amux-intake.md v17 item 4).
 */
const NUMBERED = {
  "lib/amux/intakeRegistration.ts": "conversationIntake",
  "lib/amux/localIntakeRegistration.ts": "localIntake",
  "lib/amux/agentIntake.ts": "engineeringAgent",
  "lib/amux/boardImportService.ts": "workboardImport",
  "app/api/internal/amux/tasks/route.ts": "snapshotSync",
  "lib/amux/ideaUnitDecisionStore.ts": "feature",
};

/** What each prefix kind is passed to the allocator as. */
const allocationArgument = (entry) =>
  entry === "feature" ? "featureDisplayPrefix" : `AMUX_CARD_DISPLAY_PATH_PREFIX.${entry}`;

const creators = [...sourceFiles("lib"), ...sourceFiles("app")]
  .filter((path) => CREATES_CARD.test(read(path)))
  .sort();

test("every file that creates a card is numbered", () => {
  assert.deepEqual(creators, Object.keys(NUMBERED).sort());
});

test("each writer allocates once from its own prefix and writes the key it got", () => {
  for (const [path, entry] of Object.entries(NUMBERED)) {
    const source = read(path);
    assert.ok(entry === "feature" || entry in AMUX_CARD_DISPLAY_PATH_PREFIX,
      `${path}: ${entry} is not a policy §4 path`);
    // Exactly one card-creating call per file, so a second create, createMany,
    // upsert or raw INSERT added beside the numbered one fails here.
    const creations = source.match(new RegExp(CREATES_CARD.source, "g")) ?? [];
    assert.equal(creations.length, 1, `${path} creates cards in exactly one place`);
    const allocations = [...source.matchAll(/allocateAmuxCardDisplayKey\(tx, ([\w.]+)\)/g)];
    assert.deepEqual(allocations.map((match) => match[1]), [allocationArgument(entry)],
      `${path} allocates once, from ${allocationArgument(entry)}`);
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

test("the v4 node commit writes the chosen Feature prefix and audits both values", () => {
  // docs/policy/amux-intake.md v17 item 3. The DB test covers the choice
  // itself; this pins the wiring between it, the audit and the node row.
  const source = read("lib/amux/ideaUnitDecisionStore.ts");
  const commit = source.slice(source.indexOf("export async function commitAmuxV4NodeCreation"),
    source.indexOf("export async function commitAmuxV4UnitRejection"));
  const chooseAt = commit.indexOf("await chooseAmuxFeatureDisplayPrefix(tx, plan.displayPrefix)");
  const auditAt = commit.indexOf("await writeAmuxRegistrationAudit(");
  const createAt = commit.indexOf("await tx.amuxPortfolioNode.create(");
  assert.ok(chooseAt > 0 && chooseAt < auditAt && auditAt < createAt, "choose, then audit, then create");
  assert.match(commit.slice(auditAt, createAt),
    /proposedDisplayPrefix: plan\.displayPrefix,\s*displayPrefix \}/, "the audit records proposed and assigned");
  assert.match(commit.slice(createAt, commit.indexOf("} });", createAt)), /\bdisplayPrefix,/,
    "the node row gets the chosen prefix");

  // docs/policy/amux-intake.md v17 item 4: the card's prefix is the one read
  // from the Feature row the registration locks.
  const register = source.slice(source.indexOf("export async function commitAmuxV4CardRegistration"),
    source.indexOf("export async function commitAmuxV4NodeCreation"));
  assert.match(register, /"contentDigest", "contentDigestKeyId", "displayPrefix"\n\s+FROM "AmuxPortfolioNode" WHERE "id" = \$\{target\.id\} FOR SHARE/);
  assert.match(register, /if \(target\.level === "feature"\) featureDisplayPrefix = current\?\.displayPrefix \?\? null;/);
});

test("no writer spends a number on a skipped upsert", () => {
  // The issue trigger records a number before the row is written
  // (prisma/migrations/20261014100000_amux_card_display_key), so an
  // INSERT ... ON CONFLICT DO NOTHING that skips the card would still spend it.
  for (const path of Object.keys(NUMBERED)) {
    assert.doesNotMatch(read(path), /\.amuxWorkItem\.upsert\s*\(|ON CONFLICT[^;]*DO NOTHING/i, path);
  }
});
