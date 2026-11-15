import assert from "node:assert/strict";
import { test } from "node:test";
import { infoPages } from "../components/marketing/marketingInfoContent.ts";
import { withLegalSectionNav } from "../lib/legalSectionNav.ts";

test("terms get a collapsible jump list with a unique anchor for every section", () => {
  const before = JSON.stringify(infoPages.terms);
  const terms = withLegalSectionNav(infoPages.terms);
  for (const [lang, copy] of Object.entries(terms)) {
    assert.ok(copy.sectionNavLabel, `${lang} has a nav label`);
    assert.equal(copy.sectionNavCollapsible, true);
    const ids = copy.sections.map((section) => section.id);
    assert.equal(ids.length, infoPages.terms[lang].sections.length);
    assert.ok(ids.every(Boolean), `${lang} sections all have anchors`);
    assert.equal(new Set(ids).size, ids.length, `${lang} anchors are unique`);
  }
  // The published copy (and so its recorded digest) stays unchanged.
  assert.equal(JSON.stringify(infoPages.terms), before);
});
