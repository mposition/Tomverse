// The repository files a set of entry files can reach.
//
// Used by the CI scope decisions that skip an expensive suite when a change
// cannot reach it (scripts/db-integration-scope.mjs,
// scripts/admin-e2e-scope.mjs). Being wrong in one direction costs minutes and
// in the other costs a skipped check, so everything here errs wide:
//
// - Imports are read with a pattern, not a parser: `from "x"`, `import("x")`,
//   `import "x"`, `require("x")`, `export ... from "x"`. A specifier inside a
//   comment or a string is followed too, which only ever adds files.
// - Local specifiers resolve as Node and TypeScript would: exact, then each
//   source extension, then `index.*`, and a `.js` specifier also tries `.ts`.
//   `@/x` is the repository root (tsconfig `paths`), and `@tomverse/<name>`
//   is the whole `packages/<name>/` tree.
// - A string literal that names a repository path -- `"lib/x.ts"`,
//   `"prisma/migrations/..."`, `new URL("../../lib/x.ts", import.meta.url)` --
//   counts as reached as well, file or directory prefix. That is how a test
//   that reads a source file or a migration with `readFileSync` is covered.
// - A literal `"/api/<segment>/<segment>"` (a fetch from a page) reaches
//   `app/api/<segment>/<segment>/`, so a page's route handlers are followed.
//
// What it cannot see -- a path built from variables, a route reached by a
// redirect -- the callers cover by running everything for the trees that hold
// such files (prisma/, package files, the runner itself).

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, posix } from "node:path";

const SOURCE = /\.(?:m?[jt]sx?|c[jt]s)$/;
const STYLE = /\.(?:css|scss)$/;
const EXTENSIONS = [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", ".css"];
const SPECIFIER = /(?:\bfrom|\bimport|\brequire)\s*\(?\s*["'`]([^"'`\n]+)["'`]/g;
const REPO_TREES = "app|components|lib|locales|hooks|styles|prisma|scripts|tests|docs|public|packages|config";
const REPO_LITERAL = new RegExp(`["'\`]((?:\\.{1,2}/)*(?:${REPO_TREES})/[A-Za-z0-9_.@()\\[\\]/-]+)["'\`]`, "g");
const API_LITERAL = /["'`]\/api\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+))?/g;

const toPosix = (path) => path.replaceAll("\\", "/");
const clean = (path) => posix.normalize(toPosix(path)).replace(/^\.\//, "");

export const walk = (root, dir) => {
    const absolute = join(root, dir);
    if (!existsSync(absolute)) return [];
    if (!statSync(absolute).isDirectory()) return [clean(dir)];
    return readdirSync(absolute).flatMap((name) => {
        if (name === "node_modules" || name === ".next" || name.startsWith(".")) return [];
        return walk(root, posix.join(dir, name));
    });
};

const isFile = (root, path) => {
    try {
        return statSync(join(root, path)).isFile();
    } catch {
        return false;
    }
};

const resolveLocal = (root, target) => {
    const base = clean(target);
    const candidates = [base, ...EXTENSIONS.map((ext) => base + ext), ...EXTENSIONS.map((ext) => `${base}/index${ext}`)];
    if (/\.[cm]?jsx?$/.test(base)) {
        const stem = base.replace(/\.[cm]?jsx?$/, "");
        candidates.push(`${stem}.ts`, `${stem}.tsx`, `${stem}.mts`, `${stem}.cts`);
    }
    return candidates.find((candidate) => isFile(root, candidate)) ?? null;
};

/** Path segments: a bare tree such as `lib/` is too wide to name. */
const depth = (dir) => dir.split("/").filter(Boolean).length;

/** What one file points at, read once per process. */
const edgeCache = new Map();
export const edgesOf = (root, file) => {
    const key = `${root}\0${file}`;
    const cached = edgeCache.get(key);
    if (cached) return cached;
    const edges = { files: [], reads: [], trees: [], prefixes: [], api: [] };
    edgeCache.set(key, edges);
    let text;
    try {
        text = readFileSync(join(root, file), "utf8");
    } catch {
        return edges;
    }
    const here = posix.dirname(file);
    const local = (target, { executed }) => {
        const resolved = resolveLocal(root, target);
        if (resolved) {
            // A named file is read, not run -- except a script, which is
            // named to be spawned. Following every file a comment or a
            // source-reading test mentions would join every closure into one.
            if (executed || resolved.startsWith("scripts/")) edges.files.push(resolved);
            else edges.reads.push(resolved);
            return;
        }
        const dir = clean(target);
        if (dir.startsWith("../")) return;
        if (existsSync(join(root, dir))) {
            // An imported directory runs its files; a directory a test lists
            // or reads only names them.
            if (executed) edges.trees.push(dir);
            else if (depth(dir) >= 2) edges.prefixes.push(`${dir.replace(/\/$/, "")}/`);
            return;
        }
        // A path that does not exist yet still names its directory.
        const parent = posix.dirname(dir);
        if (!executed && depth(parent) >= 2 && existsSync(join(root, parent))) edges.prefixes.push(`${parent}/`);
    };
    for (const [, spec] of text.matchAll(SPECIFIER)) {
        if (spec.startsWith("@/")) local(spec.slice(2), { executed: true });
        else if (spec.startsWith("./") || spec.startsWith("../")) local(posix.join(here, spec), { executed: true });
        else if (spec.startsWith("@tomverse/")) edges.trees.push(`packages/${spec.split("/")[1]}`);
    }
    for (const [, literal] of text.matchAll(REPO_LITERAL)) {
        local(literal.startsWith(".") ? posix.join(here, literal) : literal, { executed: false });
    }
    for (const [, first, second] of text.matchAll(API_LITERAL)) {
        const dir = second && existsSync(join(root, `app/api/${first}/${second}`)) ? `app/api/${first}/${second}` : `app/api/${first}`;
        if (existsSync(join(root, dir))) edges.api.push(dir);
    }
    return edges;
};

/**
 * @param {{ skip?: (file: string) => boolean, followApiLiterals?: boolean }} [options]
 *   `skip` names files that are never reached, and so never followed.
 *   `followApiLiterals` follows a page's `"/api/..."` fetches into the route
 *   handlers under app/api/ -- for a suite that drives the running app.
 * @returns {{ files: Set<string>, prefixes: Set<string> }} every reached file,
 * and the directory prefixes (ending in "/") reached as a whole.
 */
export const importClosure = (root, entries, { skip = () => false, followApiLiterals = false } = {}) => {
    const files = new Set();
    const prefixes = new Set();
    const trees = new Set();
    const queue = [];
    const reach = (path) => {
        const file = clean(path);
        if (file.startsWith("../") || files.has(file) || skip(file)) return;
        files.add(file);
        if (SOURCE.test(file) || STYLE.test(file)) queue.push(file);
    };
    const reachTree = (dir) => {
        const prefix = `${clean(dir).replace(/\/$/, "")}/`;
        if (trees.has(prefix)) return;
        trees.add(prefix);
        prefixes.add(prefix);
        for (const file of walk(root, prefix)) reach(file);
    };
    for (const entry of entries) {
        if (isFile(root, entry)) reach(entry);
        else if (existsSync(join(root, entry))) reachTree(entry);
    }
    while (queue.length > 0) {
        const edges = edgesOf(root, queue.pop());
        for (const file of edges.files) reach(file);
        for (const file of edges.reads) if (!skip(file)) files.add(file);
        for (const dir of edges.trees) reachTree(dir);
        for (const prefix of edges.prefixes) prefixes.add(prefix);
        if (followApiLiterals) for (const dir of edges.api) reachTree(dir);
    }
    return { files, prefixes };
};

/** Whether a changed path is in a closure: a reached file or under a reached tree. */
export const reaches = (closure, path) => {
    const file = clean(path);
    if (closure.files.has(file)) return true;
    for (const prefix of closure.prefixes) if (file.startsWith(prefix)) return true;
    return false;
};

/** Reads changed paths (one per line) from text, dropping blanks. */
export const changedPathsFrom = (text) =>
    text
        .split("\n")
        .map((line) => toPosix(line.trim()))
        .filter((line) => line !== "");

export const isSourcePath = (path) => SOURCE.test(path);

