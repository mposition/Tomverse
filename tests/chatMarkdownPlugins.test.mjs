import assert from "node:assert/strict";
import test from "node:test";

import { unified } from "unified";
import remarkParse from "remark-parse";

import { CHAT_MARKDOWN_REMARK_PLUGINS } from "../lib/chatMarkdownPlugins.ts";

/**
 * How an assistant answer is parsed, executed.
 *
 * The parse rather than the option: `singleTilde: false` is a fact about a
 * configuration object, and what matters is what a Korean sentence turns into.
 */

const parse = (input) => {
  const processor = CHAT_MARKDOWN_REMARK_PLUGINS.reduce(
    (chain, plugin) =>
      Array.isArray(plugin) ? chain.use(plugin[0], plugin[1]) : chain.use(plugin),
    unified().use(remarkParse)
  );
  return processor.runSync(processor.parse(input));
};

const nodeTypes = (node, acc = []) => {
  acc.push(node.type);
  for (const child of node.children ?? []) nodeTypes(child, acc);
  return acc;
};

const textOf = (node) => {
  if (typeof node.value === "string") return node.value;
  return (node.children ?? []).map(textOf).join("");
};

/* --------------------------------------------------- the range separator */

test("a Korean time range keeps its tildes and is not struck through", () => {
  /*
    Staging, 2026-08-27. The reader was shown "오후 10시(09:30" with a line
    through it, because the two tildes in one sentence were consumed as a
    strikethrough.
  */
  const tree = parse(
    "교보문고 강남점 영업시간은 매일 오전 9시 30분~오후 10시(09:30~22:00)입니다."
  );
  assert.ok(!nodeTypes(tree).includes("delete"));
  assert.equal(
    textOf(tree),
    "교보문고 강남점 영업시간은 매일 오전 9시 30분~오후 10시(09:30~22:00)입니다."
  );
});

test("a temperature range survives too", () => {
  const tree = parse("밤에는 26~28°C 안팎으로 덥고 흐리겠습니다.");
  assert.ok(!nodeTypes(tree).includes("delete"));
  assert.ok(textOf(tree).includes("26~28°C"));
});

test("an odd number of tildes was never the problem, and still is not", () => {
  // One tilde alone had nothing to pair with, so it always survived. The pair
  // is what broke, which is exactly what makes this a Korean-text bug rather
  // than a rare one.
  const tree = parse("3~4일 정도 걸립니다.");
  assert.ok(!nodeTypes(tree).includes("delete"));
  assert.ok(textOf(tree).includes("3~4일"));
});

test("emphasis spanning a range is no longer torn apart by it", () => {
  const tree = parse("**오전 9시 30분~오후 10시** 운영합니다.");
  const types = nodeTypes(tree);
  assert.ok(types.includes("strong"));
  assert.ok(!types.includes("delete"));
  assert.ok(!textOf(tree).includes("*"));
});

/* ------------------------- the closing delimiter and the Korean particle */

test("bold closed by punctuation and followed by a particle is bold", () => {
  /*
    Staging, 2026-08-27. `(09:30)**입니다` is not right-flanking under
    CommonMark, so the run could not close and the reader was shown a literal
    `**`. Korean attaches the particle straight to the closing delimiter, so
    this is not an edge case in the language -- it is how the sentence is
    written.
  */
  const tree = parse("**오전 9시(09:30)**입니다.");
  assert.ok(nodeTypes(tree).includes("strong"));
  assert.ok(!textOf(tree).includes("*"));
  assert.equal(textOf(tree), "오전 9시(09:30)입니다.");
});

test("the staging sentence that started this parses whole", () => {
  const tree = parse(
    "**교보문고 강남점 영업시간은 매일 오전 9시 30분~오후 10시(09:30~22:00)**입니다."
  );
  const types = nodeTypes(tree);
  assert.ok(types.includes("strong"));
  // Both defects at once: the emphasis closes, and the tildes are not eaten.
  assert.ok(!types.includes("delete"));
  assert.equal(
    textOf(tree),
    "교보문고 강남점 영업시간은 매일 오전 9시 30분~오후 10시(09:30~22:00)입니다."
  );
});

test("strikethrough gets the same treatment, not half of it", () => {
  /*
    Taking the emphasis extension alone would leave `~~...~~입니다` broken in
    exactly the way `**` was. The GFM strikethrough extension is what covers
    it, and it is why there are two plugins rather than one.
  */
  const tree = parse("~~취소선(가격)~~입니다.");
  assert.ok(nodeTypes(tree).includes("delete"));
  assert.ok(!textOf(tree).includes("~"));
});

test("adding the strikethrough extension did not put single-tilde back", () => {
  /*
    It registers its own strikethrough construct with its own `singleTilde`,
    so it does not inherit the option given to remark-gfm. Added with no
    options, it struck "오후 10시(09:30" through again -- one fix undoing the
    other.
  */
  for (const input of [
    "오전 9시 30분~오후 10시(09:30~22:00)입니다.",
    "밤에는 26~28°C, 낮에는 30~32°C입니다.",
  ]) {
    const tree = parse(input);
    assert.ok(!nodeTypes(tree).includes("delete"), input);
    assert.equal(textOf(tree), input);
  }
});

/* ------------------------------------------------------ what is kept */

test("the two-tilde strikethrough still works", () => {
  // Nothing that meant strikethrough loses it; only the one-tilde shorthand
  // goes, and no user of this product has a reason to reach for it.
  const tree = parse("이건 ~~취소선~~ 입니다.");
  assert.ok(nodeTypes(tree).includes("delete"));
});

test("the rest of GitHub-flavoured markdown is untouched", () => {
  const table = parse("| a | b |\n| - | - |\n| 1 | 2 |");
  assert.ok(nodeTypes(table).includes("table"));
  const task = parse("- [x] done\n- [ ] not");
  assert.ok(nodeTypes(task).includes("listItem"));
  const strike = parse("~~gone~~");
  assert.ok(nodeTypes(strike).includes("delete"));
});

test("code, links and escapes still parse as themselves", () => {
  // The reason a regular expression over the raw text was not the fix: it
  // cannot see any of these, and would corrupt the ones it did not understand.
  const code = parse("`code(x)`입니다.");
  assert.ok(nodeTypes(code).includes("inlineCode"));
  assert.equal(textOf(code), "code(x)입니다.");

  const link = parse("[링크(주석)](https://example.com)입니다.");
  assert.ok(nodeTypes(link).includes("link"));

  const fenced = parse("```js\nconst a = `x~y`;\n```");
  assert.ok(nodeTypes(fenced).includes("code"));

  const escaped = parse("\\*\\*굵게가 아닙니다\\*\\*");
  assert.ok(!nodeTypes(escaped).includes("strong"));
});

test("ordinary emphasis is unaffected", () => {
  const tree = parse("**서울** 날씨");
  assert.ok(nodeTypes(tree).includes("strong"));
  assert.ok(!textOf(tree).includes("*"));
});
