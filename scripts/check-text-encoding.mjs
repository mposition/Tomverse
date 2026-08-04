import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENCODING_MARKER_PATTERNS,
  findQuestionRunsInsideStrings,
  MARKER_SCOPES,
} from "./text-encoding-check-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");

// Where product copy lives. The mojibake markers and the question-mark rule
// ask whether shipped text is corrupted, so these are the only roots where
// their answer means anything -- over tests and docs they report fixtures that
// are deliberately mojibake-shaped, 37 of them at the last count, and a
// checker whose output is mostly false is one nobody reads.
const PRODUCT_TEXT_ROOTS = ["app", "components", "lib", "locales"];

// Everything with source in it. The control-character rule asks whether a file
// can be reviewed at all, which has nothing to do with whether it ships text:
// one unprintable byte makes git call the file binary and a pull request
// touching it shows no diff. Scoping this rule to the roots above is what left
// a literal NUL in tests/server-contract/guest-attachment-route.test.ts, in a
// test asserting that an executable payload is rejected -- so the assertion
// nobody could read was the one about a malicious upload.
const EVERY_SOURCE_ROOTS = [
  ...PRODUCT_TEXT_ROOTS,
  "scripts",
  "tests",
  "prisma",
  "docs",
  ".github",
];

const extensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".md",
  ".json",
]);

function walk(dir, files = []) {
  if (!fs.existsSync(dir)) return files;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".next") continue;
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(fullPath, files);
    } else if (extensions.has(path.extname(entry.name))) {
      files.push(fullPath);
    }
  }
  return files;
}

function lineAndColumn(text, index) {
  const before = text.slice(0, index);
  const lines = before.split(/\r?\n/);
  return { line: lines.length, column: lines.at(-1).length + 1 };
}

const findings = [];
const full = () => findings.length >= 200;

// A file can be in both scopes, so it is read once and each scope's patterns
// are applied to it. `seen` keeps the wider walk from re-reporting the
// product roots.
const seen = new Set();

const scan = (rootNames, patterns, { questionRuns }) => {
  for (const rootName of rootNames) {
    for (const file of walk(path.join(root, rootName))) {
      if (full()) return;
      if (seen.has(file)) continue;
      seen.add(file);
      const text = fs.readFileSync(file, "utf8");
      const relative = path.relative(root, file);

      if (questionRuns) {
        for (const match of findQuestionRunsInsideStrings(text, file)) {
          if (full()) return;
          findings.push({
            file: relative,
            pattern: "question-mark-run-in-string",
            sample: match.sample,
            ...lineAndColumn(text, match.index),
          });
        }
      }

      for (const pattern of patterns) {
        pattern.regex.lastIndex = 0;
        for (const match of text.matchAll(pattern.regex)) {
          if (full()) return;
          findings.push({
            file: relative,
            pattern: pattern.name,
            sample: match[0],
            ...lineAndColumn(text, match.index ?? 0),
          });
        }
      }
    }
  }
};

const byScope = (scope) =>
  ENCODING_MARKER_PATTERNS.filter((pattern) => pattern.scope === scope);

// Product roots first, with every pattern that applies to them; then the wider
// walk with only the rules that apply everywhere.
scan(PRODUCT_TEXT_ROOTS, ENCODING_MARKER_PATTERNS, { questionRuns: true });
scan(EVERY_SOURCE_ROOTS, byScope(MARKER_SCOPES.EVERY_SOURCE), {
  questionRuns: false,
});

if (findings.length === 0) {
  console.log("Text encoding check passed. No mojibake markers found.");
  process.exit(0);
}

console.log(`Text encoding check found ${findings.length}${findings.length >= 200 ? "+" : ""} suspicious marker(s):`);
for (const finding of findings) {
  console.log(
    `- ${finding.file}:${finding.line}:${finding.column} ${finding.pattern} ${JSON.stringify(finding.sample)}`
  );
}

if (strict) {
  process.exit(1);
}

console.log("Warning only. Run `npm run check:encoding:strict` to fail on these markers.");
