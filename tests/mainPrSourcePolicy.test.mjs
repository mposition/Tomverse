import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
    GRANDFATHERED_MAIN_PULL_REQUESTS,
    mainPullRequestDecision,
} from "../scripts/main-pr-source-policy.mjs";

// main takes the three lanes of .github/RELEASE_CHECKLIST.md 7.9 and nothing
// else. Both directions are pinned: a lane that stops passing blocks a
// release or a hotfix, and a feature that starts passing reopens the gap.

const allowed = (head, number) => mainPullRequestDecision(head, number).allowed;

test("the three lanes pass", () => {
    assert.ok(allowed("develop", 1897));
    assert.ok(allowed("release/2026-10-02-consent", 2000));
    assert.ok(allowed("hotfix/stripe-timeout", 2000));
    assert.ok(allowed("claude/hotfix/stripe-timeout", 2000));
});

test("automation that carries its own gates passes", () => {
    assert.ok(allowed("dependabot/npm_and_yarn/next-16.3.9", 2000));
    assert.ok(allowed("feedback-autofix-main/case-123", 2000));
    assert.ok(allowed("autofix/maintenance-123", 2000));
});

test("feature branches are refused, whatever their name says about main", () => {
    for (const head of [
        "claude/to-main/amux-orchestrator-halt",
        "codex/to-main/amux-v5",
        "cursor/web-search-chip",
        "claude/to-develop/image-generation",
        "feature/hotfixes-list",
        "releases/2026-10-02",
        "release",
        "main",
    ]) {
        assert.equal(allowed(head, 2000), false, head);
    }
});

test("the refusal says how to retarget", () => {
    const { reason } = mainPullRequestDecision("codex/to-main/amux-v5", 2001);
    assert.match(reason, /gh pr edit 2001 --base develop/);
    assert.match(reason, /RELEASE_CHECKLIST\.md section 7\.9\.2/);
});

test("a grandfathered pull request passes by number, and only by number", () => {
    for (const number of GRANDFATHERED_MAIN_PULL_REQUESTS) {
        assert.ok(allowed("codex/to-main/anything", number), String(number));
        assert.ok(allowed("codex/to-main/anything", String(number)), `"${number}"`);
    }
    assert.equal(allowed("codex/to-main/amux-v4-integration", 1883), false);
    assert.equal(allowed("codex/to-main/amux-v4-integration", undefined), false);
});

test("the list of grandfathered pull requests does not grow", () => {
    // It names what was open on 2026-10-02. A later entry would be a new
    // exception wearing an old one's name.
    assert.ok(GRANDFATHERED_MAIN_PULL_REQUESTS.every((number) => number <= 1882));
    assert.ok(GRANDFATHERED_MAIN_PULL_REQUESTS.length <= 4);
});

test("an empty head is refused", () => {
    assert.equal(allowed("", 2000), false);
    assert.equal(allowed(undefined, 2000), false);
});

test("the CLI exits non-zero on a refusal and zero on a pass", () => {
    const run = (...args) =>
        spawnSync(process.execPath, ["scripts/main-pr-source-policy.mjs", ...args], {
            encoding: "utf8",
        });
    assert.equal(run("develop", "1897").status, 0);
    const refused = run("codex/to-main/amux-v5", "2001");
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /::error::/);
});

test("PR Fast Gate runs the policy for pull requests into main", () => {
    const workflow = readFileSync(
        new URL("../.github/workflows/pr-fast-gate.yml", import.meta.url),
        "utf8"
    );
    assert.match(workflow, /node scripts\/main-pr-source-policy\.mjs "\$HEAD_REF" "\$PR_NUMBER"/);
    assert.match(workflow, /if: github\.base_ref == 'main'/);
});
