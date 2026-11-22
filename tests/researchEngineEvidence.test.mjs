import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalResearchUrl, chunkEvidenceText, extractHtmlEvidence, locateQuote, normalizeEvidenceText,
  republicationFingerprint, unmatchedClaimNumbers, workbookRowsText,
} from "../lib/researchEngineEvidence.ts";

test("canonical URLs drop click trackers and fragments but keep content-selecting parameters", () => {
  assert.equal(canonicalResearchUrl("https://Example.com/a/?utm_source=x&id=7&page=2#top"), "https://example.com/a?id=7&page=2");
  assert.equal(canonicalResearchUrl("http://example.com/a"), null, "http is never read");
  assert.equal(canonicalResearchUrl("https://user:pass@example.com/"), null, "credentials in URLs are refused");
  assert.equal(canonicalResearchUrl("https://example.com:8443/"), null, "non-443 ports are refused");
});

test("PDF chunks carry their page locator and chunks cover the text exactly once", () => {
  const text = "[Page 1]\nFirst page text about tariffs.\n\n[Page 2]\nSecond page mentions 12.5% growth.";
  const chunks = chunkEvidenceText(text, "pdf_text");
  assert.deepEqual(chunks.map((chunk) => chunk.locator), [{ type: "page", page: 1 }, { type: "page", page: 2 }]);
  assert.equal(chunks[0].charStart, 0);
  assert.equal(chunks.at(-1).charEnd, text.length);
  for (let index = 1; index < chunks.length; index++) assert.equal(chunks[index].charStart, chunks[index - 1].charEnd);
});

test("long documents are split under the chunk limit; sheet rows keep sheet and row range", () => {
  const long = Array.from({ length: 3_000 }, (_, index) => `word${index}`).join(" ");
  const chunks = chunkEvidenceText(long, "plain_text");
  assert.ok(chunks.length > 3);
  assert.ok(chunks.every((chunk) => chunk.charEnd - chunk.charStart <= 4_000));
  const sheet = workbookRowsText([{ name: "Prices", rows: [["a", "1"], ["b", "2"]] }]);
  const rows = chunkEvidenceText(sheet, "sheet_rows");
  assert.equal(rows[0].locator.type, "rows");
  assert.equal(rows[0].locator.sheet, "Prices");
});

test("a quote is evidence only if it is present in the stored text (fabricated or paraphrased quotes fail)", () => {
  const text = "The ministry said on 3 March that the levy rises to 4.5% from July.\nOther text follows here.";
  const chunks = chunkEvidenceText(text, "plain_text");
  const match = locateQuote(text, chunks, "the levy rises to 4.5%   from July");
  assert.ok(match);
  assert.equal(normalizeEvidenceText(text.slice(match.start, match.end)), "the levy rises to 4.5% from july");
  assert.equal(locateQuote(text, chunks, "the levy falls to 3% from July"), null);
  assert.equal(locateQuote(text, chunks, "short"), null, "very short quotes cannot identify a span");
});

test("republished copies share a fingerprint; different reports on one topic do not", () => {
  const body = Array.from({ length: 80 }, (_, index) => `sentence ${index} of the wire story`).join(". ");
  assert.equal(republicationFingerprint(`  ${body}  `), republicationFingerprint(body.toUpperCase()));
  assert.notEqual(republicationFingerprint(body), republicationFingerprint(`An independent analysis. ${body}`));
  assert.equal(republicationFingerprint("too short"), null);
});

test("numbers in a claim that no quote contains are surfaced to the verifier", () => {
  assert.deepEqual(unmatchedClaimNumbers("Growth was 12% in 2025", ["growth reached 12% in 2025"]), []);
  assert.deepEqual(unmatchedClaimNumbers("Growth was 15% in 2025", ["growth reached 12% in 2025"]), ["15%"]);
});

test("HTML extraction keeps headings as sections, drops scripts and returns links as candidates only", () => {
  const html = `<html><head><title>T</title><meta property="article:published_time" content="2026-01-02T00:00:00Z"></head>
    <body><nav>menu</nav><h2>Rates</h2><p>The rate is 3%.</p><script>steal()</script><a href="/next?utm_source=x">Next page</a></body></html>`;
  const extracted = extractHtmlEvidence(html, "https://example.com/start");
  assert.ok(extracted.text.includes("## Rates"));
  assert.ok(!extracted.text.includes("steal"));
  assert.ok(!extracted.text.includes("menu"));
  assert.equal(extracted.publishedAt, "2026-01-02T00:00:00.000Z");
  assert.deepEqual(extracted.links, [{ url: "https://example.com/next", label: "Next page" }]);
  const chunks = chunkEvidenceText(extracted.text, "html_text");
  assert.ok(chunks.some((chunk) => chunk.locator.type === "section" && chunk.locator.heading === "Rates"));
});
