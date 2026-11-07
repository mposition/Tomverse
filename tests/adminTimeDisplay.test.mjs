import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * The operator reads every time in the Admin console as AEST, so the console
 * must not print "UTC". This scans the console's source for the word outside
 * comments: a string, a template or JSX text that says UTC fails the test.
 *
 * Code that merely computes in UTC (`Date.UTC`, `getUTCHours`, `toUTCString`)
 * is fine and is not matched: only the standalone word `UTC` is, and a call to
 * `Date.UTC(` is skipped.
 */
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SCANNED = [
  "components/admin",
  "lib/adminMessages",
  "app/(site)/(application)/admin",
];

/**
 * Agent Office is being rebuilt in another session, so editing its files here
 * would collide with it. These two sit inside the scanned folders; the third
 * part, lib/agentOffice/*, is outside them. Their remaining UTC wording is a known
 * follow-up; delete an entry when the file is converted.
 */
const EXEMPT = new Set([
  "components/admin/AgentOfficePanel.tsx",
  "lib/adminMessages/agentOffice.ts",
]);

const stripComments = (source) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, (block) => block.replace(/[^\n]/g, " "))
    .replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");

/** Lines (1-based) where the word UTC appears outside a comment and is not `Date.UTC(`. */
const utcLines = (source) =>
  stripComments(source)
    .split("\n")
    .flatMap((line, index) => (/\bUTC\b/.test(line.replace(/\.UTC\(/g, "")) ? [index + 1] : []));

const sourceFiles = (dir) =>
  readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((entry) => {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) return sourceFiles(relative);
    return /\.tsx?$/.test(entry.name) ? [relative] : [];
  });

test("the scanner flags UTC in a string, a template and JSX text, and ignores comments and code", () => {
  assert.deepEqual(utcLines('const a = "12:00 UTC";'), [1]);
  assert.deepEqual(utcLines("const a = `${time} UTC`;"), [1]);
  assert.deepEqual(utcLines("<span>{time}\n  UTC\n</span>"), [2]);
  assert.deepEqual(utcLines('new Intl.DateTimeFormat("en", { timeZone: "UTC" });'), [1]);
  assert.deepEqual(utcLines("// shown in UTC\nconst a = 1; // still UTC here"), []);
  assert.deepEqual(utcLines("/* the UTC day\n   boundary */\nconst a = 1;"), []);
  assert.deepEqual(utcLines("const t = Date.UTC(2026, 10, 7) + date.getUTCHours();"), []);
  assert.deepEqual(utcLines('const o = "AMUX_REVIEW_OUTCOME_UNAVAILABLE";'), []);
  assert.deepEqual(utcLines('const u = "https://example.test/UTC";'), [1]);
});

test("the Admin console prints no UTC on screen", () => {
  const offenders = SCANNED.flatMap(sourceFiles)
    .filter((file) => !EXEMPT.has(file))
    .flatMap((file) => {
      const lines = utcLines(readFileSync(path.join(ROOT, file), "utf8"));
      return lines.map((line) => `${file}:${line}`);
    });
  assert.deepEqual(offenders, [], "These lines still print UTC. Convert the time with formatAestDateTime/formatAestDate.");
});

test("the exempt files exist, so a rename cannot leave a stale exemption behind", () => {
  for (const file of EXEMPT) {
    assert.doesNotThrow(() => readFileSync(path.join(ROOT, file), "utf8"), file);
  }
});
