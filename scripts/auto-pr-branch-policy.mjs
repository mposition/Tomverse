// Which branches may have a develop pull request opened for them, by name.
//
//   node scripts/auto-pr-branch-policy.mjs <branch>
//
// ## The principle
//
// **A branch's merge target decides what automation may do with it, not its
// purpose.** `claude/`, `docs/`, `fix/` say who made the branch and why; none
// of them says where it is going, and a push event cannot find out -- the
// branch exists before any pull request does.
//
// ## Why opt-in, and why `branches-ignore` could not work
//
// The workflow used to open a develop PR for every branch except a list of
// known exceptions. That list can only ever name the main-targeting
// namespaces someone has already been surprised by. On 2026-08-15 a branch
// carrying a `.github/dependabot.yml` change -- which is read from the default
// branch and has no effect anywhere else -- was pushed for a `main` PR, and
// the workflow opened #573 against develop before the intended PR existed.
// Two PRs, one branch, one of them pointed at a base where the change would
// have done nothing.
//
// Adding that prefix to the ignore list would have fixed 2026-08-15 and
// nothing after it. Under opt-in the unknown case is "no PR", which costs one
// manual `gh pr create`; under opt-out it is "a PR against the wrong base,
// with auto-merge enabled".
//
// ## The marker
//
// A `to-develop` path segment anywhere in the branch name:
//
//   claude/to-develop/image-generation      yes
//   codex/to-develop/fix-picker             yes
//   docs/to-develop/release-policy          yes
//   to-develop/ime-submit                   yes
//   claude/to-main/dependabot-hold          no  -- open the main PR by hand
//   fix/visual-baseline-gate                no  -- legacy, says nothing about target
//
// A segment, not a substring: `feature/to-development-notes` is a branch about
// development notes, and `to-develop-later` is somebody's shorthand. Neither
// is a statement of target, and a substring match would read both as one.

const AUTOMATION_NAMESPACES = [
    // Each of these opens its own pull request, so an automatic second one is
    // two PRs for one branch. They are refused ahead of the marker on purpose:
    // a branch named `feedback-autofix/to-develop/...` is still a branch whose
    // workflow records the PR number it created, and it must be that one.
    "dependabot",
    "autofix",
    "feedback-autofix",
];

// Named so the refusal reads as a decision rather than as "not matched". These
// reach production, and a wrong base there is not a tidy-up.
const PRODUCTION_NAMESPACES = ["to-main", "release", "hotfix"];

export const TARGET_MARKER = "to-develop";

export const autoPrDecision = (branch) => {
    const name = String(branch ?? "").trim();
    if (name === "") {
        return { create: false, reason: "no branch name was given" };
    }

    const segments = name.split("/").filter((segment) => segment !== "");

    if (name === "main" || name === "develop") {
        return { create: false, reason: `${name} is a long-lived branch` };
    }

    const automation = AUTOMATION_NAMESPACES.find(
        (namespace) => segments[0] === namespace
    );
    if (automation) {
        return {
            create: false,
            reason: `${automation}/** opens its own pull request; a second one would be two PRs for one branch`,
        };
    }

    const production = PRODUCTION_NAMESPACES.find((namespace) =>
        segments.includes(namespace)
    );
    if (production) {
        return {
            create: false,
            reason: `${production} reaches production; open that pull request by hand`,
        };
    }

    if (segments.includes(TARGET_MARKER)) {
        return {
            create: true,
            reason: `the branch names ${TARGET_MARKER} as its merge target`,
        };
    }

    return {
        create: false,
        reason:
            `the branch names no merge target. Add a ${TARGET_MARKER} segment ` +
            `(e.g. ${segments[0] ?? "fix"}/${TARGET_MARKER}/${segments[segments.length - 1] ?? "change"}) ` +
            `or open the pull request by hand`,
    };
};

// Run as a script: print the decision for GitHub's step output, and say why in
// the log either way. A skipped run that does not say why is the same failure
// as an unwanted PR -- nobody knows which rule applied.
const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const branch = process.argv[2];
    const { create, reason } = autoPrDecision(branch);
    console.log(
        create
            ? `Opening a develop pull request for ${branch}: ${reason}.`
            : `No develop pull request for ${branch ?? "(none)"}: ${reason}.`
    );
    if (process.env.GITHUB_OUTPUT) {
        const { appendFileSync } = await import("node:fs");
        appendFileSync(process.env.GITHUB_OUTPUT, `create=${create}\n`);
    }
}
