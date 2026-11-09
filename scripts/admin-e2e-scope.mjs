// Can this change reach what the Admin Console E2E suite exercises?
//
//   git diff --no-renames --name-only <base> HEAD | node scripts/admin-e2e-scope.mjs
//   node scripts/admin-e2e-scope.mjs --all
//
// Prints `code=true` or `code=false` (appended to $GITHUB_OUTPUT when set)
// and says why on stderr. Admin Console E2E reads it to decide whether to
// build the app and run the suite; the job always runs and reports.
//
// ## Why (2026-11-09, before the repository goes private)
//
// The suite was ~16% of Actions minutes. It used scripts/pr-ui-scope.mjs,
// which runs for anything the app renders, and in the first day not one of
// 34 runs skipped: the pull requests were marketing and consent pages, which
// the admin suite never opens. This asks the narrower question.
//
// ## The rule
//
// The suite drives the built app through the admin pages, the sign-in and
// re-authentication pages, and their API routes. A change runs it when it is
// reached from those (scripts/import-closure.mjs, following the pages'
// `"/api/..."` fetches into their route handlers), from the root layouts and
// request pipeline every page passes through, or from the suite and its
// runner. Everything runs for the schema, package files, configs, public
// assets, this script, the closure script and the workflow, and for any
// input this cannot read.

import { readFileSync } from "node:fs";

import { changedPathsFrom, importClosure, reaches } from "./import-closure.mjs";

export const ADMIN_E2E_ENTRIES = Object.freeze([
    "tests/e2e-admin",
    "playwright.admin.config.ts",
    "scripts/run-admin-e2e.mjs",
    "app/(site)/(application)/admin",
    // The two auth pages the suite opens (tests/adminE2EScope.test.mjs keeps
    // this list equal to the specs' navigations), not sign-up or email.
    "app/(site)/(application)/auth/layout.tsx",
    "app/(site)/(application)/auth/signin",
    "app/(site)/(application)/auth/admin-reauthenticate",
    "app/api/admin",
    "app/api/auth",
    // What every page passes through on the way to the admin console.
    "app/(site)/layout.tsx",
    "app/(site)/(application)/layout.tsx",
    "app/global-error.tsx",
    "app/global-not-found.tsx",
    "app/not-found.tsx",
    "app/globals.css",
    "app/manifest.ts",
    "proxy.ts",
    "middleware.ts",
    "instrumentation.ts",
    "instrumentation-client.ts",
]);

/**
 * Pages under the admin tree that the suite never opens: the chat fixture
 * workspace is the Chat E04 staging fixture (docs/ui-contracts/chat-e04-staging-fixture.md),
 * driven by the chat suites, and it imports the whole chat app.
 * tests/adminE2EScope.test.mjs fails if a spec ever navigates there.
 */
export const NOT_VISITED = Object.freeze([/^app\/\(site\)\/\(application\)\/admin\/chat-e2e\//]);

const RUN_ALL = [
    /^prisma\//,
    /^public\//,
    /^package(-lock)?\.json$/,
    /^tsconfig(\.[^/]+)?\.json$/,
    /^next\.config\.[cm]?[jt]s$/,
    /^postcss\.config\.[cm]?[jt]s$/,
    /^\.nvmrc$/,
    /^scripts\/(admin-e2e-scope|import-closure)\.mjs$/,
    /^scripts\/ci\//,
    /^\.github\/workflows\/admin-console-e2e\.yml$/,
    // The layout and loading files of the route groups the admin pages sit in.
    /^app\/\(site\)\/(\(application\)\/)?(layout|template|loading|error|not-found)\.[jt]sx?$/,
];

export const adminE2EScope = (changedPaths, root = process.cwd()) => {
    const paths = changedPaths.filter((path) => path !== "");
    if (paths.length === 0) return { code: true, reason: "no changed paths were given, so the suite runs" };
    const runAll = paths.find((path) => RUN_ALL.some((pattern) => pattern.test(path)));
    if (runAll) return { code: true, reason: `${runAll} is read by every page or by the suite's setup` };
    const closure = importClosure(root, ADMIN_E2E_ENTRIES, {
        followApiLiterals: true,
        // The app does not spawn the scripts its code names; the suite's
        // runner is an entry of its own.
        followNamedScripts: false,
        skip: (file) => NOT_VISITED.some((pattern) => pattern.test(file)),
    });
    // A document is part of the running app only if the app imports it; one a
    // comment or a policy check names is not.
    const hit = paths.find((path) => reaches(closure, path, { importedOnly: (file) => file.startsWith("docs/") }));
    if (hit) return { code: true, reason: `${hit} is reached by the admin console or its suite` };
    return { code: false, reason: `none of the ${paths.length} changed path(s) is reached by the admin console` };
};

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { appendFileSync } = await import("node:fs");
    const input = process.argv.includes("--all") ? "" : readFileSync(0, "utf8");
    let result;
    try {
        result = adminE2EScope(changedPathsFrom(input));
    } catch (error) {
        result = { code: true, reason: `the scope could not be computed (${error.message}), so the suite runs` };
    }
    console.error(`admin console suite: ${result.code ? "run" : "skipped"} -- ${result.reason}.`);
    console.log(`code=${result.code}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `code=${result.code}\n`);
}
