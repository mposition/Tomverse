import assert from "node:assert/strict";
import test from "node:test";

import { createElement, type ComponentPropsWithoutRef } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown, { type ExtraProps } from "react-markdown";
import rehypeHighlight from "rehype-highlight";

import {
  codeExecutionFenceKind,
  codeExecutionMarkdown,
} from "@/lib/chatCodeExecutionCore";

// docs/policy/chat-attachment-formats.md 2.3.1. The answer's `pre` component
// folds a run by the info-string words the server writes. Whether those words
// reach the component at all is a fact about react-markdown and
// rehype-highlight, not about this module, so it is checked through them, the
// same plugins the answer renders with.

test("the fence's words reach the answer's pre component through react-markdown", () => {
  const seen: Array<string | null> = [];
  const Pre = ({ children, node }: ComponentPropsWithoutRef<"pre"> & ExtraProps) => {
    seen.push(codeExecutionFenceKind(node));
    return createElement("pre", null, children);
  };
  const markdown =
    "The total is below.\n" +
    codeExecutionMarkdown(
      { language: "PYTHON", code: "print(sum([3, 4, 5]))" },
      { outcome: "OUTCOME_OK", output: "12\n" }
    ) +
    "```python\nprint('an ordinary block')\n```\n";
  const html = renderToStaticMarkup(
    createElement(ReactMarkdown, { rehypePlugins: [rehypeHighlight], components: { pre: Pre } }, markdown)
  );
  assert.deepEqual(seen, ["code", "output", null]);
  // The words are not printed: only the language becomes a class.
  assert.equal(html.includes("tomverse-code"), false);
  assert.ok(html.includes("language-python"));
});
