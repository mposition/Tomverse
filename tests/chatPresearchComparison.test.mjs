import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, rmdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { comparePresearch } from "../scripts/compare-chat-presearch.mjs";

const ids = Array.from({ length: 8 }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
const pairs = Array.from({ length: 4 }, (_, i) => ({ caseId: "search", repeat: i, off: ids[i * 2], on: ids[i * 2 + 1] }));
function event(i) {
  const enabled = i % 2 === 1;
  return { event: "chat_turn_timing", outcome: "completed", traceId: ids[i], modelId: i === 3 ? "other" : "same",
    serverMsToFirstVisibleChunk: 100, serverMsToSettlement: 200,
    search: { flagEnabled: enabled, selectionEligible: true, planOffered: enabled,
      plannedQueries: +enabled, presearchEntered: enabled, presearchBackendRequests: +enabled,
      evidenceInjected: enabled, injectedSources: +enabled, modelCalls: i === 1 ? 1 : 2, finishedSteps: i === 1 ? 1 : 2,
      modelCallsWithSearchResults: i === 1 ? 0 : 1, toolOnlySearchSteps: i === 1 ? 0 : 1,
      searchToolCalls: i === 1 ? 0 : 1, searchStepsAfterResults: 0,
      answerBackendRequests: enabled ? 0 : 1, successfulBackendRequests: 1, returnedSources: 1, sourceCards: 1,
      mentionedSources: 0, mentionedInjectedSources: 0, raw: "private answer" } };
}
function timing(i) {
  return { id: ids[i] + ":client", source: "client", mode: "auto", product: "chat", outcome: "completed",
    timings: { firstContentMs: i % 2 ? 500 : 1500, completionMs: 2000 } };
}
test("paired comparisons count actual dispatches, keep missing signed timings and unmatched events out of the denominator", () => {
  const logs = ids.slice(0, 7).map((_, i) => event(i));
  logs[5].search.flagEnabled = false;
  logs[1] = { message: JSON.stringify(logs[1]) };
  const report = comparePresearch(pairs, logs, [timing(0), timing(1), timing(2)]);
  assert.equal(report.pairs, 4);
  assert.equal(report.eligibleCompletedPairs, 2);
  assert.equal(report.sameModelPairs, 1);
  assert.equal(report.injectedWithSourcesPairs, 2);
  assert.equal(report.fewerModelCallsPairs, 1);
  assert.deepEqual(report.matched.modelCalls.onMinusOff, { count: 2, p50: -1, p95: 0 });
  assert.deepEqual(report.matched.firstMs.onMinusOff, { count: 1, p50: -1000, p95: -1000 });
  assert.equal(report.matched.serverFirstMs.off.count, 2);
  assert.equal(report.rows[1].on.firstMs, null);
  assert.equal(report.rows[2].on.issue, "flag_mismatch");
  assert.equal(report.rows[3].on.issue, "missing_event");
  assert.ok(!JSON.stringify(report).includes("private answer"));
  assert.ok(ids.every(id => !JSON.stringify(report).includes(id)));
  assert.throws(() => comparePresearch([pairs[0], pairs[0]], logs, []), /more than once/);
  assert.throws(() => comparePresearch(pairs, [event(0), { ...event(0), modelId: "conflict" }], []), /Conflicting/);
});

test("CLI joins exported JSONL logs and signed timings without a database", async t => {
  const dir = await mkdtemp(join(tmpdir(), "chat-presearch-"));
  const files = ["pairs.json", "logs.jsonl", "timings.json"].map(name => join(dir, name));
  t.after(async () => {
    await Promise.all(files.map(file => unlink(file)));
    await rmdir(dir);
  });
  await Promise.all([
    writeFile(files[0], JSON.stringify([pairs[0]])),
    writeFile(files[1], [event(0), event(1)].map(e => JSON.stringify({ message: JSON.stringify(e) })).join("\n")),
    writeFile(files[2], "\uFEFF" + JSON.stringify([timing(0), timing(1)])),
  ]);
  const report = JSON.parse(execFileSync(process.execPath, ["--import", "tsx", "scripts/compare-chat-presearch.mjs",
    "--pairs", files[0], "--logs", files[1], "--timings", files[2]], { encoding: "utf8" }));
  assert.equal(report.matched.completionMs.off.count, 1);
  assert.equal(report.fewerModelCallsPairs, 1);
});
