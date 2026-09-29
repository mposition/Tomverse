import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { scoreAmuxWorkers } from "@/lib/amux/workerRouterCore";

const golden = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests/fixtures/amux-worker-routing-v1.json"),
    "utf8",
  ),
);

test("shared worker routing golden exercises the actual TypeScript scorer", () => {
  assert.equal(golden.version, "amux-worker-router-v1");
  for (const entry of golden.cases) {
    const score = scoreAmuxWorkers(entry.task, entry.candidates);
    assert.equal(
      score.preferred_worker,
      entry.expected.preferred_worker,
      entry.name,
    );
    assert.equal(
      score.selected_worker,
      entry.expected.selected_worker,
      entry.name,
    );
    assert.deepEqual(
      score.candidates.map((row) => row.worker_name),
      entry.expected.candidate_names,
    );
    assert.deepEqual(
      score.candidates.map((row) => row.breakdown.selected_eligible),
      entry.expected.selected_eligible,
    );
    for (const [actual, expected] of [
      [score.preferred_score, entry.expected.preferred_score],
      [score.selected_score, entry.expected.selected_score],
    ]) {
      if (expected !== undefined) {
        assert.ok(Math.abs(actual - expected) < 1e-12, entry.name);
      }
    }
  }
});
