import assert from "node:assert/strict";
import test from "node:test";
import {
  splitInlineCode,
  splitUserMessageSegments,
} from "../lib/userMessageSegments.ts";

const RUST_QUESTION = [
  "아래 Rust 코드가 컴파일되지 않습니다. 오류 원인을 설명하고, 동작을 유지하면서 고치는 방법 두 가지를 주세요.",
  "",
  "fn longest(words: &Vec<String>) -> &str {",
  "    let mut best = String::new();",
  "    for w in words {",
  "        if w.len() > best.len() { best = w.clone(); }",
  "    }",
  "    &best",
  "}",
].join("\n");

test("a pasted unfenced function under a prose line is shown as code", () => {
  const segments = splitUserMessageSegments(RUST_QUESTION);
  assert.equal(segments.length, 2);
  assert.equal(segments[0].kind, "text");
  assert.match(segments[0].text, /^아래 Rust 코드가/);
  assert.equal(segments[0].text.endsWith("\n"), false);
  assert.equal(segments[1].kind, "code");
  assert.equal(segments[1].fenced, false);
  assert.equal(segments[1].language, null);
  assert.match(segments[1].code, /^fn longest/);
  assert.match(segments[1].code, /    let mut best = String::new\(\);/);
});

test("a fence keeps its language and its exact content", () => {
  const segments = splitUserMessageSegments(
    "고쳐 주세요\n```rust\nfn main() {}\n\n// x\n```\n감사합니다"
  );
  assert.deepEqual(segments, [
    { kind: "text", text: "고쳐 주세요" },
    { kind: "code", code: "fn main() {}\n\n// x", language: "rust", fenced: true },
    { kind: "text", text: "감사합니다" },
  ]);
});

test("an unclosed fence runs to the end of the message", () => {
  const segments = splitUserMessageSegments("```\nconst a = 1;\nconst b = 2;");
  assert.deepEqual(segments, [
    { kind: "code", code: "const a = 1;\nconst b = 2;", language: null, fenced: true },
  ]);
});

test("blank lines inside unfenced code do not split it into two blocks", () => {
  const code = [
    "function a() {",
    "  return 1;",
    "  // one",
    "}",
    "",
    "function b() {",
    "  return 2;",
    "  // two",
    "}",
  ].join("\n");
  const segments = splitUserMessageSegments(code);
  assert.equal(segments.length, 1);
  assert.equal(segments[0].kind, "code");
  assert.equal(segments[0].code, code);
});

test("ordinary prose stays one text segment with its line breaks", () => {
  const prose = "첫 줄입니다.\n둘째 줄입니다.\n\n새 문단입니다.";
  assert.deepEqual(splitUserMessageSegments(prose), [{ kind: "text", text: prose }]);
});

test("inline code spans are split out; a lone backtick stays text", () => {
  assert.deepEqual(splitInlineCode("변수 `best`가 `String`입니다 ` 끝"), [
    { kind: "text", text: "변수 " },
    { kind: "code", text: "best" },
    { kind: "text", text: "가 " },
    { kind: "code", text: "String" },
    { kind: "text", text: "입니다 ` 끝" },
  ]);
});
