import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { AMUX_DB_BOUNDARIES } from "../lib/amux/dbBoundary.ts";
import {
  AMUX_IDEA_LANE_BOARD_DONE_MS, AMUX_IDEA_LANE_BOARD_LIMIT, amuxIdeaLaneBoardCard, amuxIdeaLaneBoardHref,
} from "../lib/amux/ideaLaneBoardCore.ts";
import { AMUX_IDEA_LANE_ENV } from "../lib/amux/ideaLaneCore.ts";
import { readAmuxIdeaLaneBoardInTx } from "../lib/amux/ideaLaneBoardRead.ts";

const read = (path) => readFileSync(join(process.cwd(), path), "utf8");
const NOW = Date.parse("2026-11-04T09:00:00Z");
const MIN = 60_000;
const REQUEST = "11111111-1111-4111-8111-111111111111";
const idea = (laneAttempts = [], overrides = {}) => ({
  requestId: REQUEST, title: "Show lane work on the board", submissionOrigin: "owner", state: "submitted",
  cancelled: false, rawReadable: true, analysisDeadlineMs: NOW + 86_400_000, sourcePlan: false, chunks: 0,
  laneAttempts, ...overrides,
});
const attempt = (overrides = {}) => ({ claimedAtMs: NOW - 30 * MIN, leaseUntilMs: NOW + 60 * MIN, outcome: null,
  prNumber: null, mergedAtMs: null, prClosedAtMs: null, ...overrides });
const ended = (outcome, overrides = {}) => attempt({ leaseUntilMs: NOW - MIN, outcome, ...overrides });
const column = (value, enabled = true) => amuxIdeaLaneBoardCard(value, NOW, enabled)?.column ?? null;

test("each lane state sits in the board column of the same stage", () => {
  assert.equal(column(idea()), "amux_backlog", "waiting for the lane's claim, as the Ideas list says");
  assert.equal(column(idea([attempt()])), "in_progress", "a run holds its lease");
  const open = amuxIdeaLaneBoardCard(idea([ended("pr_open", { prNumber: 3301 })]), NOW, true);
  assert.deepEqual([open.column, open.state, open.prNumber], ["in_review", "pr_open", 3301]);
  assert.equal(column(idea([ended("pr_open", { prNumber: 3301, mergedAtMs: NOW - 60 * MIN })])), "done");
  assert.equal(column(idea([ended("pr_open", { prNumber: 3301, prClosedAtMs: NOW - MIN })])), "attention",
    "a PR closed without a merge needs the owner");
  assert.equal(column(idea([ended("cli_failed"), ended("no_change"), ended("job_failed")])), "attention",
    "out of attempts");
  assert.equal(column(idea([ended("cli_failed")])), "amux_backlog", "a failed run with attempts left waits for its retry");
});

test("attempts already made show with the lane off; an untouched idea waits only while it is on", () => {
  assert.equal(column(idea(), false), null);
  assert.equal(column(idea([attempt()]), false), "in_progress");
  assert.equal(column(idea([ended("pr_open", { prNumber: 7 })]), false), "in_review");
  // The Ideas list's candidate conditions: an idea analysis has taken is not the lane's.
  for (const overrides of [{ chunks: 1 }, { sourcePlan: true }, { rawReadable: false }, { state: "awaiting_owner" },
    { submissionOrigin: "session" }, { analysisDeadlineMs: NOW - 1 }]) assert.equal(column(idea([], overrides)), null);
});

test("Done keeps a merged idea for seven days, counted from its first merge", () => {
  const merged = (agoMs) => idea([ended("pr_open", { prNumber: 1, mergedAtMs: NOW - agoMs })]);
  assert.equal(AMUX_IDEA_LANE_BOARD_DONE_MS, 7 * 86_400_000);
  assert.equal(column(merged(AMUX_IDEA_LANE_BOARD_DONE_MS - MIN)), "done");
  assert.equal(column(merged(AMUX_IDEA_LANE_BOARD_DONE_MS)), null);
  assert.equal(column(idea([ended("pr_open", { prNumber: 1, mergedAtMs: NOW - 8 * 86_400_000 }),
    ended("pr_open", { prNumber: 2, mergedAtMs: NOW - MIN, claimedAtMs: NOW - 10 * MIN })])), null);
});

test("a merged part that names more work is not Done: the idea waits for, or runs, its next part", () => {
  const partOne = ended("pr_open", { prNumber: 1, continues: true, claimedAtMs: NOW - 9 * 86_400_000,
    mergedAtMs: NOW - 8 * 86_400_000 });
  assert.equal(column(idea([partOne])), "amux_backlog", "the next part waits for its claim, however old the merge");
  assert.equal(column(idea([partOne, attempt()])), "in_progress", "the next part's run shows, not the old merge");
  const partTwo = amuxIdeaLaneBoardCard(idea([partOne, ended("pr_open", { prNumber: 2 })]), NOW, true);
  assert.deepEqual([partTwo.column, partTwo.prNumber], ["in_review", 2]);
  // The final part keeps the idea in Done for its own seven days.
  const final = (agoMs) => idea([partOne, ended("pr_open", { prNumber: 2, mergedAtMs: NOW - agoMs })]);
  const done = amuxIdeaLaneBoardCard(final(MIN), NOW, true);
  assert.deepEqual([done.column, done.prNumber], ["done", 2], "counted from the final part, not the first merge");
  assert.equal(column(final(AMUX_IDEA_LANE_BOARD_DONE_MS)), null);
});

test("a card names the idea by title, else its id, and links to the idea's detail", () => {
  const card = amuxIdeaLaneBoardCard(idea([], { title: null }), NOW, true);
  assert.equal(card.title, null);
  assert.equal(amuxIdeaLaneBoardHref(REQUEST), `/admin/amux-backlog?tab=ideas&idea=${REQUEST}`);
  const ui = read("components/admin/AmuxExecutionWorkspace.tsx");
  assert.match(ui, /card\.title \?\? card\.requestId\.slice\(0, 8\)/);
  assert.match(ui, /<Link href=\{amuxIdeaLaneBoardHref\(card\.requestId\)\}/);
  assert.match(ui, /href=\{PR_URL \+ card\.prNumber\}/);
});

test("the board read is one bounded owner-scoped statement that never reads idea text", async () => {
  assert.deepEqual(AMUX_DB_BOUNDARIES.ideaLaneBoardRead,
    { operation: "idea_lane_board_read", prismaCallCeiling: 3, isolation: "read" });
  const previous = process.env[AMUX_IDEA_LANE_ENV];
  process.env[AMUX_IDEA_LANE_ENV] = "true";
  try {
    const calls = [];
    const tx = { $queryRaw: async (strings, ...values) => {
      calls.push({ sql: strings.join("?"), values });
      return [idea([attempt()]), idea([], { requestId: "22222222-2222-4222-8222-222222222222", chunks: 2 })];
    } };
    const cards = await readAmuxIdeaLaneBoardInTx(tx, "owner-1", new Date(NOW));
    assert.equal(calls.length, 1);
    const { sql, values } = calls[0];
    assert.equal(/Ciphertext|"body"|Digest/i.test(sql), false, "no idea body or digest is read");
    assert.deepEqual(sql.match(/\w+\."title"/g), ['s."title"']);
    assert.ok(values.includes("owner-1") && values.includes(AMUX_IDEA_LANE_BOARD_LIMIT) && values.includes(true));
    assert.ok(values.includes(new Date(NOW - AMUX_IDEA_LANE_BOARD_DONE_MS).toISOString()));
    assert.ok(sql.includes(`s."cancelledAt" IS NULL`), "a closed idea leaves the board");
    assert.ok(sql.includes(`'continues', l."continues"`), "the core needs it to tell a merged part from the idea done");
    assert.equal(/AmuxWorkItem|INSERT|UPDATE|DELETE/.test(sql), false, "it reads no card and writes nothing");
    assert.deepEqual(cards.map((card) => card.column), ["in_progress"], "the core drops an idea analysis took");
  } finally {
    if (previous === undefined) delete process.env[AMUX_IDEA_LANE_ENV];
    else process.env[AMUX_IDEA_LANE_ENV] = previous;
  }
});

test("lane cards offer no card controls and stay out of card counts and archive-all", () => {
  const ui = read("components/admin/AmuxExecutionWorkspace.tsx");
  const laneCard = ui.slice(ui.indexOf("function IdeaLaneCard("), ui.indexOf("export function AmuxExecutionWorkspace("));
  assert.ok(laneCard.length > 0);
  for (const control of ["<button", "draggable", "onDrag", "onPointer", "openMove", "openCard", "archive", "method:"])
    assert.equal(laneCard.includes(control), false, `a lane card has no ${control}`);
  // Counts, the attention total and archive-all read only the card snapshot.
  assert.match(ui, /const activeCardCount = board \? AMUX_EXECUTION_VISIBLE_LANES\.reduce\(\s*\(total, lane\) => total \+ board\.counts\[lane\], 0\) : 0;/);
  assert.match(ui, /await requestArchiveAllActiveCards\(\);/);
  assert.match(ui, /const laneCount = board\.counts\[lane\] \+ \(attention \? dmTotal : 0\);/);
  for (const line of ui.split("\n").filter((text) => /activeCardCount|archiveAll|laneCount|uniqueCards|loadedCards/.test(text)))
    assert.equal(/laneIdeas|laneCards|laneDone/.test(line), false, line);
  assert.equal(read("components/admin/amuxExecutionArchiveRequest.ts").includes("lane"), false);

  const page = read("app/(site)/(application)/admin/amux-execution/page.tsx");
  assert.match(page, /readAmuxIdeaLaneBoardForOwner\(session\.user\.id\)\.catch\(\(\) => null\)/);
  assert.match(page, /laneIdeas=\{laneIdeas\}/);
});

test("both locales name every lane state", async () => {
  const { adminAmuxExecutionMessages } = await import("../lib/adminMessages/amuxExecution.ts");
  for (const locale of ["en", "ko"]) {
    const lane = adminAmuxExecutionMessages[locale].ideaLane;
    assert.deepEqual(Object.keys(lane.state).sort(), ["failed", "merged", "pr_closed", "pr_open", "queued", "running"]);
    assert.equal(typeof lane.group(2), "string");
  }
});
