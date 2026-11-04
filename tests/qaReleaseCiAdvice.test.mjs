import assert from "node:assert/strict";
import test from "node:test";

import { runQaReleaseCiAdviceRound } from "../lib/qaReleaseCiAdvice.ts";
import { QA_RELEASE_CI_ADVICE_EVERY_MS, qaReleaseCiAdviceDue, qaReleaseCiAdviceFrom, qaReleaseCiAdviceInput, qaReleaseCiAdvicePrompt } from "../lib/qaReleaseCiAdviceCore.ts";

const T = Date.parse("2026-11-04T12:00:00Z");
const check = (name, startMin, doneMin, conclusion = "success") => ({
  name,
  startedAt: new Date(T + startMin * 60_000).toISOString(),
  completedAt: new Date(T + doneMin * 60_000).toISOString(),
  conclusion,
});
const hour = { hour: "2026-11-04T01", samples: 10, queued: 5, full: 2, peak: 44 };

test("the input is names and numbers: slowest first, skipped left out, runner load as percentages", () => {
  const input = qaReleaseCiAdviceInput({
    checksByCommit: [
      [check("e2e", 0, 30), check("unit", 1, 11, "failure"), check("never", 0, 0, "skipped")],
      [check("e2e", 0, 20), check("unit", 0, 10)],
    ],
    saturation: [hour],
    budget: 40,
  });
  assert.deepEqual(input.wallMinutes, [30, 20]);
  assert.deepEqual(input.jobs, [
    { name: "e2e", medianMinutes: 20, runs: 2, failed: 0 },
    { name: "unit", medianMinutes: 10, runs: 2, failed: 1 },
  ]);
  assert.deepEqual(input.runners, { hours: 1, fullPercent: 20, queuedPercent: 50, peak: 44, budget: 40 });
  assert.doesNotMatch(qaReleaseCiAdvicePrompt(input), /never/);
  // No runner record yet is unknown, not zero; no finished CI is nothing to ask about.
  assert.equal(qaReleaseCiAdviceInput({ checksByCommit: [[check("e2e", 0, 5)]], saturation: [], budget: 40 }).runners, null);
  assert.equal(qaReleaseCiAdviceInput({ checksByCommit: [], saturation: [hour], budget: 40 }), null);
});

test("an answer is kept only in the stored shape, and cut to what Admin shows", () => {
  assert.equal(qaReleaseCiAdviceFrom(null), null);
  assert.equal(qaReleaseCiAdviceFrom({ suggestions: "x" }), null);
  assert.equal(qaReleaseCiAdviceFrom({ suggestions: [{ title: "", why: "", change: "", savesMinutes: 1 }] }), null);
  assert.deepEqual(qaReleaseCiAdviceFrom({ suggestions: [] }), []);
  const [kept] = qaReleaseCiAdviceFrom({ suggestions: [{ title: "t", why: "w".repeat(900), change: "c", savesMinutes: -3 }] });
  assert.equal(kept.why.length, 700);
  assert.equal(kept.savesMinutes, null);
});

const ports = (overrides = {}) => {
  const calls = { asked: 0, saved: [] };
  return {
    calls,
    ports: {
      app: { read: async () => ({ askedAt: null, saturation: [hour], budget: 40, ...overrides.state }), save: async (at, suggestions) => void calls.saved.push([at, suggestions]) },
      checks: overrides.checks ?? (async () => [[check("e2e", 0, 30)]]),
      ask: overrides.ask ?? (async () => { calls.asked += 1; return [{ title: "t", why: "w", change: "c", savesMinutes: 5 }]; }),
    },
  };
};

test("at most one paid call a day, and a failed one still moves the clock", async () => {
  const fresh = ports();
  assert.equal(await runQaReleaseCiAdviceRound(fresh.ports, T), "answered");
  assert.equal(fresh.calls.asked, 1);
  // Recorded before the call, then answered.
  assert.deepEqual(fresh.calls.saved.map(([, suggestions]) => suggestions === null), [true, false]);
  assert.equal(fresh.calls.saved[1][1].length, 1);

  const recent = ports({ state: { askedAt: new Date(T - 60_000).toISOString() } });
  assert.equal(await runQaReleaseCiAdviceRound(recent.ports, T), "not_due");
  assert.equal(recent.calls.asked, 0);
  assert.equal(qaReleaseCiAdviceDue(new Date(T - QA_RELEASE_CI_ADVICE_EVERY_MS).toISOString(), T), true);

  const refused = ports({ ask: async () => { throw new Error("502"); } });
  assert.equal(await runQaReleaseCiAdviceRound(refused.ports, T), "unanswered");
  assert.deepEqual(refused.calls.saved, [[new Date(T).toISOString(), null]]);

  const quiet = ports({ checks: async () => [] });
  assert.equal(await runQaReleaseCiAdviceRound(quiet.ports, T), "no_data");
  assert.equal(quiet.calls.asked, 0);

  // The ask could not be recorded: it is not paid for.
  const unrecorded = ports();
  unrecorded.ports.app.save = async () => { throw new Error("app_500"); };
  assert.equal(await runQaReleaseCiAdviceRound(unrecorded.ports, T), "failed");
  assert.equal(unrecorded.calls.asked, 0);

  // The answer could not be saved: the clock has moved, so the next round does not pay again.
  const lost = ports();
  let saves = 0;
  lost.ports.app.save = async () => { saves += 1; if (saves === 2) throw new Error("app_500"); };
  assert.equal(await runQaReleaseCiAdviceRound(lost.ports, T), "failed");
  assert.equal(lost.calls.asked, 1);
  assert.equal(saves, 2);

  const down = ports({ checks: async () => { throw new Error("github_500"); } });
  assert.equal(await runQaReleaseCiAdviceRound(down.ports, T), "failed");
  assert.deepEqual(down.calls.saved, []);
});
