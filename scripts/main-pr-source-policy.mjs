// Which branches may open a pull request into main.
//
//   node scripts/main-pr-source-policy.mjs <head-branch> <pr-number>
//
// ## The rule
//
// **main receives releases and fixes that cannot wait for one. Features go to
// develop.** This is the three-lane rule of .github/RELEASE_CHECKLIST.md 7.9
// -- `develop`, `release/**`, `hotfix/**` -- which says a `*-main` name
// "proves nothing about urgency or approval, which is why it is not one of the
// three".
//
// ## Why it is enforced (2026-10-02)
//
// Between 2026-09-20 and 2026-10-02, 78 of the 80 pull requests merged into
// main were feature branches (`claude/`, `codex/`, `cursor/`); two were
// releases. Each one ran the full CI tier twice -- once on its own PR and
// again on main's push -- and then had to come back to develop: the automated
// back-merge restored ancestry nine times, and one manual back-merge (#1794)
// reconciled 34 conflicting files. Every merge also held Railway's production
// deployment behind main's check suite. A rule that lived only in prose had
// stopped being followed, so the PR gate now reads it.
//
// ## What passes
//
//   develop                       the release, when develop has not moved since its candidate
//   release/**                    a release branch: at the candidate Test verified, or a
//                                 selective release cut from main (checklist 7.9, 7.9.1)
//   any `hotfix` path segment     hotfix/login, claude/hotfix/stripe-timeout
//   dependabot/**                 security updates ignore target-branch (checklist 7.9.2)
//   feedback-autofix-main/**      owner-approved promotion (checklist 6.1)
//   autofix/**                    cron-auto-fix, its own gates (off today)
//
// A segment, not a substring: `feature/hotfixes-list` is a feature about a
// list, not a hotfix.
//
// ## Pull requests opened before the rule
//
// GRANDFATHERED names pull requests that were already open into main when the
// rule landed, so the gate does not turn other sessions' in-flight work red
// on its next push. Remove an entry once that pull request is closed; the
// list only shrinks.

export const GRANDFATHERED_MAIN_PULL_REQUESTS = Object.freeze([
    1798, // codex/to-main/amux-v4-foundation
    1858, // codex/ubuntu-bridge-policy
    1880, // codex/to-main/amux-v4-cli-usage-core
    1882, // codex/to-main/amux-v4-integration
]);

const AUTOMATION_PREFIXES = ["dependabot", "feedback-autofix-main", "autofix"];

export const mainPullRequestDecision = (headBranch, pullRequestNumber) => {
    const name = String(headBranch ?? "").trim();
    if (name === "") {
        return { allowed: false, reason: "no head branch was given" };
    }
    const segments = name.split("/").filter((segment) => segment !== "");

    if (name === "develop") {
        return { allowed: true, reason: "develop is the release" };
    }
    if (segments[0] === "release" && segments.length > 1) {
        return { allowed: true, reason: "release/** is a release" };
    }
    if (segments.includes("hotfix")) {
        return {
            allowed: true,
            reason:
                "a hotfix branch; it still owes the six items of .github/RELEASE_CHECKLIST.md section 7.9.2",
        };
    }
    const automation = AUTOMATION_PREFIXES.find((prefix) => segments[0] === prefix);
    if (automation) {
        return { allowed: true, reason: `${automation}/** carries its own approval gates` };
    }
    const number = Number(pullRequestNumber);
    if (Number.isInteger(number) && GRANDFATHERED_MAIN_PULL_REQUESTS.includes(number)) {
        return {
            allowed: true,
            reason: `#${number} was open into main before this rule and is grandfathered`,
        };
    }
    return {
        allowed: false,
        reason:
            `${name} is not a release or a hotfix. Retarget this pull request to develop ` +
            `(gh pr edit ${Number.isInteger(number) ? number : "<number>"} --base develop); ` +
            "it reaches main with the next release. If it cannot wait, name the branch " +
            "with a hotfix segment and follow .github/RELEASE_CHECKLIST.md section 7.9.2",
    };
};

// Run as a script: exit 1 with the reason when the head may not target main.
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [head, number] = process.argv.slice(2);
    const { allowed, reason } = mainPullRequestDecision(head, number);
    if (allowed) {
        console.log(`main pull request from ${head} allowed: ${reason}.`);
    } else {
        console.error(`::error::main pull request from ${head ?? "(none)"} refused: ${reason}.`);
        process.exit(1);
    }
}
