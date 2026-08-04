import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { extname, join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  ENCODING_MARKER_PATTERNS,
  findQuestionRunsInsideStrings,
  stringLikeRanges,
} from "../scripts/text-encoding-check-core.mjs";

// The first three cases predate #278 and are the acceptance bar for it: the
// checker stopped asking the TypeScript compiler where the strings are and
// scans for them itself, so these must keep passing unchanged.
//
// The rest exist because that answer is now this file's own responsibility.
// While the compiler produced the ranges, "is `<` a JSX element or a
// comparison?" was not a question this repository had to get right; it is now,
// and each case below is one way a scanner can lose its place -- after which it
// either reports code as prose or stops reading strings entirely, and both fail
// quietly.

test("nullish coalescing in TypeScript code is not an encoding finding", () => {
  const source = `
    // A quote in a comment must not corrupt lexer state: user's value
    const total = signedDecimal(record.TotalCount ?? 0, "Data.TotalCount");
    const fallback = value ?? "normal";
  `;
  assert.deepEqual(findQuestionRunsInsideStrings(source, "fixture.ts"), []);
});

test("question-mark runs in user-facing string literals are still detected", () => {
  const source = `
    const broken = "Encoding failed ?? please retry";
    const template = \`Broken ??? text \${value ?? "valid"}\`;
  `;
  const matches = findQuestionRunsInsideStrings(source, "fixture.ts");
  assert.deepEqual(
    matches.map((match) => match.sample),
    ["??", "???"]
  );
});

test("Markdown code examples do not trigger prose encoding findings", () => {
  const source = [
    "Use the nullish operator `left ?? right`.",
    "```ts",
    "const value = left ?? right;",
    "```",
    "Broken prose ?? is still detected.",
  ].join("\n");
  const matches = findQuestionRunsInsideStrings(source, "fixture.md");
  assert.deepEqual(matches.map((match) => match.sample), ["??"]);
});

test("JSX text is scanned and the code around it is not", () => {
  const source = `const el = <p title="attr ??">Hello ?? there{value ?? 1}</p>;`;
  const matches = findQuestionRunsInsideStrings(source, "fixture.tsx");
  // The attribute value and the element's text, never the `??` in the
  // expression container between them.
  assert.deepEqual(matches.map((match) => match.sample), ["??", "??"]);
  assert.deepEqual(
    stringLikeRanges(source, "fixture.tsx")
      .map((range) => source.slice(range.start, range.end))
      .filter((text) => text.includes("?")),
    ['"attr ??"', "Hello ?? there"]
  );
});

test("division is not mistaken for a regular expression", () => {
  // The failure this guards: reading `/` as opening a regex swallows the rest
  // of the line, including the closing backtick, and the scanner then treats
  // real code as template text for as long as it takes to find another quote.
  const source = "const label = `${(bytes / (1024 * 1024)).toFixed(1)} MB`;\n" +
    'const broken = "size ?? unknown";';
  const matches = findQuestionRunsInsideStrings(source, "fixture.ts");
  assert.deepEqual(matches.map((match) => match.sample), ["??"]);
});

test("a regular expression is not mistaken for the start of a string", () => {
  const source = `const quote = /"/g;\nconst broken = "still ?? found";`;
  const matches = findQuestionRunsInsideStrings(source, "fixture.ts");
  assert.deepEqual(matches.map((match) => match.sample), ["??"]);
});

test("a comparison is not mistaken for a JSX element", () => {
  const source = `const ok = a < b > c;\nconst broken = "after ?? compare";`;
  const matches = findQuestionRunsInsideStrings(source, "fixture.tsx");
  assert.deepEqual(matches.map((match) => match.sample), ["??"]);
});

test("a type assertion in .ts is never read as JSX", () => {
  // `<string>value` is a cast in .ts and an element in .tsx. Reading it as an
  // element here would treat `value; const s = "` as JSX text.
  const source = `const v = <string>value;\nconst broken = "cast ?? ok";`;
  const matches = findQuestionRunsInsideStrings(source, "fixture.ts");
  assert.deepEqual(matches.map((match) => match.sample), ["??"]);
});

test("nested template substitutions resume the template they interrupted", () => {
  const source = "const t = `a ?? ${`b ?? ${c ?? 1} d`} e ??`;";
  const matches = findQuestionRunsInsideStrings(source, "fixture.ts");
  // Three template texts carry `??`; the `c ?? 1` inside the substitution does
  // not.
  assert.deepEqual(matches.map((match) => match.sample), ["??", "??", "??"]);
});

test("an unterminated string does not consume the rest of the file", () => {
  const source = `const broken = "unclosed\nconst after = "then ?? this";`;
  // Whatever the scanner decides about the damaged line, it must recover: the
  // alternative is a single runaway range that hides every later finding.
  const ranges = stringLikeRanges(source, "fixture.ts");
  assert.ok(ranges.every((range) => range.end <= source.length));
  assert.ok(ranges.some((range) => range.end - range.start < source.length / 2));
});

// ---------------------------------------------------------------------------
// Marker patterns.

const markersIn = (text) =>
  ENCODING_MARKER_PATTERNS.flatMap((pattern) => {
    pattern.regex.lastIndex = 0;
    return [...text.matchAll(pattern.regex)].map(() => pattern.name);
  });

test("a raw control character in a source file is a finding", () => {
  // The regression this rule was added for: lib/memoryExtractionLaunch.ts held
  // a literal NUL as a signature separator, which made git classify the whole
  // module as binary. Every change to it rendered as "Binary files ... differ"
  // -- no viewable diff in a pull request -- in the module that decides whether
  // a credit-spending extraction run is a repeat of one already paid for.
  // Assembled at runtime rather than written out: a literal NUL in this
  // file would make the test that guards against literal NULs the one file
  // nobody can review.
  const source = `const SEPARATOR = "${String.fromCharCode(0)}";`;
  assert.deepEqual(markersIn(source), ["control-character"]);
});

test("every C0 control except tab, LF and CR is caught, and DEL too", () => {
  for (let code = 0; code < 0x20; code += 1) {
    const expected = [0x09, 0x0a, 0x0d].includes(code) ? [] : ["control-character"];
    assert.deepEqual(
      markersIn(String.fromCharCode(code)),
      expected,
      `code point ${code}`
    );
  }
  assert.deepEqual(markersIn(String.fromCharCode(0x7f)), ["control-character"]);
});

test("the escaped form the fix uses is not itself a finding", () => {
  // The whole point of the rule is that it pushes the author to the escape.
  // A rule that then flagged the escape would have no fix at all.
  const source = 'const SEPARATOR = "\\u0000";';
  assert.deepEqual(markersIn(source), []);
});

test("ordinary source text produces no marker", () => {
  const source = [
    `const greeting = "안녕하세요";`,
    `const path = "a/b";`,
    "\tconst indented = 1;",
  ].join("\n");
  assert.deepEqual(markersIn(source), []);
});

test("the mojibake markers still fire", () => {
  assert.deepEqual(markersIn("\uFFFD"), ["replacement-character"]);
  assert.ok(markersIn("\u00EC\u00A0").includes("korean-mojibake-marker"));
});

test("no file under the scanned roots carries a control character", () => {
  // Run against the real tree: the rule exists to keep three files that had one
  // from getting it back, and to catch the fourth before it is committed.
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
  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const offenders = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extensions.has(extname(entry.name))) {
        if (markersIn(readFileSync(full, "utf8")).includes("control-character")) {
          offenders.push(relative(repoRoot, full));
        }
      }
    }
  };
  for (const root of roots) walk(join(repoRoot, root));
  assert.deepEqual(offenders, []);
});
