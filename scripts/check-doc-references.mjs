// Fails when an instruction document, or a comment in the source, names a file
// that does not exist.
//
// See scripts/check-doc-references-core.mjs for why.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditDocumentReferences,
  auditSourceCommentReferences,
  documentReferences,
  sourceCommentReferences,
} from "./check-doc-references-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

/**
 * The documents whose references are instructions rather than history.
 * `.github/audits/` is deliberately excluded: an audit records what a tree
 * looked like on a date, so a path that has since moved is the point of the
 * record, not a defect in it.
 */
const DOCUMENT_ROOTS = ["docs/policy", "docs/ui-contracts", "docs/ops"];
const DOCUMENT_FILES = [
  "AGENTS.md",
  "CLAUDE.md",
  ".github/RELEASE_CHECKLIST.md",
];

const markdownFiles = [];
for (const file of DOCUMENT_FILES) {
  if (existsSync(join(root, file))) markdownFiles.push(file);
}
for (const dir of DOCUMENT_ROOTS) {
  const full = join(root, dir);
  if (!existsSync(full)) continue;
  for (const entry of readdirSync(full)) {
    if (entry.endsWith(".md")) markdownFiles.push(join(dir, entry));
  }
}

const references = new Map();
for (const file of markdownFiles) {
  for (const path of documentReferences(readFileSync(join(root, file), "utf8"))) {
    if (!references.has(path)) references.set(path, new Set());
    references.get(path).add(file);
  }
}

const exists = (path) => existsSync(join(root, path));

const { errors: documentErrors } = auditDocumentReferences({
  references,
  exists,
});

/**
 * The source files whose comments are swept.
 *
 * `node_modules` and build output are excluded because their comments are not
 * this repository's to fix; nothing else is, because a stale pointer costs the
 * same wherever it is written.
 */
const SOURCE_ROOTS = [
  "lib",
  "app",
  "components",
  "hooks",
  "scripts",
  "tests",
  "packages",
  "prisma",
];
const SOURCE_FILES = ["proxy.ts", "next.config.ts", "eslint.config.mjs"];
const SKIPPED_DIRECTORIES = new Set([
  "node_modules",
  ".next",
  ".git",
  "dist",
  "build",
  "coverage",
]);
const SOURCE_EXTENSION = /\.(?:ts|tsx|mjs|cjs|js|jsx)$/;

const sourceFiles = [];
for (const file of SOURCE_FILES) {
  if (existsSync(join(root, file))) sourceFiles.push(file);
}
const collectSources = (directory) => {
  for (const entry of readdirSync(join(root, directory))) {
    if (SKIPPED_DIRECTORIES.has(entry)) continue;
    const relativePath = join(directory, entry);
    if (statSync(join(root, relativePath)).isDirectory()) {
      collectSources(relativePath);
    } else if (SOURCE_EXTENSION.test(entry)) {
      sourceFiles.push(relativePath);
    }
  }
};
for (const directory of SOURCE_ROOTS) {
  if (existsSync(join(root, directory))) collectSources(directory);
}

const commentReferences = new Map();
for (const file of sourceFiles) {
  for (const path of sourceCommentReferences(
    readFileSync(join(root, file), "utf8")
  )) {
    // A comment naming its own file is a heading, not a pointer.
    if (path === relative(root, join(root, file))) continue;
    if (!commentReferences.has(path)) commentReferences.set(path, new Set());
    commentReferences.get(path).add(file);
  }
}

const { errors: commentErrors } = auditSourceCommentReferences({
  references: commentReferences,
  exists,
});

if (documentErrors.length > 0 || commentErrors.length > 0) {
  if (documentErrors.length > 0) {
    console.error(
      `\n${documentErrors.length} broken reference(s) in the instruction documents:\n` +
        documentErrors.map((message) => `  - ${message}`).join("\n") +
        "\n\nAGENTS.md and the documents under it are read as instructions that\n" +
        "override default behaviour. A path with nothing at it costs more than a\n" +
        "missing sentence would.\n"
    );
  }
  if (commentErrors.length > 0) {
    console.error(
      `\n${commentErrors.length} broken reference(s) in source comments:\n` +
        commentErrors.map((message) => `  - ${message}`).join("\n") +
        "\n\nA comment that names a test file is making a claim about coverage, and a\n" +
        "comment that names a module is telling the next reader where to look. Both\n" +
        "are believed without being opened, which is exactly why neither is checked\n" +
        "by anything else.\n"
    );
  }
  process.exit(1);
}

console.log(
  `Document reference check passed: ${references.size} referenced path(s) across ` +
    `${markdownFiles.length} instruction document(s), and ` +
    `${commentReferences.size} path(s) named by comments across ` +
    `${sourceFiles.length} source file(s), all present.`
);
