// Fails when an instruction document names a file that does not exist.
//
// See scripts/check-doc-references-core.mjs for why.

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  auditDocumentReferences,
  documentReferences,
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

const { errors } = auditDocumentReferences({
  references,
  exists: (path) => {
    const full = join(root, path);
    if (!existsSync(full)) return false;
    // A directory is not a file reference; the documents name files.
    return statSync(full).isFile() || statSync(full).isDirectory();
  },
});

if (errors.length > 0) {
  console.error(
    `\n${errors.length} broken reference(s) in the instruction documents:\n` +
      errors.map((message) => `  - ${message}`).join("\n") +
      "\n\nAGENTS.md and the documents under it are read as instructions that\n" +
      "override default behaviour. A path with nothing at it costs more than a\n" +
      "missing sentence would.\n"
  );
  process.exit(1);
}

console.log(
  `Document reference check passed: ${references.size} referenced path(s) across ` +
    `${markdownFiles.length} instruction document(s), all present.`
);
