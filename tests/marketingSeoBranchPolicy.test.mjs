import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { autoPrDecision } from "../scripts/auto-pr-branch-policy.mjs";
import { seoAgentBranchName, seoAgentTopicSlug } from "../lib/marketingSeoAgentCore.ts";

/**
 * The branch policy shell test of marketing policy 9.2 and S5: the SEO agent's
 * two branch shapes against the real `scripts/auto-pr-branch-policy.mjs`, run
 * the way the `Auto PR to Develop` workflow runs it.
 *
 * Human-owned. The SEO agent's allowed files do not include it.
 */

const script = fileURLToPath(new URL("../scripts/auto-pr-branch-policy.mjs", import.meta.url));

/** What the workflow step sees: the script's stdout and the `create=` line it writes to GITHUB_OUTPUT. */
const runPolicy = (branch) => {
    const dir = mkdtempSync(join(tmpdir(), "branch-policy-"));
    const output = join(dir, "github-output");
    try {
        const result = spawnSync(process.execPath, [script, branch], {
            encoding: "utf8",
            env: { ...process.env, GITHUB_OUTPUT: output },
        });
        assert.equal(result.status, 0, result.stderr);
        const written = readFileSync(output, "utf8");
        return { stdout: result.stdout, create: /^create=(true|false)$/m.exec(written)?.[1] };
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
};

test("marketing-agent/<topic> is not a pull request target", () => {
    for (const topic of ["sitemap-hreflang", "structured-data-org", "llms-txt-copy", "a"]) {
        const branch = `marketing-agent/${topic}`;
        assert.equal(autoPrDecision(branch).create, false, branch);
        const shell = runPolicy(branch);
        assert.equal(shell.create, "false", branch);
        assert.match(shell.stdout, /names no merge target/);
    }
});

test("marketing-agent/to-develop/<topic> opens a develop pull request", () => {
    for (const topic of ["sitemap-hreflang", "structured-data-org", "llms-txt-copy", "a"]) {
        const branch = `marketing-agent/to-develop/${topic}`;
        assert.equal(autoPrDecision(branch).create, true, branch);
        const shell = runPolicy(branch);
        assert.equal(shell.create, "true", branch);
        assert.match(shell.stdout, /Opening a develop pull request/);
    }
});

test("the agent's own branch names follow those two shapes", () => {
    const topic = "Add Organization structured data";
    const before = seoAgentBranchName(topic, false);
    const after = seoAgentBranchName(topic, true);
    assert.equal(before, "marketing-agent/add-organization-structured-data");
    assert.equal(after, "marketing-agent/to-develop/add-organization-structured-data");
    assert.equal(autoPrDecision(before).create, false);
    assert.equal(autoPrDecision(after).create, true);
});

test("no topic can change which side of the policy a branch lands on", () => {
    for (const topic of ["to-develop", "To-Develop", "release", "hotfix", "to-main", "main", "develop", "dependabot", "../../main", "/release/", "", "   ", "!!!", "한국어만"]) {
        assert.equal(seoAgentTopicSlug(topic), null, JSON.stringify(topic));
        assert.equal(seoAgentBranchName(topic, false), null);
        assert.equal(seoAgentBranchName(topic, true), null);
    }
    // Slashes, dots and case are folded into one safe segment, so a topic cannot add a segment.
    for (const topic of ["x/to-develop/y", "../../hotfix-x", "a b/c", "UPPER.case"]) {
        const slug = seoAgentTopicSlug(topic);
        assert.match(slug, /^[a-z0-9]+(-[a-z0-9]+)*$/, topic);
        assert.equal(autoPrDecision(`marketing-agent/${slug}`).create, false, topic);
    }
});

test("a topic cannot be longer than one short segment", () => {
    const slug = seoAgentTopicSlug("word ".repeat(100));
    assert.ok(slug.length <= 40);
    assert.doesNotMatch(slug, /-$/);
});

test("the workflow's cheap filter admits the graduated shape and not the other", () => {
    const workflow = readFileSync(new URL("../.github/workflows/auto-pr-to-develop.yml", import.meta.url), "utf8");
    assert.match(workflow, /"\*\*\/to-develop\/\*\*"/);
    // The filter is a glob on `**/to-develop/**`: the graduated branch has that segment, the other does not.
    assert.ok("marketing-agent/to-develop/x".split("/").includes("to-develop"));
    assert.ok(!"marketing-agent/x".split("/").includes("to-develop"));
    // The workflow opens the PR and never merges: no auto-merge is armed for this namespace either.
    assert.doesNotMatch(workflow, /gh pr merge|--auto\b|enablePullRequestAutoMerge/);
});
