// Fails when production code creates a Conversation row without going through
// the shared creation service. See scripts/check-conversation-writers-core.mjs
// for why, and for which paths are allowed to and on what grounds.
//
// Usage:
//   node scripts/check-conversation-writers.mjs

import { readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
    describeFindings,
    findDirectConversationWriters,
} from "./check-conversation-writers-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

const read = (path) => {
    try {
        return readFileSync(join(root, path), "utf8");
    } catch {
        return "";
    }
};

// Everything that runs in production, plus tests and generated code so the
// allowlist has to excuse them by name rather than by their absence from a
// scan nobody can see.
const SCANNED_DIRECTORIES = ["app", "components", "lib", "packages", "scripts", "tests", "prisma"];
const SCANNED_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".mjs"]);
const SKIPPED_DIRECTORY_NAMES = new Set(["node_modules", ".next"]);

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

const paths = SCANNED_DIRECTORIES.flatMap((dir) => walk(dir)).filter((path) =>
    SCANNED_EXTENSIONS.has(extname(path))
);

const sources = paths.map((path) => ({ path: relative(".", path), text: read(path) }));

const findings = findDirectConversationWriters({ sources });

if (findings.length > 0) {
    console.error(describeFindings(findings));
    process.exit(1);
}

console.log(
    `Conversation writer check passed: ${sources.length} file(s) scanned, every ` +
        `production write goes through lib/conversationCreation.ts.`
);
