import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parse } from "yaml";

/**
 * The Slack webhooks of the financial DB lane must never share a job with the
 * code under test.
 *
 * They used to: the alert was the last step of each matrix lane, so the
 * webhook secrets sat in the environment of a step that ran right after
 * `npm ci` and the whole suite from the checked-out tree, in a job that had
 * restored the shared npm cache. Anything that tree ran could leave behind
 * something the secret-holding step would pick up. Step-level `env:` is not
 * isolation; a job is.
 *
 * So both halves are pinned: the lanes hold no secret, and the alert job never
 * runs the tree under test.
 */

const ROOT = resolve(import.meta.dirname, "..");
const WORKFLOW_PATH = resolve(ROOT, ".github", "workflows", "credit-finance-db-integration.yml");
const source = readFileSync(WORKFLOW_PATH, "utf8");
const workflow = parse(source);

function jobSource(jobId) {
    // The raw text of one job, so a `secrets.` reference in a comment-free
    // expression cannot hide behind the parsed structure.
    const lines = source.split("\n");
    const start = lines.findIndex((line) => line === `  ${jobId}:`);
    assert.ok(start >= 0, `job ${jobId} not found`);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
        if (/^ {2}[A-Za-z0-9_-]+:\s*$/.test(lines[i])) {
            end = i;
            break;
        }
    }
    return lines
        .slice(start, end)
        .filter((line) => !/^\s*#/.test(line))
        .join("\n");
}

test("the lanes that run the checked-out tree reference no secret", () => {
    const lanes = jobSource("credit-finance-db");
    assert.doesNotMatch(lanes, /secrets\./);
    assert.doesNotMatch(lanes, /notify-release-lane-failure/);
});

test("the token the checked-out tree runs with can only read", () => {
    // No secret is only half of it: a write scope on the workflow's
    // GITHUB_TOKEN would hand the code under test a credential too.
    assert.deepEqual(workflow.permissions, { contents: "read" });
    for (const [jobId, job] of Object.entries(workflow.jobs)) {
        if (job.permissions === undefined) continue;
        for (const [scope, level] of Object.entries(job.permissions)) {
            assert.notEqual(level, "write", `${jobId} grants ${scope}: write`);
        }
    }
    assert.equal(workflow.jobs["credit-finance-db"].permissions, undefined);
});

test("no job other than the alert job references a secret", () => {
    for (const jobId of Object.keys(workflow.jobs)) {
        if (jobId === "report-red-lane") continue;
        assert.doesNotMatch(jobSource(jobId), /secrets\./, `${jobId} references a secret`);
    }
});

test("the alert job takes only the matrix result and never runs the tree under test", () => {
    const job = workflow.jobs["report-red-lane"];
    assert.ok(job, "report-red-lane job is missing");
    assert.equal(job.needs, "credit-finance-db");
    assert.match(job.if, /needs\.credit-finance-db\.result == 'failure'/);
    assert.match(job.if, /github\.event_name != 'pull_request'/);
    assert.match(job.if, /^always\(\) && /);
    assert.deepEqual(job.permissions, { contents: "read" });

    const [checkout, setupNode, report, ...rest] = job.steps;
    assert.equal(rest.length, 0, "the alert job has steps beyond checkout, node and the report");

    assert.equal(checkout.uses, "actions/checkout@v6");
    assert.equal(checkout.with.ref, "${{ github.event.repository.default_branch }}");
    assert.equal(checkout.with["persist-credentials"], false);
    assert.equal(checkout.with["sparse-checkout-cone-mode"], false);
    assert.deepEqual(
        checkout.with["sparse-checkout"].trim().split("\n").map((line) => line.trim()).sort(),
        ["scripts/notify-release-lane-failure-core.mjs", "scripts/notify-release-lane-failure.mjs"]
    );

    assert.equal(setupNode.uses, "actions/setup-node@v6");
    assert.equal(setupNode.with.cache, undefined, "the alert job must not restore a cache");

    assert.equal(report.run, "node scripts/notify-release-lane-failure.mjs");
    assert.equal(report.env.RELEASE_LANE, "db-integration");
    for (const name of [
        "RELEASE_LANE_ALERT_SLACK_WEBHOOK_URL",
        "OPS_ALERT_SLACK_WEBHOOK_URL",
        "SLACK_WEBHOOK_URL",
    ]) {
        assert.equal(report.env[name], `\${{ secrets.${name} }}`);
    }

    const jobText = jobSource("report-red-lane");
    assert.doesNotMatch(jobText, /npm (ci|install|run)/);
    assert.doesNotMatch(jobText, /download-artifact|actions\/cache/);
});

test("the notifier the alert job checks out imports only its own core", () => {
    // The sparse checkout holds exactly these two files, so any other import
    // would fail at run time -- and would mean the alert job runs more than it
    // was reviewed to run.
    const notifier = readFileSync(resolve(ROOT, "scripts", "notify-release-lane-failure.mjs"), "utf8");
    const core = readFileSync(resolve(ROOT, "scripts", "notify-release-lane-failure-core.mjs"), "utf8");
    // Both forms: `import { x } from "..."` and a side-effect `import "..."`.
    const importsOf = (text) =>
        [...text.matchAll(/^\s*import\s*(?:[^"';]*?\bfrom\s*)?["']([^"']+)["']/gm)].map((m) => m[1]);
    assert.deepEqual(importsOf('import "node:child_process";\nimport { a } from "./b.mjs";'), [
        "node:child_process",
        "./b.mjs",
    ]);
    assert.doesNotMatch(notifier + core, /^\s*export\s*(?:\*(?:\s*as\s+\w+)?|\{[^}]*\})\s*from\s*["']/m);
    assert.deepEqual(importsOf(notifier), ["./notify-release-lane-failure-core.mjs"]);
    assert.deepEqual(importsOf(core), []);
    assert.doesNotMatch(notifier + core, /\bimport\s*\(|\brequire\s*\(/);
});
