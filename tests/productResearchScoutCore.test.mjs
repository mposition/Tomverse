import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SCOUT_IMAGES_MAX,
  SCOUT_IMAGE_BASE64_MAX_CHARS,
  SUGGESTIONS_PER_SUBJECT_MAX,
  SUGGESTION_TITLE_MAX_CHARS,
  SCOUT_RUN_GAP_MS,
  admitScoutSubmission,
  latestScoutRun,
  nextScoutRunAt,
  scoutDays,
  parseScoutAnswer,
  scoutPromptText,
  scoutSendOutcome,
  suggestionSendRequestId,
  suggestionIdeaText,
} from "../lib/productResearchScoutCore.ts";

const png = { label: "desktop", mediaType: "image/png", base64: "iVBORw0KGgo=" };
const page = { kind: "page", subject: "pricing.en", language: "en", images: [png], signals: "console errors: 0" };

test("a page needs at least one image; a file or the catalogue may be text only", () => {
  assert.equal(admitScoutSubmission({ kind: "file", subject: "docx.document", signals: "Text the file contains: 제목" }).ok, true);
  assert.equal(admitScoutSubmission(page).ok, true);
  assert.deepEqual(admitScoutSubmission({ ...page, images: [] }), { ok: false, code: "images" });
  const catalogue = admitScoutSubmission({ kind: "catalogue", subject: "catalogue", signals: "CAT-01 claude-sonnet-5-5 on Brave" });
  assert.equal(catalogue.ok, true);
  assert.deepEqual(admitScoutSubmission({ kind: "catalogue", subject: "catalogue", signals: " " }), { ok: false, code: "empty" });
});

test("the body is bounded and refused with a code, never echoed", () => {
  const cases = [
    [null, "not_an_object"],
    [[], "not_an_object"],
    [{ ...page, kind: "admin" }, "kind"],
    [{ ...page, subject: "../etc" }, "subject"],
    [{ ...page, subject: "A".repeat(65) }, "subject"],
    [{ ...page, language: "eng" }, "language"],
    [{ ...page, images: Array.from({ length: SCOUT_IMAGES_MAX + 1 }, () => png) }, "images"],
    [{ ...page, images: [{ ...png, mediaType: "image/svg+xml" }] }, "image_media_type"],
    [{ ...page, images: [{ ...png, base64: "not base64!" }] }, "image_data"],
    [{ ...page, images: [{ ...png, base64: "A".repeat(SCOUT_IMAGE_BASE64_MAX_CHARS + 4) }] }, "image_data"],
    [{ ...page, images: [{ ...png, label: "" }] }, "image_label"],
    [{ ...page, signals: "x".repeat(4_001) }, "signals"],
  ];
  for (const [body, code] of cases) {
    const admission = admitScoutSubmission(body);
    assert.equal(admission.ok, false, JSON.stringify(body)?.slice(0, 60));
    assert.equal(admission.code, code);
  }
});

test("the prompt carries the subject, the signals and earlier titles as tagged data", () => {
  const admission = admitScoutSubmission(page);
  const text = scoutPromptText(admission.submission, ["가격표가 320px에서 잘림"]);
  assert.match(text, /Subject: page pricing\.en \(language en\)/);
  assert.match(text, /<signals>\nconsole errors: 0\n<\/signals>/);
  assert.match(text, /<existing>\n- 가격표가 320px에서 잘림\n<\/existing>/);
  assert.match(scoutPromptText(admission.submission, []), /<existing>\nnone\n<\/existing>/);
});

const answer = (suggestions) => ({ suggestions });
const good = { title: "모바일 가격표 잘림", area: "mobile", severity: "high", evidence: "320px에서 표 오른쪽이 잘림", suggestion: "표를 세로 카드로 바꿈" };

test("only well-formed suggestions with known area and severity are kept, at most five", () => {
  assert.deepEqual(parseScoutAnswer(answer([good]), []), [good]);
  assert.deepEqual(parseScoutAnswer(answer([{ ...good, area: "security" }]), []), []);
  assert.deepEqual(parseScoutAnswer(answer([{ ...good, severity: "critical" }]), []), []);
  assert.deepEqual(parseScoutAnswer(answer([{ ...good, evidence: "  " }]), []), []);
  assert.deepEqual(parseScoutAnswer(null, []), []);
  assert.deepEqual(parseScoutAnswer({ suggestions: "x" }, []), []);
  const many = Array.from({ length: 9 }, (_, index) => ({ ...good, title: `제안 ${index}` }));
  assert.equal(parseScoutAnswer(answer(many), []).length, SUGGESTIONS_PER_SUBJECT_MAX);
  const long = parseScoutAnswer(answer([{ ...good, title: "가".repeat(400) }]), [])[0];
  assert.equal(long.title.length, SUGGESTION_TITLE_MAX_CHARS);
});

test("a suggestion already made for the subject, or repeated in the answer, is dropped", () => {
  assert.deepEqual(parseScoutAnswer(answer([good]), ["모바일  가격표 잘림"]), []);
  assert.deepEqual(parseScoutAnswer(answer([good, { ...good, evidence: "다른 근거" }]), []), [good]);
});

test("the AMUX idea text names the subject, the evidence and the change", () => {
  const text = suggestionIdeaText({ subject: "pricing.en", ...good });
  assert.equal(
    text,
    "[Scout 제안] 모바일 가격표 잘림\n대상: pricing.en · 영역: mobile · 심각도: high\n근거: 320px에서 표 오른쪽이 잘림\n제안: 표를 세로 카드로 바꿈",
  );
});

test("the next run is today's 18:00 UTC until it passes, then tomorrow's", () => {
  assert.equal(nextScoutRunAt(new Date("2026-10-19T11:44:00Z")).toISOString(), "2026-10-19T18:00:00.000Z");
  assert.equal(nextScoutRunAt(new Date("2026-10-19T18:00:00Z")).toISOString(), "2026-10-20T18:00:00.000Z");
  assert.equal(nextScoutRunAt(new Date("2026-10-19T23:59:00Z")).toISOString(), "2026-10-20T18:00:00.000Z");
});

const call = (iso, outcome = "ok", kept = 1, inputTokens = 100, outputTokens = 10) => ({
  createdAt: new Date(iso),
  outcome,
  inputTokens,
  outputTokens,
  kept,
});

test("the newest run is the newest call and every call within the gap before it", () => {
  assert.equal(latestScoutRun([]), null);
  const rows = [
    call("2026-10-19T08:56:20Z"),
    call("2026-10-19T08:56:30Z", "ok", 2),
    // More than SCOUT_RUN_GAP_MS later: a second run.
    call("2026-10-19T11:44:44Z", "ok", 3),
    call("2026-10-19T11:45:01Z", "failed", null, null, null),
    call("2026-10-19T11:50:50Z", "started", null, null, null),
  ];
  assert.ok(Date.parse("2026-10-19T11:44:44Z") - Date.parse("2026-10-19T08:56:30Z") > SCOUT_RUN_GAP_MS);
  assert.deepEqual(latestScoutRun(rows), {
    startedAt: "2026-10-19T11:44:44.000Z",
    endedAt: "2026-10-19T11:50:50.000Z",
    calls: 3,
    failed: 1,
    unsettled: 1,
    kept: 3,
  });
});

test("the day table has one row per UTC day, newest first, days without calls included", () => {
  const now = new Date("2026-10-19T11:50:00Z");
  const days = scoutDays(
    [
      call("2026-10-19T11:44:44Z", "ok", 3, 1000, 100),
      call("2026-10-19T08:56:20Z", "failed", null, 500, null),
      call("2026-10-17T18:01:00Z", "ok", 2, 10, 1),
      // Older than the window: left out.
      call("2026-10-12T18:01:00Z", "ok", 9, 9, 9),
    ],
    now,
    7,
  );
  assert.deepEqual(
    days.map((day) => day.day),
    ["2026-10-19", "2026-10-18", "2026-10-17", "2026-10-16", "2026-10-15", "2026-10-14", "2026-10-13"],
  );
  assert.deepEqual(days[0], { day: "2026-10-19", calls: 2, failed: 1, kept: 3, inputTokens: 1500, outputTokens: 100 });
  assert.deepEqual(days[1], { day: "2026-10-18", calls: 0, failed: 0, kept: 0, inputTokens: 0, outputTokens: 0 });
  assert.equal(days[2].calls, 1);
  assert.equal(days.reduce((sum, day) => sum + day.calls, 0), 3);
});

test("the walker counts a day's cap as capped, not as a failure", () => {
  assert.equal(scoutSendOutcome({ judged: true, stored: 3 }), "judged");
  assert.equal(scoutSendOutcome({ judged: true, stored: 0 }), "judged");
  assert.equal(scoutSendOutcome({ judged: false, reason: "model_off" }), "modelOff");
  assert.equal(scoutSendOutcome({ judged: false, reason: "daily_cap_reached" }), "capped");
  assert.equal(scoutSendOutcome({ refused: "images" }), "refused");
  assert.equal(scoutSendOutcome({ judged: false, reason: "model_failed" }), "failed");
  assert.equal(scoutSendOutcome({}), "failed");
  assert.equal(scoutSendOutcome(null), "failed");
});

test("every send of one suggestion is the same AMUX request, and different suggestions differ", async () => {
  const { isAmuxIdeaRequestId } = await import("../lib/amux/ideaRequestIdCore.ts");
  const id = suggestionSendRequestId("cmgx0suggestion1");
  assert.equal(suggestionSendRequestId("cmgx0suggestion1"), id);
  assert.notEqual(suggestionSendRequestId("cmgx0suggestion2"), id);
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(isAmuxIdeaRequestId(id), true);
});
