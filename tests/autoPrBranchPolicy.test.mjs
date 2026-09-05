import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";

import { autoPrDecision, TARGET_MARKER } from "../scripts/auto-pr-branch-policy.mjs";

/**
 * The matrix is the point of this file.
 *
 * The rule it replaced was `branches-ignore` plus a list of namespaces that
 * open their own PRs, and that list could only ever name the cases someone had
 * already been surprised by. On 2026-08-15 it missed one and the workflow
 * opened #573 against develop for a branch whose change -- `.github/dependabot.yml`,
 * read only from the default branch -- would have done nothing there.
 *
 * So both halves are pinned here: what gets a PR, and what does not. A rule
 * that only tested its yes cases would have passed under the old behaviour too.
 */

const CREATE = [
    "claude/to-develop/image-generation",
    "codex/to-develop/fix-picker",
    "docs/to-develop/release-policy",
    "fix/to-develop/ime-submit",
    // No tool prefix, and a deeper path. The marker is a segment anywhere, so
    // neither position nor depth is part of the rule.
    "to-develop/ime-submit",
    "claude/to-develop/billing/refund-window",
];

const REFUSE = [
    // Long-lived branches. A PR from develop to develop is not a thing, and
    // main's own pushes are what the back-merge workflow handles.
    ["main", /long-lived/],
    ["develop", /long-lived/],

    // Legacy prefixes. Every one of these was in use on the day the rule
    // changed, and every one of them says who made the branch, not where it
    // is going.
    ["claude/image-generation-ui-billing-52kces", /names no merge target/],
    ["docs/accessibility-matrix-2026-08-15", /names no merge target/],
    ["fix/visual-baseline-gate", /names no merge target/],
    ["feature/anything", /names no merge target/],

    // The 2026-08-15 case, now spelled out.
    ["claude/to-main/dependabot-hold", /to-main reaches production/],
    ["release/2026-08", /release reaches production/],
    ["hotfix/credit-lot", /hotfix reaches production/],

    // Automation namespaces open their own PRs. Refused ahead of the marker,
    // so even an explicitly-marked branch there does not get a second one --
    // the feedback-autofix workflow records the number of the PR it created,
    // and it has to be that PR.
    ["dependabot/npm_and_yarn/development-dependencies-3f86c07b8b", /opens its own pull request/],
    ["autofix/2026-08-15", /opens its own pull request/],
    ["feedback-autofix/case-114", /opens its own pull request/],
    ["feedback-autofix/to-develop/case-114", /opens its own pull request/],

    // A marker that is not a segment. Both of these contain the string and
    // neither states a target: one is a branch about development notes, the
    // other is somebody's shorthand.
    ["feature/to-development-notes", /names no merge target/],
    ["chore/to-develop-later", /names no merge target/],
];

test("a to-develop segment is what opens a develop pull request", () => {
    for (const branch of CREATE) {
        const decision = autoPrDecision(branch);
        assert.equal(decision.create, true, `${branch} should open a PR`);
        assert.match(decision.reason, new RegExp(TARGET_MARKER));
    }
});

test("everything else is refused, and says which rule refused it", () => {
    for (const [branch, reason] of REFUSE) {
        const decision = autoPrDecision(branch);
        assert.equal(decision.create, false, `${branch} should not open a PR`);
        assert.match(decision.reason, reason, branch);
    }
});

test("the refusal for an unmarked branch suggests the branch it should have been", () => {
    // The cost of opt-in is a person having to know the convention. A refusal
    // that only said "no" would move that cost onto whoever reads the log.
    assert.match(
        autoPrDecision("fix/visual-baseline-gate").reason,
        /fix\/to-develop\/visual-baseline-gate/
    );
});

test("a missing or empty branch name is refused rather than defaulted", () => {
    for (const value of [undefined, null, "", "   "]) {
        assert.equal(autoPrDecision(value).create, false, JSON.stringify(value));
    }
});

test("the workflow filter and the module agree on the marker", () => {
    // Two places state the rule: a glob GitHub evaluates before the job starts,
    // and this module. The glob is the cheap cut and cannot be tested from
    // here, so what is pinned is that it names the same marker and that the
    // job actually consults the module -- a filter widened without the module
    // would otherwise reach the PR-creating step unchecked.
    // Newlines normalised on read. Git checks this file out with CRLF on
    // Windows and the assertions below spell `\n`, so without this the
    // first one fails on a line ending and every assertion after it goes
    // unread -- which is how the step rename below reached CI unnoticed.
    const workflow = readFileSync(
        ".github/workflows/auto-pr-to-develop.yml",
        "utf8"
    ).replace(/\r\n/g, "\n");

    assert.match(workflow, /branches:\n\s+- "to-develop\/\*\*"\n\s+- "\*\*\/to-develop\/\*\*"/);
    // The key, not the word: the comment above the filter explains what
    // `branches-ignore` was and why it went, and a substring match reads that
    // prose as the setting.
    assert.ok(
        !/^\s*branches-ignore:/m.test(workflow),
        "opt-out and opt-in cannot both be in force"
    );
    assert.match(workflow, /node scripts\/auto-pr-branch-policy\.mjs "\$BRANCH"/);

    // Every step that can create or merge a pull request is gated on the
    // module's answer, not only on the glob. The two that read it directly
    // are the diff check and the step that creates the pull request; the
    // arming step reads the create step's output, which is the same gate one
    // link further along -- it cannot be `true` on a run where the create
    // step did not run.
    const names = [...workflow.matchAll(/^\s+- name: (.+)$/gm)].map((m) => m[1]);
    assert.ok(names.includes("Create PR to develop if missing"));
    assert.ok(
        names.some((name) => /auto-merge/i.test(name)),
        "the arming step still exists"
    );
    assert.equal(
        (workflow.match(/steps\.target\.outputs\.create == 'true'/g) ?? []).length,
        2,
        "the diff check and the PR-creating step are gated on the module"
    );
    assert.match(
        workflow,
        /if: steps\.create-pr\.outputs\.created == 'true'/,
        "the arming step is gated on this run having created the PR"
    );
});
