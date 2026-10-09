import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  QA_RELEASE_CI_JOB_NAMES,
  QA_RELEASE_NOTIFIER_STEP,
  collectQaReleaseCi,
} from "../lib/qaReleaseCiCollectCore.ts";
import { QA_RELEASE_CI_JOBS } from "../lib/qaReleaseDigestSchemaCore.ts";

/** Each job's `name:` line from the workflow file, keyed by job id. */
function jobNameTemplates(workflow) {
  const text = readFileSync(new URL(`../.github/workflows/${workflow}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
  const jobs = text.split(/^jobs:\s*$/m)[1];
  const templates = {};
  let current = null;
  for (const line of jobs.split("\n")) {
    const key = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(line);
    if (key) current = key[1];
    const name = /^ {4}name:\s*(.+)$/.exec(line);
    if (name && current && !(current in templates)) templates[current] = name[1].trim();
  }
  return templates;
}

test("every pattern matches its workflow's rendered name, and only its own job", () => {
  for (const [workflow, entries] of Object.entries(QA_RELEASE_CI_JOB_NAMES)) {
    const templates = jobNameTemplates(workflow);
    assert.deepEqual(Object.keys(templates).sort(), [...QA_RELEASE_CI_JOBS[workflow]].sort(), workflow);
    for (const entry of entries) {
      const rendered = templates[entry.job]
        .replace("${{ matrix.shard }}", "3")
        .replace("${{ matrix.shards }}", "5");
      assert.doesNotMatch(rendered, /\$\{\{/, `${workflow} ${entry.job} has an unrendered expression`);
      const match = entry.name.exec(rendered);
      assert.ok(match, `${workflow} ${entry.job}: ${rendered}`);
      if (match[1]) assert.equal(match[1], "3");
      for (const other of entries.filter((e) => e !== entry)) assert.doesNotMatch(rendered, other.name);
    }
  }
});

const NOW = Date.parse("2026-10-03T21:00:00Z");

function github(fixtures) {
  const calls = [];
  return {
    calls,
    fetchJson: async (path) => {
      calls.push(path);
      for (const [pattern, body] of fixtures) if (path.includes(pattern)) return typeof body === "function" ? body() : body;
      throw new Error(`unexpected ${path}`);
    },
  };
}

const run = (id, hoursAgo) => ({ id, status: "completed", created_at: new Date(NOW - hoursAgo * 3600_000).toISOString() });

test("rows carry job, shard, conclusion and a class only for failures; old runs and unknown names are left out", async () => {
  const gh = github([
    ["workflows/e2e.yml/runs", { total_count: 2, workflow_runs: [run(11, 2), run(12, 30)] }],
    ["runs/11/jobs", {
      total_count: 5,
      jobs: [
        { name: "Chromium regression (shard 2/5)", conclusion: "failure", steps: [{ name: "Install Chromium", conclusion: "failure" }] },
        { name: "Chromium regression (shard 3/5)", conclusion: "success", steps: [] },
        { name: "Chromium desktop and mobile regression", conclusion: "failure", steps: [{ name: "Run tests", conclusion: "failure" }] },
        { name: "A renamed job", conclusion: "failure", steps: [] },
        { name: "Chromium regression (shard 4/5)", conclusion: null, steps: [] },
      ],
    }],
    ["workflows/deployed-commit-drift.yml/runs", { total_count: 1, workflow_runs: [run(21, 1)] }],
    ["runs/21/jobs", { total_count: 1, jobs: [{ name: "Deployed commit vs branch head", conclusion: "failure", steps: [{ name: QA_RELEASE_NOTIFIER_STEP, conclusion: "success" }] }] }],
    ["/runs?", { total_count: 0, workflow_runs: [] }],
  ]);
  const result = await collectQaReleaseCi({ fetchJson: gh.fetchJson, nowMs: NOW });
  assert.deepEqual(result.ci, [
    { workflow: "e2e.yml", runId: "11", job: "playwright", shard: 2, jobConclusion: "failure", label: "infra" },
    { workflow: "e2e.yml", runId: "11", job: "playwright", shard: 3, jobConclusion: "success", label: null },
    { workflow: "e2e.yml", runId: "11", job: "regression", shard: null, jobConclusion: "failure", label: "undetermined" },
  ]);
  assert.deepEqual(result.releaseLane, [
    { workflow: "drift", runId: "21", job: "drift", jobConclusion: "failure", existingNotifierStepRan: true },
  ]);
  assert.equal(result.unrecognizedJobs, 1);
  assert.equal(result.truncated, false);
  assert.equal(gh.calls.some((path) => path.includes("runs/12/")), false, "a run older than the window is not read");
  assert.equal(gh.calls.some((path) => /logs/.test(path)), false, "logs are never fetched");
});

test("any failed or malformed read answers null, not an empty list", async () => {
  assert.equal(await collectQaReleaseCi({ fetchJson: async () => { throw new Error("403"); }, nowMs: NOW }), null);
  assert.equal(await collectQaReleaseCi({ fetchJson: async () => ({ message: "Not Found" }), nowMs: NOW }), null);
});

test("runs are read across pages until the window ends, and a window past the page cap is marked truncated", async () => {
  // 150 runs inside the window: two pages, then an older run ends the list.
  const inWindow = Array.from({ length: 150 }, (_, i) => run(1000 + i, 1 + i / 10));
  const gh = github([
    ["workflows/e2e.yml/runs?status=completed&per_page=100&page=1", { total_count: 151, workflow_runs: inWindow.slice(0, 100) }],
    ["workflows/e2e.yml/runs?status=completed&per_page=100&page=2", { total_count: 151, workflow_runs: [...inWindow.slice(100), run(9, 30)] }],
    ["/jobs?", { total_count: 0, jobs: [] }],
    ["/runs?", { total_count: 0, workflow_runs: [] }],
  ]);
  const result = await collectQaReleaseCi({ fetchJson: gh.fetchJson, nowMs: NOW });
  assert.equal(result.truncated, false);
  assert.equal(gh.calls.filter((path) => path.includes("/jobs?")).length, 150);
  assert.equal(gh.calls.some((path) => path.includes("page=3")), false);

  // Every page full and still inside the window at the cap.
  const busy = github([
    ["workflows/e2e.yml/runs", () => ({ total_count: 5000, workflow_runs: Array.from({ length: 100 }, (_, i) => run(i, 1)) })],
    ["/jobs?", { total_count: 0, jobs: [] }],
    ["/runs?", { total_count: 0, workflow_runs: [] }],
  ]);
  assert.equal((await collectQaReleaseCi({ fetchJson: busy.fetchJson, nowMs: NOW })).truncated, true);
});

test("jobs are read across pages by their total count", async () => {
  const gh = github([
    ["workflows/e2e.yml/runs", { total_count: 1, workflow_runs: [run(5, 1)] }],
    ["runs/5/jobs?per_page=100&page=1", { total_count: 101, jobs: Array.from({ length: 100 }, () => ({ name: "Chromium regression (shard 1/5)", conclusion: "success", steps: [] })) }],
    ["runs/5/jobs?per_page=100&page=2", { total_count: 101, jobs: [{ name: "Chromium desktop and mobile regression", conclusion: "failure", steps: [] }] }],
    ["/runs?", { total_count: 0, workflow_runs: [] }],
  ]);
  const result = await collectQaReleaseCi({ fetchJson: gh.fetchJson, nowMs: NOW });
  assert.equal(result.ci.length, 2, "one row per job; the second job is on page 2");
  assert.equal(result.ci.at(-1).job, "regression");
});

test("each job contributes one row, from the newest run that ran it", async () => {
  const drift = (id, hoursAgo, conclusion) => [`runs/${id}/jobs`, { total_count: 1, jobs: [{ name: "Deployed commit vs branch head", conclusion, steps: [] }] }];
  const gh = github([
    ["workflows/deployed-commit-drift.yml/runs", { total_count: 3, workflow_runs: [run(31, 1), run(32, 2), run(33, 3)] }],
    drift(31, 1, "success"),
    drift(32, 2, "failure"),
    drift(33, 3, "failure"),
    ["workflows/e2e.yml/runs", { total_count: 2, workflow_runs: [run(41, 1), run(42, 5)] }],
    ["runs/41/jobs", { total_count: 1, jobs: [{ name: "Chromium regression (shard 1/5)", conclusion: "success", steps: [] }] }],
    ["runs/42/jobs", { total_count: 2, jobs: [
      { name: "Chromium regression (shard 1/5)", conclusion: "failure", steps: [] },
      { name: "Chromium regression (shard 2/5)", conclusion: "failure", steps: [] },
    ] }],
    ["/runs?", { total_count: 0, workflow_runs: [] }],
  ]);
  const result = await collectQaReleaseCi({ fetchJson: gh.fetchJson, nowMs: NOW });
  assert.deepEqual(result.releaseLane.map((row) => [row.runId, row.jobConclusion]), [["31", "success"]]);
  assert.deepEqual(result.ci.map((row) => [row.runId, row.shard, row.jobConclusion]), [["41", 1, "success"], ["42", 2, "failure"]]);
});

test("a skipped job does not replace an older result for that job", async () => {
  const gh = github([
    ["workflows/e2e.yml/runs", { total_count: 2, workflow_runs: [run(51, 1), run(52, 3)] }],
    ["runs/51/jobs", { total_count: 1, jobs: [{ name: "Chromium desktop and mobile regression", conclusion: "skipped", steps: [] }] }],
    ["runs/52/jobs", { total_count: 1, jobs: [{ name: "Chromium desktop and mobile regression", conclusion: "failure", steps: [] }] }],
    ["/runs?", { total_count: 0, workflow_runs: [] }],
  ]);
  const result = await collectQaReleaseCi({ fetchJson: gh.fetchJson, nowMs: NOW });
  assert.deepEqual(result.ci.map((row) => [row.runId, row.jobConclusion]), [["52", "failure"]]);
});
