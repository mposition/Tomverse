import assert from "node:assert/strict";
import { test } from "node:test";
import {
  SCOUT_IMAGES_MAX,
  SCOUT_IMAGE_BASE64_MAX_CHARS,
  SUGGESTIONS_PER_SUBJECT_MAX,
  SUGGESTION_TITLE_MAX_CHARS,
  admitScoutSubmission,
  parseScoutAnswer,
  scoutPromptText,
  suggestionIdeaText,
} from "../lib/productResearchScoutCore.ts";

const png = { label: "desktop", mediaType: "image/png", base64: "iVBORw0KGgo=" };
const page = { kind: "page", subject: "pricing.en", language: "en", images: [png], signals: "console errors: 0" };

test("a page needs at least one image; the catalogue may be text only", () => {
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
    "[개선 제안] 모바일 가격표 잘림\n대상: pricing.en · 영역: mobile · 심각도: high\n근거: 320px에서 표 오른쪽이 잘림\n제안: 표를 세로 카드로 바꿈",
  );
});
