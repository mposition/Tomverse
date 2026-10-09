import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

// A draft pull request runs nothing; marking it ready runs everything. See the
// header of .github/workflows/pr-fast-gate.yml for why. The condition is
// copied into every job, so this keeps the copies honest.

const RUN_UNLESS_DRAFT = "github.event_name != 'pull_request' || !github.event.pull_request.draft";

// The workflows that run on pull requests and occupy a runner. A new one
// either joins this list or says here why it does not.
const GUARDED = [
    "admin-console-e2e.yml",
    "codeql.yml",
    "credit-finance-db-integration.yml",
    "e2e.yml",
    "orchestrator-rust.yml",
    "pr-fast-gate.yml",
    "review-parity-shadow.yml",
    "secret-history-scan.yml",
];
const EXEMPT = new Map([
    ["feedback-autofix-promotion-pr.yml", "runs only on a closed pull request"],
]);

const workflowsDir = new URL("../.github/workflows/", import.meta.url);
const load = (name) => parse(readFileSync(new URL(name, workflowsDir), "utf8"));

const pullRequestWorkflows = readdirSync(workflowsDir)
    .filter((name) => name.endsWith(".yml"))
    .filter((name) => {
        const on = load(name).on ?? {};
        return typeof on === "object" && on !== null && "pull_request" in on;
    })
    .sort();

test("every pull-request workflow is guarded or exempt with a reason", () => {
    assert.deepEqual(
        pullRequestWorkflows.filter((name) => !GUARDED.includes(name) && !EXEMPT.has(name)),
        []
    );
});

for (const name of GUARDED) {
    test(`${name}: every job skips a draft pull request`, () => {
        const workflow = load(name);
        for (const [id, job] of Object.entries(workflow.jobs)) {
            const condition = String(job.if ?? "");
            if (condition.includes("github.event_name != 'pull_request'") && !condition.includes("||")) {
                continue; // never runs for a pull request at all
            }
            assert.ok(
                condition === RUN_UNLESS_DRAFT || condition === `always() && (${RUN_UNLESS_DRAFT})`,
                `${name} job ${id} has if: ${condition || "(none)"}`
            );
        }
    });

    test(`${name}: marking a draft ready starts a run`, () => {
        // Without it the skipped check from the last draft push would stand
        // as the required check's verdict when the pull request is merged.
        const types = load(name).on.pull_request?.types ?? [];
        for (const type of ["opened", "synchronize", "reopened", "ready_for_review"]) {
            assert.ok(types.includes(type), `${name} pull_request.types lacks ${type}`);
        }
    });
}

test("edited is not a trigger anywhere the condition applies", () => {
    // It fires on a title change; a skipped run there would replace a failed
    // verdict and cancel a real run in progress.
    for (const name of GUARDED) {
        const types = load(name).on.pull_request?.types ?? [];
        assert.ok(!types.includes("edited"), `${name} triggers on edited`);
    }
});

test("Auto PR to Develop opens a draft", () => {
    // The skip only saves runners if branches start as drafts; the agent marks
    // the pull request ready when the branch is complete.
    const step = load("auto-pr-to-develop.yml").jobs["auto-pr"]?.steps?.find((candidate) =>
        String(candidate.run ?? "").includes("gh pr create")
    );
    assert.ok(step, "the PR creation step exists");
    assert.match(step.run, /gh pr create \\\n\s+--draft \\/);
});
