import assert from "node:assert/strict";
import test from "node:test";
import {
  hasExplicitSourceOrSearchIntent,
  suggestsRecentInformationNeeded,
} from "../lib/webSearchSuggestion.ts";

// The composer's mid-draft nudge is gone -- web search is a switch, so there
// is no "ask me first" state left for a nudge to turn on. What routing reads
// still separates stated source intent from the softer recency reading. The
// contextual v3 rules below do not restore a composer suggestion or change the
// model finder's separate recommendation vocabulary.

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

test("source ordering instructions are not requests for external sources", () => {
  for (const text of [
    "Keep the rows in source order.",
    "Preserve the original source sequence when returning the names.",
    "Use the order in the source, not alphabetical order.",
    "Return an array in the source's order.",
    'The supplied instruction says "preserve source-order".',
    'Explain this code: ```js\nconst label = "source order";\n```',
  ]) {
    assert.equal(hasExplicitSourceOrSearchIntent(text), false, text);
    assert.equal(suggestsRecentInformationNeeded(text), false, text);
  }
  for (const text of [
    "Preserve source order; also cite external sources.",
    "Keep source order and give me citations for the claim.",
    "Use the source sequence, but research whether the claim is correct.",
    "Return sources in credibility order.",
    'Explain "source order" and provide sources for your explanation.',
  ]) assert.equal(hasExplicitSourceOrSearchIntent(text), true, text);
});

test("current flags and reading a provided current record are local data cues", () => {
  for (const text of [
    "Supplied records: current yes; prior current no. Extract only the current record.",
    'Given data: {"current": true, "name": "A"}. Copy the current record.',
    "Use this provided register. Return the current version; use the owner recorded in the current record.",
    "Read the current row from the records below. Row A: current=false; row B: current=true.",
    "주어진 기록: 현재 여부: 예. 현재 버전만 선택하세요.",
    'Explain this code: ```js\nconst row = {current: true};\n```',
  ]) assert.equal(suggestsRecentInformationNeeded(text), false, text);
  for (const text of [
    "Return the current version of this application.",
    "Given records: current yes. Extract the current record and check the current law.",
    "Given records: current yes. Return the current version from the official website.",
    "Read the supplied records to extract their IDs. Separately, return the current version of Node.js.",
    "Use the supplied table for the arithmetic. Return the current version of this application.",
    "Use the provided records. For this application, return the current version.",
    "Use the supplied records. For Node.js, return the current version.",
    "주어진 기록을 읽으세요. 이 앱의 현재 버전을 반환하세요.",
    "Use the provided record. What is the current exchange rate?",
    "주어진 기록의 현재 버전만 선택하고 현재 법률을 검색해 주세요.",
  ]) assert.equal(suggestsRecentInformationNeeded(text), true, text);
});

test("a prohibition on today's date masks only the incidental date cue", () => {
  for (const text of [
    "Do not use today's date.",
    "Don't infer today’s date; compare only the supplied dates.",
    "Do not search, use attachments, execute code, or infer today's date.",
    "Never assume today's date when processing the supplied table.",
    "오늘 날짜를 쓰지 마세요.",
    "검색, 첨부파일, 코드 실행, 오늘 날짜나 실제 달력 지식은 사용하지 마세요.",
    'Translate this instruction: "Do not use today\'s date."',
  ]) assert.equal(suggestsRecentInformationNeeded(text), false, text);
  for (const text of [
    "Use today's date.",
    "What is today’s date?",
    "Do not forget to use today’s date.",
    "Do not wait and use today’s date.",
    "Do not use yesterday's date, use today's date.",
    "Do not use today's date, but tell me today's weather.",
    "Do not infer today's date. Find the latest statistics.",
    "오늘 날짜를 쓰지 마세요. 최신 통계를 검색해 주세요.",
    "오늘 날짜를 가정하지 말고 오늘 날씨를 알려 주세요.",
    "오늘 날짜를 확인하고 기록은 사용하지 마세요.",
    "오늘 서울 날씨 어때?",
    "What is the latest research on this treatment?",
  ]) assert.equal(suggestsRecentInformationNeeded(text), true, text);
});

test("incidental masking does not alter the original length or bare-year thresholds", () => {
  assert.equal(suggestsRecentInformationNeeded("오늘"), false);
  assert.equal(suggestsRecentInformationNeeded("2026"), true);
  const long = `2026 ${"source order ".repeat(20)}`;
  assert.ok(long.trim().length > 200);
  assert.equal(suggestsRecentInformationNeeded(long), false);
  // These other false positives remain outside the bounded v3 change.
  assert.equal(suggestsRecentInformationNeeded("Do not use today's date. Use cutoff 2026-06-03 from the supplied table."), true);
  assert.equal(hasExplicitSourceOrSearchIntent("Extract the source URL from the supplied record: source=https://example.invalid/a."), true);
});

test("negation lists have bounded item spans and counts, and long repeated input completes", () => {
  assert.equal(suggestsRecentInformationNeeded(`Do not ${"use notes, ".repeat(4)}or infer today's date.`), false);
  assert.equal(suggestsRecentInformationNeeded(`Do not ${"use notes, ".repeat(5)}or infer today's date.`), true);
  assert.equal(suggestsRecentInformationNeeded(`Do not use ${"x".repeat(81)}, or infer today's date.`), true);
  // No brittle millisecond budget: semantic boundary assertions above pin the
  // bounded path; this large no-comma input exercises its former rescan case.
  const repeated = "Do not use placeholders ".repeat(20_000);
  assert.equal(suggestsRecentInformationNeeded(repeated), false);
  assert.equal(suggestsRecentInformationNeeded(`${repeated}. Use today's date.`), true);
});
