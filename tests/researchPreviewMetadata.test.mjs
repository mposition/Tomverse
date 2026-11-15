import assert from "node:assert/strict";
import test from "node:test";
import {
  buildResearchPreviewMetadata, parseResearchPreviewMetadata,
  projectResearchSearchMetadata, researchPreviewExportFields,
} from "../lib/researchPreviewMetadata.ts";
import {
  buildChatStreamTrailerChunk, splitSearchMetadataTrailer, parseChatStreamTrailer,
} from "../lib/webSearchStreamTrailer.ts";

const metadata = () => buildResearchPreviewMetadata({
  outcome: "partial", startedAt: "2026-11-14T22:00:00Z", completedAt: "2026-11-14T22:01:00Z",
  stopReason: "report_submitted", citedSources: [{
    sourceId: "R25", url: "https://example.com/report", title: "Public report",
    snippet: "The cited excerpt.", retrievedAt: "2026-11-14T22:00:30Z",
  }],
});

test("versioned metadata preserves only bounded cited evidence across JSON reload", () => {
  const original = metadata();
  assert.deepEqual(parseResearchPreviewMetadata(JSON.parse(JSON.stringify(original))), original);
  assert.equal(original.sources[0].excerpt, "The cited excerpt.");
  assert.equal(original.sources[0].referenceNumber, 1);
  const injected = { ...original, secret: "private", sources: [{ ...original.sources[0], rawQuery: "private question" }] };
  assert.deepEqual(parseResearchPreviewMetadata(injected), original);
  assert.deepEqual(projectResearchSearchMetadata({ provider: "google", citations: [], research: injected }), { provider: "google", citations: [], research: original });
});

test("metadata rejects oversized excerpts, invalid versions, dangerous links and wrong numbering", () => {
  const base = metadata();
  for (const value of [
    { ...base, version: 3 },
    { ...base, sources: [{ ...base.sources[0], excerpt: "x".repeat(401) }] },
    { ...base, sources: [{ ...base.sources[0], url: "javascript:alert(1)" }] },
    { ...base, sources: [{ ...base.sources[0], referenceNumber: 9 }] },
  ]) assert.equal(parseResearchPreviewMetadata(value), null);
});

test("trailer and curated account export retain Research without internal costs or raw payload", () => {
  const research = metadata();
  const searchMetadata = { provider: "google", citations: [], costMetadata: { internalVendorMicroUsd: 25000 }, research: { ...research, providerPayload: "hidden" } };
  const raw = "Saved report [1](<https://example.com/report>)" + buildChatStreamTrailerChunk({ searchMetadata, completion: { status: "complete" } });
  const split = splitSearchMetadataTrailer(raw);
  assert.match(split.displayText, /\[1\]\(<https:\/\/example.com\/report>\)/);
  assert.deepEqual(parseChatStreamTrailer(split.searchMetadataJson).searchMetadata.research, research);
  const exported = researchPreviewExportFields(searchMetadata);
  assert.deepEqual(exported, { research });
  assert.doesNotMatch(JSON.stringify(exported), /internalVendorMicroUsd|providerPayload|rawQuery/);
  assert.deepEqual(researchPreviewExportFields({ provider: "perplexity", citations: [] }), {});
});

test("failure and cancellation cannot be projected as a completed report", () => {
  for (const [outcome, stopReason] of [["failed", "usage_unknown"], ["cancelled", "aborted"]]) {
    const result = buildResearchPreviewMetadata({ outcome, stopReason,
      startedAt: "2026-11-14T22:00:00Z", completedAt: "2026-11-14T22:01:00Z" });
    assert.equal(result.outcome, outcome);
    assert.equal(result.sources, undefined);
  }
});
