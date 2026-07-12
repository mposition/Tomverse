import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const strict = process.argv.includes("--strict");

const roots = ["app", "components", "lib", "locales"];
const extensions = new Set([".ts", ".tsx", ".js", ".jsx", ".md", ".json"]);

const patterns = [
  { name: "replacement-character", regex: /\uFFFD/g },
  { name: "latin1-mojibake-marker", regex: /[\u00C2\u00C3]/g },
  { name: "smart-quote-mojibake", regex: /\u00E2[\u20AC\u201A\u201C\u201D\u201E\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D\u2018\u2019\u201A\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178]/g },
  { name: "korean-mojibake-marker", regex: /[\u00EC\u00ED][\u00A0-\u00BF]/g },
  { name: "cjk-mojibake-marker", regex: /[\u00E5\u00E6][\u00A0-\u00BF]/g },
];

function findQuestionRunsInsideStrings(text) {
  const matches = [];
  let quote = null;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote) {
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === quote) {
        quote = null;
        continue;
      }
      if (char === "?" && text[index + 1] === "?") {
        let end = index + 2;
        while (text[end] === "?") end += 1;
        matches.push({ index, sample: text.slice(index, end) });
        index = end - 1;
      } else if (
        char === "?" &&
        /[\p{L}\p{N}]/u.test(text[index - 1] ?? "") &&
        /[\p{L}\p{N}]/u.test(text[index + 1] ?? "") &&
        !/[/:=&${}`]/.test(text.slice(Math.max(0, index - 10), Math.min(text.length, index + 10)))
      ) {
        matches.push({ index, sample: text.slice(Math.max(0, index - 8), index + 9) });
      }
      continue;
    }

    if (char === "\"" || char === "'" || char === "`") {
      quote = char;
    }
  }

  return matches;
}

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
    for (const match of findQuestionRunsInsideStrings(text)) {
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
