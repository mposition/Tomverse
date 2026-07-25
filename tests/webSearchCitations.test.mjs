import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeWebSearchCitations } from "../lib/webSearchCitations.ts";

test("http and https URLs pass through", () => {
  const result = sanitizeWebSearchCitations([
    { url: "https://example.com/a", title: "A" },
    { url: "http://example.org/b", title: "B" },
  ]);
  assert.deepEqual(
    result.map((citation) => citation.url).sort(),
    ["http://example.org/b", "https://example.com/a"]
  );
});

test("dangerous or malformed schemes are dropped", () => {
  const result = sanitizeWebSearchCitations([
    { url: "javascript:alert(1)" },
    { url: "data:text/html,<script>alert(1)</script>" },
    { url: "file:///etc/passwd" },
    { url: "not a url" },
    { url: "" },
    { url: undefined },
    { url: "https://safe.example.com/ok" },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, "https://safe.example.com/ok");
});

test("duplicate URLs are merged into a single entry", () => {
  const result = sanitizeWebSearchCitations([
    { url: "https://example.com/page", startIndex: 40, endIndex: 60 },
    { url: "https://example.com/page", title: "Page title", startIndex: 10, endIndex: 20 },
    { url: "https://example.com/page", startIndex: 90, endIndex: 100 },
  ]);
  assert.equal(result.length, 1);
  assert.equal(result[0].url, "https://example.com/page");
  assert.equal(result[0].title, "Page title");
  assert.equal(result[0].startIndex, 10);
  assert.equal(result[0].endIndex, 100);
});

test("an empty citation list stays empty", () => {
  assert.deepEqual(sanitizeWebSearchCitations([]), []);
});

test("sourceProvider is carried through for provider-qualified display", () => {
  const result = sanitizeWebSearchCitations([
    { url: "https://example.com/x", sourceProvider: "anthropic" },
  ]);
  assert.equal(result[0].sourceProvider, "anthropic");
});
