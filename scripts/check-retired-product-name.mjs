// Fails when the retired product name "Tomverse Insight" appears on an active
// surface. See scripts/check-retired-product-name-core.mjs for what counts as
// the retired name, why the bare word "Insight" is never a signal, and which
// paths keep it on purpose. This file only gathers what the core reasons over.
//
// Usage:
//   node scripts/check-retired-product-name.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { describeFindings, findRetiredProductName } from "./check-retired-product-name-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const read = (path) => {
    try {
        return readFileSync(join(root, path), "utf8");
    } catch {
        return "";
    }
};

/**
 * Everything a user can end up reading, plus what generates it.
 *
 * `prisma/generated` is excluded because it is regenerated output, and
 * `.github/audits` is reached but allowlisted by the core rather than skipped
 * here -- the difference matters: a skipped directory is invisible, an
 * allowlisted one is a decision the report can name.
 */
const SCANNED_DIRECTORIES = [
    "app",
    "components",
    "lib",
    "locales",
    "packages",
    "public",
    "scripts",
    "tests",
    "docs",
    "prisma/migrations",
    ".github",
];

const SCANNED_EXTENSIONS = new Set([
    ".ts",
    ".tsx",
    ".js",
    ".mjs",
    ".json",
    ".md",
    ".yaml",
    ".yml",
    ".sql",
    ".txt",
    ".html",
]);

const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".next", "generated"]);

const walk = (dir, found = []) => {
    let entries;
    try {
        entries = readdirSync(join(root, dir));
    } catch {
        return found;
    }
    for (const entry of entries) {
        if (SKIPPED_DIRECTORY_NAMES.has(entry)) continue;
        const full = join(dir, entry);
        if (statSync(join(root, full)).isDirectory()) walk(full, found);
        else found.push(full);
    }
    return found;
};

const rootMarkdown = readdirSync(root).filter((entry) => extname(entry) === ".md");

const paths = [...SCANNED_DIRECTORIES.flatMap((dir) => walk(dir)), ...rootMarkdown].filter((path) =>
    SCANNED_EXTENSIONS.has(extname(path))
);

const sources = paths.map((path) => ({ path: relative(".", path), text: read(path) }));

const findings = findRetiredProductName({ sources });

if (findings.length > 0) {
    console.error(describeFindings(findings));
    process.exit(1);
}

console.log(
    `Retired product name check passed: ${sources.length} file(s) scanned, ` +
        `none carries "Tomverse Insight" outside the historical allowlist.`
);
