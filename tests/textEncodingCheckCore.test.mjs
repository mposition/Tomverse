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
