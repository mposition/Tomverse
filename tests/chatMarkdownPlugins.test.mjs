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

test("ordinary emphasis is unaffected", () => {
  const tree = parse("**서울** 날씨");
  assert.ok(nodeTypes(tree).includes("strong"));
  assert.ok(!textOf(tree).includes("*"));
});
