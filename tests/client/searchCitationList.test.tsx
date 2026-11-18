import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SearchCitationList } from "@/components/chat/SearchCitationList";

const citations = [
  { url: "https://example.org/a", title: "First source", referenceNumber: 1 },
  { url: "https://example.org/b" },
];

test("source links render at a readable size with spacing between rows", () => {
  const html = renderToStaticMarkup(createElement(SearchCitationList, { citations, label: "Sources" }));
  assert.equal((html.match(/data-testid="search-citation-item"/g) ?? []).length, 2);
  assert.match(html, /<ul class="space-y-2">/);
  assert.match(html, /<a [^>]*class="[^"]*\btext-sm\b[^"]*\bleading-6\b/);
  assert.doesNotMatch(html, /text-\[11px\]/);
  assert.match(html, />First source</);
  assert.match(html, />https:\/\/example\.org\/b</);
  assert.match(html, /data-reference-number="1"/);
});

test("no citations renders nothing", () => {
  assert.equal(renderToStaticMarkup(createElement(SearchCitationList, { citations: [], label: "Sources" })), "");
});
