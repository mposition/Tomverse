// Fails when push-notification infrastructure appears in the tree while
// PUSH-01 is still unapproved.
//
// See scripts/check-push-scope-core.mjs for what counts as push infrastructure
// and why the word "push" is never on its own a signal. This file only gathers
// what the core reasons over.
//
// Usage:
//   node scripts/check-push-scope.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFindings, findPushInfrastructure } from "./check-push-scope-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const read = (path) => {
    try {
        return readFileSync(join(root, path), "utf8");
    } catch {
        return "";
    }
};

const SCANNED_DIRECTORIES = ["app", "components", "lib", "public"];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs", ".json"]);

const walk = (dir, found = []) => {
    let entries;
    try {
        entries = readdirSync(join(root, dir));
    } catch {
        return found;
    }
    for (const entry of entries) {
        if (entry === "node_modules" || entry === ".next") continue;
        const full = join(dir, entry);
        if (statSync(join(root, full)).isDirectory()) walk(full, found);
        else found.push(full);
    }
    return found;
};

const paths = SCANNED_DIRECTORIES.flatMap((dir) => walk(dir));

const packageJson = JSON.parse(read("package.json") || "{}");
const dependencies = [
    ...Object.keys(packageJson.dependencies ?? {}),
    ...Object.keys(packageJson.devDependencies ?? {}),
    ...Object.keys(packageJson.optionalDependencies ?? {}),
];

const sources = paths
    .filter((path) => SCANNED_EXTENSIONS.has(extname(path)))
    .map((path) => ({ path: relative(".", path), text: read(path) }));

/**
 * Environment names the deployment actually declares. Read from the documented
 * surfaces rather than from `process.env`, because this check runs on a machine
 * that has none of them set and the gate is about what the release configures.
 */
const environmentNames = [
    ...new Set(
        [read(".env.example"), read("docs/operations/environment.md"), read("README.md")]
            .join("\n")
            .matchAll(/\b([A-Z][A-Z0-9_]{3,})\b/g)
    ),
].map((match) => match[1]);

const findings = findPushInfrastructure({
    dependencies,
    sources,
    prismaSchema: read("prisma/schema.prisma"),
    paths: paths.map((path) => relative(".", path)),
    environmentNames,
});

if (findings.length > 0) {
    console.error(describeFindings(findings));
    process.exit(1);
}

console.log(
    `Push scope check passed (PUSH-01): ${sources.length} source file(s), ` +
        `${dependencies.length} dependencies and the Prisma schema carry no push ` +
        `infrastructure.`
);
