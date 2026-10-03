import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

// Main Chromium Regression balances its shards with PWTEST_SHARD_WEIGHTS (see
// the comment on the run step in .github/workflows/e2e.yml). Playwright throws
// when the weight count differs from the shard total, which would fail every
// shard of a release PR; this catches the mismatch before CI does.

const workflow = parse(
    readFileSync(new URL("../.github/workflows/e2e.yml", import.meta.url), "utf8")
);
const job = workflow.jobs.playwright;
const runStep = job.steps.find((step) => String(step.run ?? "").includes("npm run test:e2e:chromium"));

test("the shard run step carries one weight per shard", () => {
    assert.ok(runStep, "the shard run step exists");
    const weights = String(runStep.env?.PWTEST_SHARD_WEIGHTS ?? "").split(":");
    const shards = job.strategy.matrix.shards;
    assert.equal(shards.length, 1, "one shard total for the whole matrix");
    assert.equal(weights.length, shards[0], "PWTEST_SHARD_WEIGHTS must name exactly one weight per shard");
    assert.deepEqual(job.strategy.matrix.shard, Array.from({ length: shards[0] }, (_, i) => i + 1));
});

test("every weight is a positive integer", () => {
    // Playwright parses each with parseInt and rejects negatives; a zero would
    // leave a shard with nothing to run, which is a misconfiguration too.
    for (const weight of String(runStep.env.PWTEST_SHARD_WEIGHTS).split(":")) {
        assert.match(weight, /^[1-9][0-9]*$/, weight);
    }
});

test("the weights reach Playwright by name, and the run stays unfiltered", () => {
    assert.match(String(runStep.run), /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\}/);
    assert.doesNotMatch(String(runStep.run), /--grep|--project/);
});
