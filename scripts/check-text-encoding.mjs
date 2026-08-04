import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENCODING_MARKER_PATTERNS,
  findQuestionRunsInsideStrings,
} from "./text-encoding-check-core.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");

const roots = ["app", "components", "lib", "locales"];
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

const patterns = ENCODING_MARKER_PATTERNS;

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

for (const rootName of roots) {
  for (const file of walk(path.join(root, rootName))) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of findQuestionRunsInsideStrings(text, file)) {
      const position = lineAndColumn(text, match.index);
      findings.push({
        file: path.relative(root, file),
        pattern: "question-mark-run-in-string",
        sample: match.sample,
        ...position,
      });
      if (findings.length >= 200) break;
    }
    if (findings.length >= 200) break;
    for (const pattern of patterns) {
      pattern.regex.lastIndex = 0;
      for (const match of text.matchAll(pattern.regex)) {
        const position = lineAndColumn(text, match.index ?? 0);
        findings.push({
          file: path.relative(root, file),
          pattern: pattern.name,
          sample: match[0],
          ...position,
        });
        if (findings.length >= 200) break;
      }
      if (findings.length >= 200) break;
    }
    if (findings.length >= 200) break;
  }
  if (findings.length >= 200) break;
}

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
