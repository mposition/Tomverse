// Can this pull request change what a browser renders?
//
//   git diff --no-renames --name-only <base>...HEAD | node scripts/pr-ui-scope.mjs
//
// Prints `code=true` or `code=false` (appended to $GITHUB_OUTPUT when set)
// and says why on stderr. PR Fast Gate's build-and-e2e and ui-risk jobs and
// Review Parity read it to decide whether to build the app and drive a
// browser; the jobs themselves always run and report.
//
// ## The rule: skip only what is provably outside the app
//
// A path counts as outside the app only if it is in one of the trees below
// AND nothing the app builds from reaches it. Everything else -- app/,
// components/, lib/, locales/, public/, prisma/, styles, package files,
// next/tsconfig/playwright config, tests/e2e/ -- runs the browser checks, and
// so does any input this cannot read (no diff, an empty diff).
//
// scripts/ is the case that needs care: app code imports from it
// (`@/scripts/mobile-auth-keyring-state.mjs`, `../scripts/report-issue-backlog-core.mjs`),
// and the build runs scripts named in package.json. So a scripts/ file is
// outside the app only when no file under the app trees, and no build or e2e
// npm script, reaches it -- directly or through other scripts/ files.
//
// ## Why (2026-10-03)
//
// After the concurrent-job limit was raised to 40, a snapshot still showed 39
// jobs running and 41 queued. A develop pull request occupies ~20 jobs, and
// the four ui-risk shards alone are ~44 runner-minutes, spent identically on
// a pull request that only touches a policy document, a unit test or a Rust
// crate. The old rule skipped top-level Markdown and audit reports only.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";

/** Trees that are never part of the built app or its browser tests. */
const OUTSIDE_APP = [
    /^docs\//,
    /^\.github\/audits\//,
    /^[^/]+\.md$/,
    /^tests\/[^/]+\.test\.(mjs|ts|tsx)$/,
    /^tests\/client\//,
    /^tests\/integration\//,
    /^vendor\/amux\//,
    /^apps\/tomverse-orchestrator\//,
    /^crates\//,
    /^Cargo\.(toml|lock)$/,
    /^\.codex\//,
    /^\.claude\//,
    // Workflows, except the ones whose own jobs this decides for.
    /^\.github\/workflows\/(?!pr-fast-gate\.yml$|review-parity-shadow\.yml$)[^/]+\.ya?ml$/,
];

/** Trees whose files the app is built from; imports out of them are followed. */
const APP_TREES = ["app", "components", "lib", "locales", "hooks", "styles"];
const APP_ROOT_FILES = ["next.config.ts", "proxy.ts", "middleware.ts", "instrumentation.ts"];
/** npm scripts these jobs run, directly or as hooks. */
const BUILD_AND_E2E_NPM_SCRIPTS = /^(pre|post)?(build|start(:e2e)?|test:e2e[:\w-]*|verify:smoke-coverage)$/;

const SOURCE = /\.(m?[jt]sx?|cjs)$/;
const SPECIFIER = /(?:from|import|require)\s*\(?\s*["']([^"']+)["']/g;
const SCRIPT_PATH = /scripts\/[A-Za-z0-9_./-]+\.(?:mjs|cjs|js|ts|sh)/g;

const walk = (root, dir) => {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) return [];
    return readdirSync(absolute).flatMap((name) => {
        const rel = join(dir, name).replaceAll("\\", "/");
        if (name === "node_modules" || name.startsWith(".")) return [];
        return statSync(join(root, rel)).isDirectory() ? walk(root, rel) : [rel];
    });
};

/**
 * scripts/ files the app or its build reaches, followed through the
 * relative imports scripts/ files make of one another.
 */
export const scriptsReachedByApp = (root) => {
    const seeds = new Set();
    const note = (path) => {
        const clean = normalize(path).replaceAll("\\", "/");
        if (clean.startsWith("scripts/")) seeds.add(clean);
    };
    const appFiles = [
        ...APP_TREES.flatMap((tree) => walk(root, tree)),
        ...APP_ROOT_FILES.filter((file) => existsSync(join(root, file))),
    ].filter((file) => SOURCE.test(file));
    for (const file of appFiles) {
        const text = readFileSync(join(root, file), "utf8");
        for (const [, spec] of text.matchAll(SPECIFIER)) {
            if (spec.startsWith("@/scripts/")) note(spec.slice(2));
            else if (spec.startsWith(".") && spec.includes("scripts/")) note(relative(root, join(root, dirname(file), spec)));
        }
    }
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    for (const [name, command] of Object.entries(pkg.scripts ?? {})) {
        if (!BUILD_AND_E2E_NPM_SCRIPTS.test(name)) continue;
        for (const [path] of String(command).matchAll(SCRIPT_PATH)) note(path);
    }
    // Close over scripts/ importing scripts/.
    const queue = [...seeds];
    while (queue.length > 0) {
        const file = queue.pop();
        if (!existsSync(join(root, file)) || !SOURCE.test(file)) continue;
        const text = readFileSync(join(root, file), "utf8");
        for (const [, spec] of text.matchAll(SPECIFIER)) {
            if (!spec.startsWith(".")) continue;
            const target = normalize(join(dirname(file), spec)).replaceAll("\\", "/");
            if (target.startsWith("scripts/") && !seeds.has(target)) {
                seeds.add(target);
                queue.push(target);
            }
        }
    }
    return seeds;
};

export const uiScope = (changedPaths, reachedScripts) => {
    const paths = changedPaths.map((path) => path.trim()).filter((path) => path !== "");
    if (paths.length === 0) return { code: true, reason: "no changed paths were given, so everything runs" };
    for (const path of paths) {
        if (path.startsWith("scripts/")) {
            if (reachedScripts.has(path) || path.startsWith("scripts/ci/")) {
                return { code: true, reason: `${path} is reached by the app, its build or its browser tests` };
            }
            continue;
        }
        if (!OUTSIDE_APP.some((pattern) => pattern.test(path))) {
            return { code: true, reason: `${path} can change what the app renders` };
        }
    }
    return { code: false, reason: `all ${paths.length} changed path(s) are outside the app` };
};

const { pathToFileURL } = await import("node:url");
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const { appendFileSync } = await import("node:fs");
    const input = process.argv.includes("--all") ? "" : readFileSync(0, "utf8");
    let result;
    try {
        result = uiScope(input.split("\n"), scriptsReachedByApp(process.cwd()));
    } catch (error) {
        result = { code: true, reason: `the scope could not be computed (${error.message}), so everything runs` };
    }
    console.error(`browser checks: ${result.code ? "run" : "skipped"} -- ${result.reason}.`);
    console.log(`code=${result.code}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `code=${result.code}\n`);
}
