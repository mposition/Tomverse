import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LanguageProvider } from "@/components/LanguageProvider";
import { AnswerMarkdownBody } from "@/components/chat/ChatMessageList";

const SAMPLE = [
  "Intro paragraph with [a link](https://example.com).",
  "",
  "- first item",
  "- second item",
  "",
  "> a quoted line",
  "",
  "| a | b |",
  "| - | - |",
  "| 1 | 2 |",
  "",
  "Inline `code` and a formula $$x^2$$ here.",
  "",
  "```ts",
  "const answer = 42;",
  "```",
  "",
  "![tracking](https://example.com/pixel.png)",
].join("\n");

const render = (content: string) =>
  renderToStaticMarkup(
    <LanguageProvider initialLang="en">
      <AnswerMarkdownBody content={content} />
    </LanguageProvider>
  );

test("answer markdown still renders text, links, lists, quotes, tables, code, math and blocked images", () => {
  const html = render(SAMPLE);
  assert.match(html, /<p class="mb-3 last:mb-0">Intro paragraph/);
  assert.match(html, /<a href="https:\/\/example\.com" target="_blank" rel="noreferrer"/);
  assert.match(html, /<ul class="mb-3 list-disc pl-5 last:mb-0">\s*<li class="mb-1">first item<\/li>/);
  assert.match(html, /<blockquote class="mb-3 border-l-2/);
  assert.match(html, /<div class="mb-3 max-w-full overflow-x-auto[^"]*" tabindex="0" role="region" aria-label="[^"]+"><table/);
  assert.match(html, /<th class="border border-zinc-300 bg-zinc-100/);
  assert.match(html, /<td class="border border-zinc-300 px-2 py-1 align-top/);
  assert.match(html, /<code[^>]* class="rounded bg-zinc-200[^"]*">code<\/code>/);
  assert.match(html, /katex/);
  assert.match(html, /answer/);
  assert.doesNotMatch(html, /<img/);
  assert.match(html, /role="note"/);
});

test("the markdown component map and plugin lists are the same objects on every render", () => {
  // The memo wrapper's inner function is the render the list runs per answer.
  const inner = (AnswerMarkdownBody as unknown as {
    type: (props: { content: string }) => { props: Record<string, unknown> };
  }).type;
  const first = inner({ content: "one" }).props;
  const second = inner({ content: "two, longer" }).props;
  assert.equal(first.components, second.components);
  assert.equal(first.rehypePlugins, second.rehypePlugins);
  assert.equal(first.remarkPlugins, second.remarkPlugins);
  // Same type for every entry means React updates a list item in place
  // instead of remounting it, together with any code block nested inside.
  const components = first.components as Record<string, unknown>;
  for (const name of ["p", "li", "table", "blockquote", "pre", "code", "img"]) {
    assert.equal(typeof components[name], "function", name);
  }
});

test("an answer's markdown is memoised and never re-inlines its component map", () => {
  assert.equal(
    (AnswerMarkdownBody as unknown as { $$typeof: symbol }).$$typeof,
    Symbol.for("react.memo")
  );
  const source = readFileSync("components/chat/ChatMessageList.tsx", "utf8");
  assert.doesNotMatch(
    source,
    /<AnswerMarkdown[^>]*\bcomponents=\{\{/,
    "an inline components map gives every entry a new type on each render"
  );
});
