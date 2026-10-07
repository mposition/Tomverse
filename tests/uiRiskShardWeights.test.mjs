import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

// PR Fast Gate's ui-risk shards are balanced with PWTEST_SHARD_WEIGHTS (see
// the comment on the run step in .github/workflows/pr-fast-gate.yml).
// Playwright throws when the weight count differs from the shard total, which
// would fail every ui-risk shard of every pull request; this catches it first.

const workflow = parse(
    readFileSync(new URL("../.github/workflows/pr-fast-gate.yml", import.meta.url), "utf8")
);
const job = workflow.jobs["ui-risk"];
const runStep = job.steps.find((step) => String(step.run ?? "").includes("test:e2e:ui-risk:shard"));

test("the ui-risk run step carries one positive weight per shard", () => {
    assert.ok(runStep, "the ui-risk run step exists");
    const weights = String(runStep.env?.PWTEST_SHARD_WEIGHTS ?? "").split(":");
    const shards = job.strategy.matrix.shards;
    assert.equal(shards.length, 1, "one shard total for the whole matrix");
    assert.equal(weights.length, shards[0], "one weight per shard");
    assert.deepEqual(job.strategy.matrix.shard, Array.from({ length: shards[0] }, (_, i) => i + 1));
    for (const weight of weights) assert.match(weight, /^[1-9][0-9]*$/, weight);
});

test("the run still reaches every ui-risk test through the shard runner", () => {
    assert.match(String(runStep.run), /--shard=\$\{\{ matrix\.shard \}\}\/\$\{\{ matrix\.shards \}\}/);
    assert.equal(runStep.env.UI_RISK_PROJECT, "${{ matrix.project }}");
});
