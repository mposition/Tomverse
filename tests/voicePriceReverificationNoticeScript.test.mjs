import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { test } from "node:test";

// Drives the notifier as a process, the way the scheduled workflow runs it.
//
// The unit test beside this one covers the rule; this covers the script --
// grouping, the de-duplication marker, and what the comment actually says.
// A notice that is computed correctly and then posted twice, or posted with
// a marker that cannot be matched again, is still a broken notice.

const run = (...args) => {
  const result = spawnSync(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/notify-voice-price-reverification.mjs",
      "--dry-run",
      ...args,
    ],
    { encoding: "utf8", env: { ...process.env, GITHUB_TOKEN: "", GITHUB_REPOSITORY: "" } }
  );
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
};

test("nothing is sent while every deadline is outside the window", () => {
  const output = run("--now=2026-10-31");
  assert.match(output, /Nothing to send/);
  assert.doesNotMatch(output, /would post/);
});

test("the thirty-day mark posts once, to the ticket the register names", () => {
  const output = run("--now=2026-11-01");
  assert.match(output, /would post to #1247 \(30-day mark\)/);
  assert.equal(
    output.match(/would post to/g)?.length,
    1,
    "two models sharing a ticket and a deadline get one comment, not two"
  );
  assert.match(output, /gpt-4o-mini-transcribe/);
  assert.match(output, /gpt-4o-transcribe/);
});

test("each mark carries its own marker, or a later notice is suppressed by an earlier one", () => {
  // The defect this pins: matching on a marker that does not name the mark
  // meant the 30-day comment already on the thread would suppress the 14- and
  // 7-day ones, and the notice nearest the deadline is the one that matters.
  const marker = (output) =>
    /<!-- voice-price-reverification-notice:([^ ]+) -->/.exec(output)?.[1];
  const thirty = marker(run("--now=2026-11-01"));
  const fourteen = marker(run("--now=2026-11-17"));
  const seven = marker(run("--now=2026-11-24"));
  assert.equal(thirty, "2026-12-01:30d");
  assert.equal(fourteen, "2026-12-01:14d");
  assert.equal(seven, "2026-12-01:7d");
  assert.equal(new Set([thirty, fourteen, seven]).size, 3);
});

test("the marker carries the deadline, so moving it re-arms the notices", () => {
  // A deadline that moves is a new deadline. Keying the marker on the mark
  // alone would leave the next cycle silent because the last one had spoken.
  assert.match(run("--now=2026-11-01"), /notice:2026-12-01:30d/);
});

test("the notice says what closes it, and does not offer to close it itself", () => {
  const output = run("--now=2026-11-24");
  assert.match(output, /re-read the provider's own pricing page/);
  assert.match(output, /Moving the deadline without re-reading the price/);
  assert.match(
    output,
    /it does not block anything/,
    "the warning window has to say it is not the gate, or it reads as one"
  );
});

test("the deadline is still described as a gate, because it is one", () => {
  const output = run("--now=2026-11-24");
  assert.match(output, /check:voice-price-register/);
  assert.match(output, /every pull request is blocked/);
});
