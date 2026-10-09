// Fails when a tracked package.json declares the same key twice.
//
// JSON permits it and every reader silently keeps one entry, so the file can
// claim one thing while all tooling does another -- and a tool that parses and
// re-serialises the file drops the loser from the bytes as well. The root
// package.json carried a duplicated `report:provider-data-destinations` for
// long enough that it was found only when a round-trip deleted one of them.
//
// Scoped to package.json because that is the file in this repository that is
// hand-edited most often, by the most sessions, and in the one place -- a long
// flat `scripts` block -- where a second declaration is least visible.
//
// See scripts/check-package-json-duplicate-keys-core.mjs for the scan.
//
//   npm run check:package-json-duplicate-keys

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  describeDuplicate,
  duplicateJsonKeys,
} from "./check-package-json-duplicate-keys-core.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));

// Ask Git for the files rather than globbing: a quoted glob pathspec is passed
// through literally by Windows' command shell, and the filtering is a line of
// JavaScript anyway.
const files = execSync("git ls-files --cached --others --exclude-standard", {
  cwd: root,
  encoding: "utf8",
  maxBuffer: 64 * 1024 * 1024,
})
  .trim()
  .split("\n")
  .map((file) => file.trim().replaceAll("\\", "/"))
  .filter(
    (file) =>
      (file === "package.json" || file.endsWith("/package.json")) &&
      !file.includes("node_modules/")
  )
  .sort();

if (files.length === 0) {
  console.error(
    "\nNo package.json found. This check reports a count; with nothing to\n" +
      "count it would report a clean zero for the wrong reason.\n"
  );
  process.exit(1);
}

/** @type {string[]} */
const problems = [];

for (const file of files) {
  const source = readFileSync(join(root, file), "utf8");

  // A file that does not parse is a different defect with a clearer error,
  // and the scan below is deliberately lenient about malformed input -- so say
  // so here rather than reporting whatever the lenient walk made of it.
  try {
    JSON.parse(source);
  } catch (error) {
    problems.push(`${file}: is not valid JSON (${error.message})`);
    continue;
  }

  for (const duplicate of duplicateJsonKeys(source)) {
    problems.push(describeDuplicate(file, duplicate));
  }
}

if (problems.length > 0) {
  console.error(
    `\n${problems.length} duplicate package.json key(s):\n` +
      problems.map((problem) => `  - ${problem}`).join("\n") +
      "\n\nDelete all but one of each. JSON allows the repetition, so nothing\n" +
      "else in the build will report it: the file is valid, the entry simply\n" +
      "does not exist for any reader, and re-serialising the file deletes it\n" +
      "from the bytes too.\n"
  );
  process.exit(1);
}

console.log(
  `No duplicate keys in ${files.length} package.json file(s): ` +
    `${files.join(", ")}.`
);
