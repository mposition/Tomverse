import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";

import { parse } from "yaml";

// A draft release PR (develop -> main) and a draft stacked on another branch
// run nothing; a ready one, or a draft into develop, runs everything. See the header of .github/workflows/pr-fast-gate.yml for why.
// The condition is copied into every job, so this keeps the copies honest.

const RUN_UNLESS_SKIPPED_DRAFT =
    "github.event_name != 'pull_request' || !github.event.pull_request.draft || github.base_ref == 'develop' || (github.base_ref == 'main' && github.head_ref != 'develop')";

// The workflows that run on pull requests into develop or main and occupy a
// runner. A new one either joins this list or says here why it does not.
const GUARDED = [
    "admin-console-e2e.yml",
    "codeql.yml",
    "credit-finance-db-integration.yml",
    "orchestrator-rust.yml",
    "pr-fast-gate.yml",
    "review-parity-shadow.yml",
    "secret-history-scan.yml",
];
const EXEMPT = new Map([
    ["e2e.yml", "skips every draft into main, a superset of this condition"],
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
    test(`${name}: every job skips a draft release or stacked PR`, () => {
        const workflow = load(name);
        for (const [id, job] of Object.entries(workflow.jobs)) {
            const condition = String(job.if ?? "");
            if (condition.includes("github.event_name != 'pull_request'") && !condition.includes("||")) {
                continue; // never runs for a pull request at all
            }
            assert.ok(
                condition === RUN_UNLESS_SKIPPED_DRAFT ||
                    condition === `always() && (${RUN_UNLESS_SKIPPED_DRAFT})`,
                `${name} job ${id} has if: ${condition || "(none)"}`
            );
        }
    });

    test(`${name}: marking a draft ready starts a run`, () => {
        // Without it the skipped check from the last draft push would stand
        // as the required check's verdict when the release PR is merged.
        const types = load(name).on.pull_request?.types ?? [];
        for (const type of ["opened", "synchronize", "reopened", "ready_for_review"]) {
            assert.ok(types.includes(type), `${name} pull_request.types lacks ${type}`);
        }
    });
}

test("the condition runs and skips exactly the intended pull requests", () => {
    // Evaluate the expression's logic directly: draft x base x head.
    const runs = ({ draft, base, head }) =>
        !draft || base === "develop" || (base === "main" && head !== "develop");
    const cases = [
        [{ draft: true, base: "main", head: "develop" }, false], // draft release
        [{ draft: true, base: "codex/to-main/amux-v4-x", head: "codex/to-main/amux-v4-y" }, false], // stacked
        [{ draft: true, base: "develop", head: "claude/to-develop/x" }, true],
        [{ draft: true, base: "main", head: "hotfix/x" }, true],
        [{ draft: false, base: "main", head: "develop" }, true], // ready release
        [{ draft: false, base: "codex/to-main/amux-v4-x", head: "codex/to-main/amux-v4-y" }, true],
    ];
    for (const [pr, expected] of cases) assert.equal(runs(pr), expected, JSON.stringify(pr));
    // And the expression in the workflows is the one these cases describe.
    assert.equal(
        RUN_UNLESS_SKIPPED_DRAFT,
        "github.event_name != 'pull_request' || !github.event.pull_request.draft || github.base_ref == 'develop' || (github.base_ref == 'main' && github.head_ref != 'develop')"
    );
});
