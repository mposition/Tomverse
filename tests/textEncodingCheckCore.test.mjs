import assert from "node:assert/strict";
import test from "node:test";
import {
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
