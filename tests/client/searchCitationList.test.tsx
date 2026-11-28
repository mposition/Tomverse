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

test("a saved-memory entry renders as a note with a link to the memory screen, not as a source", () => {
  const withSaved = [
    ...citations,
    { url: "https://tomverse.app/settings/memory", title: "Saved to memory", sourceProvider: "memory_saved" },
  ];
  const memorySaved = { note: "Saved to memory.", manage: "Manage memory" };
  const html = renderToStaticMarkup(createElement(SearchCitationList, { citations: withSaved, label: "Sources", memorySaved }));
  assert.match(html, /data-testid="memory-saved-note"/);
  assert.match(html, /href="\/settings\/memory"/);
  assert.equal((html.match(/data-testid="search-citation-item"/g) ?? []).length, 2, "the note is not counted as a source");
  const onlySaved = renderToStaticMarkup(createElement(SearchCitationList, { citations: withSaved.slice(2), label: "Sources", memorySaved }));
  assert.match(onlySaved, /data-testid="memory-saved-note"/);
  assert.doesNotMatch(onlySaved, /search-citation-list/);
});
