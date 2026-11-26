import assert from "node:assert/strict";
import test from "node:test";
import { chatMessage } from "../src/chat-contract";
import { sourceRows } from "../src/answer-sources";
import { citationsOutsideResearchBody } from "../../../lib/researchCitationDisplay";

const message = (searchMetadata: unknown) => chatMessage.parse({ id: "m1", role: "assistant", content: "Answer [1]", searchMetadata });

test("a saved answer keeps its web citations and drops unsafe schemes and duplicates", () => {
  const parsed = message({
    reasoningEffort: { requested: "high" },
    citations: [
      { url: "https://example.org/a", title: "First", referenceNumber: 1 },
      { url: "javascript:alert(1)", title: "Bad" },
      { url: "https://example.org/a", title: "Again", referenceNumber: 4 },
      { url: "http://plain.example.net/b" },
      "not an object", null,
    ],
  });
  assert.deepEqual(parsed.searchMetadata?.citations.map(({ url, referenceNumber }) => ({ url, referenceNumber })), [
    { url: "https://example.org/a", referenceNumber: 1 },
    { url: "http://plain.example.net/b", referenceNumber: undefined },
  ]);
  assert.equal(parsed.searchMetadata?.reasoningEffort?.requested, "high");
});

test("missing or malformed citations become an empty list instead of failing the conversation", () => {
  assert.deepEqual(message({}).searchMetadata?.citations, []);
  assert.deepEqual(message({ citations: "nope" }).searchMetadata?.citations, []);
  assert.equal(chatMessage.parse({ id: "m2", role: "user", content: "hi" }).searchMetadata, undefined);
});

test("a saved Research report keeps its body source URLs so the list under it shows only the rest", () => {
  const parsed = message({
    citations: [
      { url: "https://example.org/a", title: "In the report body", referenceNumber: 1 },
      { url: "https://drive.example.com/doc", title: "Connector doc" },
    ],
    research: { version: 1, mode: "preview", outcome: "complete", sources: [{ sourceId: "R1", referenceNumber: 1, url: "https://example.org/a" }] },
  });
  assert.deepEqual(parsed.searchMetadata?.research, { sources: [{ url: "https://example.org/a" }] });
  assert.deepEqual(citationsOutsideResearchBody(parsed.searchMetadata?.citations, parsed.searchMetadata?.research)
    .map(({ url }) => url), ["https://drive.example.com/doc"]);
  // Malformed Research metadata never hides a source: the answer keeps its full list.
  const malformed = message({ citations: [{ url: "https://example.org/a" }], research: { sources: "nope" } });
  assert.equal(malformed.searchMetadata?.research, undefined);
  assert.equal(citationsOutsideResearchBody(malformed.searchMetadata?.citations, malformed.searchMetadata?.research).length, 1);
});

test("source rows open only public https pages in the viewer and label the rest by host", () => {
  const rows = sourceRows([
    { url: "https://docs.example.org/page", title: "  Guide  ", referenceNumber: 2 },
    { url: "http://plain.example.net/b" },
    { url: "https://127.0.0.1/admin", title: "Local" },
  ]);
  assert.deepEqual(rows.map(({ title, host, openable, referenceNumber }) => ({ title, host, openable, referenceNumber })), [
    { title: "Guide", host: "docs.example.org", openable: true, referenceNumber: 2 },
    { title: "plain.example.net", host: "plain.example.net", openable: false, referenceNumber: undefined },
    { title: "Local", host: "127.0.0.1", openable: false, referenceNumber: undefined },
  ]);
});
