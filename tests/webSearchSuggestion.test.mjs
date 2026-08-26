import assert from "node:assert/strict";
import test from "node:test";
import {
  hasExplicitSourceOrSearchIntent,
  suggestsRecentInformationNeeded,
} from "../lib/webSearchSuggestion.ts";

// The composer's mid-draft nudge is gone -- web search is a switch, so there
// is no "ask me first" state left for a nudge to turn on. What routing reads
// is unchanged, and that is what the rest of this file pins: the two halves of
// the split behave exactly as they did before the composer stopped calling
// either of them.

test("the retired composer helpers are no longer exported", async () => {
  const exported = await import("../lib/webSearchSuggestion.ts");
  assert.equal("suggestsWebSearchInComposer" in exported, false);
  assert.equal("draftSuggestionKey" in exported, false);
});

// Stated intent, for routing and capability. This is the half that must not
// carry the composer's floor: `needsCurrentInformation` drives the Router's
// web-search hard filter, so a two-character request for sources reading as
// "no request" left a model with no search path eligible for a turn that had
// asked for sources.

test("explicit source intent is recognised at any length", () => {
  assert.equal(hasExplicitSourceOrSearchIntent("출처"), true);
  assert.equal(hasExplicitSourceOrSearchIntent("근거"), true);
  assert.equal(hasExplicitSourceOrSearchIntent("웹검색"), true);
  assert.equal(hasExplicitSourceOrSearchIntent("  출처  "), true);
  assert.equal(
    hasExplicitSourceOrSearchIntent("Can you give me sources for this claim?"),
    true
  );
});

test("explicit source intent is intent, not a guess from wording", () => {
  // Recency wording is not a request for sources. It is the other signal, and
  // conflating them is what produced one function doing two jobs.
  assert.equal(hasExplicitSourceOrSearchIntent("오늘 환율이 어떻게 돼?"), false);
  assert.equal(hasExplicitSourceOrSearchIntent("Explain how photosynthesis works."), false);
  assert.equal(hasExplicitSourceOrSearchIntent(""), false);
});

test("the recency reading keeps its floor wherever it is used", () => {
  // A bare "오늘" is ambiguous in a way "출처" is not: it is a guess about what
  // the turn needs rather than something the person asked for. Widening it is
  // a separate decision, with its own evidence.
  assert.equal(suggestsRecentInformationNeeded("오늘 서울 날씨"), true);
  assert.equal(suggestsRecentInformationNeeded("오늘"), false);
  assert.equal(suggestsRecentInformationNeeded("출처"), false);
});
