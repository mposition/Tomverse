import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { modelsPageContent } from "../components/marketing/v2/models/modelsPageContent.ts";

// Phone and Korean behaviour of the V2 models page (/models).
const source = readFileSync(
  new URL("../components/marketing/v2/models/ModelsPage.tsx", import.meta.url),
  "utf8",
);
const css = readFileSync(
  new URL("../components/marketing/v2/models/models-page.css", import.meta.url),
  "utf8",
);

test("Korean models page intro uses the same product names as the Korean menu", () => {
  const ko = modelsPageContent.ko;
  for (const text of [ko.hero.body, ko.cta.review, ko.credits.body]) {
    assert.doesNotMatch(text, /\bChat\b|\bReview\b/, text);
  }
  assert.match(ko.hero.body, /채팅과 답변 비교/);
  assert.match(ko.cta.review, /^답변 비교/);
});

test("collapsed phone filters still show the shown/total model count", () => {
  // The count and its single live region sit outside the collapsible filter body.
  const body = source.slice(source.indexOf('id="models-catalog-filters"'), source.indexOf('className="m-meta"'));
  assert.ok(body.length > 0, "filter body and result line are rendered");
  assert.doesNotMatch(body, /role="status"/);
  const start = source.indexOf('data-testid="models-count"');
  assert.ok(start > source.indexOf('className="m-meta"'), "the count is in the result line");
  const line = source.slice(start, source.indexOf("</p>", start));
  assert.match(line, /fill\(copy\.list\.count, \{ shown: shown\.length, total: rows\.length \}\)/);
  // Only phones collapse the filters; the toggle is hidden and the rows shown above 640px.
  const phone = css.slice(css.indexOf("@media (max-width: 640px)"), css.indexOf("@media (max-width: 420px)"));
  assert.match(phone, /\.m-toggle \{ display: flex; \}/);
  assert.match(phone, /\.m-filter-body\[data-open="false"\] \{ display: none; \}/);
  assert.match(css, /\.m-toggle \{ display: none;/);
});

test("long model names wrap instead of widening the phone layout", () => {
  assert.match(css, /\.m-card h3, \.tv-page \.m-band h3 \{[^}]*overflow-wrap: anywhere/);
  assert.match(css, /\.m-card \{[^}]*min-width: 0/);
  // Very narrow phones move the credit figure under the name.
  const narrow = css.slice(css.indexOf("@media (max-width: 420px)"));
  assert.match(narrow, /\.m-card, \.tv-page \.m-band \{ grid-template-columns: 44px minmax\(0, 1fr\); \}/);
  assert.match(narrow, /\.m-cr \{ grid-column: 1 \/ -1;/);
});

test("model cards show the user-facing name without the internal model id", () => {
  const start = source.indexOf("<article");
  assert.ok(start > 0, "model card is rendered");
  const card = source.slice(start, source.indexOf("</article>", start));
  assert.match(card, /\{row\.model\.name\}<\/h3>/);
  const visible = card.replace(/(key|data-model-id)=\{row\.model\.id\}/g, "");
  assert.doesNotMatch(visible, /\{row\.model\.id\}/);
});
