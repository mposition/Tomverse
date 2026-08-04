import assert from "node:assert/strict";
import test from "node:test";
import { findQuestionRunsInsideStrings } from "../scripts/text-encoding-check-core.mjs";

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

test("JSX text is still read, not just string literals", () => {
  // The reason this check needs a parser and not a scanner: JSX text is bare
  // source with no delimiters, so only the grammar says where it starts.
  const source = `
    export const Panel = () => (
      <div title="ok">
        Broken ?? copy
      </div>
    );
  `;
  const matches = findQuestionRunsInsideStrings(source, "fixture.tsx");
  assert.deepEqual(matches.map((match) => match.sample), ["??"]);
});

test("a .ts type assertion is not mistaken for JSX", () => {
  // `<Foo>value` is a type assertion in .ts and an unterminated element in
  // .tsx, so the two cannot be parsed with the same plugins. Getting this
  // wrong fails the parse, and a file that fails to parse is reported clean --
  // which would have made this check silently blind to the file.
  const source = `
    const parsed = <Record<string, string>>JSON.parse(raw);
    const label = "Broken ?? label";
  `;
  const matches = findQuestionRunsInsideStrings(source, "fixture.ts");
  assert.deepEqual(matches.map((match) => match.sample), ["??"]);
});

test("JSON string values are read as strings, not as a block statement", () => {
  const source = '{\n  "title": "Broken ?? title",\n  "ok": "value ?? fine"\n}';
  const matches = findQuestionRunsInsideStrings(source, "fixture.json");
  assert.deepEqual(matches.map((match) => match.sample), ["??", "??"]);
});
