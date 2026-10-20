import assert from "node:assert/strict";
import test from "node:test";

import { collectQaReleaseLatency } from "../lib/qaReleaseLatencyCollectCore.ts";

const A = "a".repeat(40);
const B = "b".repeat(40);
const NOW = Date.parse("2026-10-20T02:00:00Z");

function github(overrides = {}) {
  const pulls = overrides.pulls ?? [
    { number: 1, merged_at: "2026-10-20T01:00:00Z", merge_commit_sha: A },
    { number: 2, merged_at: "2026-10-20T01:30:00Z", merge_commit_sha: B },
    { number: 3, merged_at: null, merge_commit_sha: null },
    { number: 4, merged_at: "2026-10-18T00:00:00Z", merge_commit_sha: A },
  ];
  const checks = {
    [A]: [
      { status: "completed", started_at: "2026-10-20T01:00:30Z", completed_at: "2026-10-20T01:12:00Z" },
      // A short aggregate job that waited for a runner.
      { status: "completed", started_at: "2026-10-20T01:20:00Z", completed_at: "2026-10-20T01:20:06Z" },
    ],
    [B]: [
      { status: "completed", started_at: "2026-10-20T01:31:00Z", completed_at: "2026-10-20T01:40:00Z" },
      { status: "in_progress", started_at: "2026-10-20T01:32:00Z", completed_at: null },
    ],
  };
  return async (path) => {
    if (overrides.fail && path.includes(overrides.fail)) throw new Error("github_500");
    if (path.startsWith("/repos/mposition/Tomverse/pulls?")) return pulls;
    const check = path.match(/commits\/([0-9a-f]{40})\/check-runs/);
    if (check) return { check_runs: checks[check[1]] ?? [] };
    if (path.includes("/deployments?")) {
      assert.ok(path.includes(`environment=${encodeURIComponent("Tomverse / dev")}`));
      return path.includes(A) ? [{ id: 11 }] : [];
    }
    if (path.includes("/deployments/11/statuses")) {
      return [
        { state: "success", created_at: "2026-10-20T01:04:00Z" },
        { state: "in_progress", created_at: "2026-10-20T01:01:00Z" },
      ];
    }
    throw new Error(`unexpected ${path}`);
  };
}

test("each merge in the window is measured from its merge: runner wait, last start, last finish, dev deploy", async () => {
  const result = await collectQaReleaseLatency({ fetchJson: github(), nowMs: NOW });
  assert.equal(result.status, "ok");
  assert.deepEqual(result.merges, [
    // Newest first. Still running: no last finish; no dev deployment recorded.
    { pullRequest: 2, mergedAt: "2026-10-20T01:30:00.000Z", firstCheckStartMin: 1, lastCheckStartMin: 2, lastCheckDoneMin: null, devDeployedMin: null },
    { pullRequest: 1, mergedAt: "2026-10-20T01:00:00.000Z", firstCheckStartMin: 0.5, lastCheckStartMin: 20, lastCheckDoneMin: 20.1, devDeployedMin: 4 },
  ]);
  assert.deepEqual(result.summary, { medianDevDeployedMin: 4, maxDevDeployedMin: 4, medianLastCheckDoneMin: 20.1, maxLastCheckStartMin: 20 });
});

test("a failed read is unavailable, never an empty list", async () => {
  for (const fail of ["/pulls?", "check-runs", "/deployments?", "/statuses"]) {
    assert.deepEqual(await collectQaReleaseLatency({ fetchJson: github({ fail }), nowMs: NOW }), { status: "unavailable" }, fail);
  }
  const quiet = await collectQaReleaseLatency({ fetchJson: github({ pulls: [] }), nowMs: NOW });
  assert.deepEqual(quiet, { status: "ok", merges: [], summary: { medianDevDeployedMin: null, maxDevDeployedMin: null, medianLastCheckDoneMin: null, maxLastCheckStartMin: null } });
});

test("the digest carries the timing and still reads a digest stored without it", async () => {
  const { qaReleaseDigestSchema } = await import("../lib/qaReleaseDigestSchemaCore.ts");
  const latency = await collectQaReleaseLatency({ fetchJson: github(), nowMs: NOW });
  const shape = qaReleaseDigestSchema.shape ?? qaReleaseDigestSchema._def.schema.shape;
  assert.equal(shape.latency.safeParse(latency).success, true);
  assert.equal(shape.latency.safeParse(undefined).success, true);
  assert.equal(shape.latency.safeParse({ status: "ok", merges: [], summary: {} }).success, false);
  // No free text: a title cannot ride in a merge row.
  const withTitle = { ...latency, merges: [{ ...latency.merges[0], title: "x" }] };
  assert.equal(shape.latency.safeParse(withTitle).success, false);
});
