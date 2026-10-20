import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

// The heavy jobs move to an Ubicloud runner only while the repository
// variable CI_RUNNER_OVERFLOW is `on` (owner decision 2026-10-20): GitHub's
// 40-job limit is the bottleneck on busy days. Unset is GitHub, as before,
// and a fork pull request never reaches a paid runner. Main Chromium
// (e2e.yml) stays on GitHub: it compares screenshot goldens recorded on the
// canonical GitHub ubuntu-24.04 image (docs/qa/canonical-visual-baseline.md).

const OVERFLOW_LABEL = "ubicloud-standard-4-ubuntu-2404";
const expression = (fallback) =>
  `\${{ vars.CI_RUNNER_OVERFLOW == 'on' && github.event.pull_request.head.repo.fork != true && '${OVERFLOW_LABEL}' || '${fallback}' }}`;

const HEAVY_JOBS = [
  ["credit-finance-db-integration.yml", "credit-finance-db", "ubuntu-latest"],
  ["credit-finance-db-integration.yml", "ops-observer-pg16", "ubuntu-latest"],
  ["credit-finance-db-integration.yml", "credit-finance-db-postgres16", "ubuntu-latest"],
  ["admin-console-e2e.yml", "admin-console-e2e-shard", "ubuntu-latest"],
];

const workflow = (file) => parse(readFileSync(new URL(`../.github/workflows/${file}`, import.meta.url), "utf8"));

test("each heavy job picks Ubicloud only behind the switch, and keeps its GitHub runner otherwise", () => {
  for (const [file, job, fallback] of HEAVY_JOBS) {
    assert.equal(workflow(file).jobs[job]["runs-on"], expression(fallback), `${file} ${job}`);
  }
});

test("no other job uses the overflow switch or an Ubicloud runner", () => {
  const heavy = new Set(HEAVY_JOBS.map(([file, job]) => `${file}#${job}`));
  const files = readdirSync(new URL("../.github/workflows/", import.meta.url)).filter((name) => /.ya?ml$/.test(name));
  for (const file of files) {
    for (const [job, body] of Object.entries(workflow(file).jobs ?? {})) {
      if (heavy.has(`${file}#${job}`)) continue;
      assert.doesNotMatch(String(body["runs-on"]), /ubicloud|CI_RUNNER_OVERFLOW/, `${file} ${job}`);
    }
  }
});
