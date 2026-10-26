import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminAiReviewPreparationPanel } from "@/components/admin/AdminAiReviewPreparationPanel";
import { readAiReviewPreparationCatalog } from "@/lib/aiReviewPreparationServer";
import { AdminAiReviewThresholdDraft } from "@/components/admin/AdminAiReviewThresholdDraft";
import { AdminAiReviewM5Progress } from "@/components/admin/AdminAiReviewM5Progress";
import { aiReviewM5Progress } from "@/lib/aiReviewM5Progress";
import { datasetDigest } from "@/lib/aiReviewEvalRun";

test("preparation UI exposes real candidates and draft-only controls", () => {
  const html = renderToStaticMarkup(
    <AdminAiReviewPreparationPanel
      catalog={readAiReviewPreparationCatalog()}
      locale="ko"
    />,
  );
  assert.match(html, /평가 준비/);
  assert.match(html, /편집 초안 내려받기/);
  assert.match(html, /표본 구성 초안 내려받기/);
  assert.match(html, /채택·동결 서명을 복사하지 않습니다/);
  assert.doesNotMatch(html, />채택 승인<|>유료 실행</);
});

test("operational progress reports actual missing records without declaring M5", () => {
  const progress = aiReviewM5Progress(readAiReviewPreparationCatalog(), {
    state: "unconfigured",
    reports: [],
    problems: [],
  });
  assert.equal(progress.candidates, 9);
  assert.equal(progress.adopted, 0);
  assert.equal(progress.frozenAdequateSets, 0);
  assert.equal(progress.signedJudgedThresholds, 0);
  assert.equal(progress.verifiedRuns, 0);
  const html = renderToStaticMarkup(
    <AdminAiReviewM5Progress progress={progress} locale="ko" />,
  );
  assert.match(html, /승급 판정이 아닙니다/);
  assert.match(html, /미설정/);
  assert.match(html, /미기록/);
  const preparation = readAiReviewPreparationCatalog();
  const set = preparation.sets[0];
  set.dataset.frozenAt = "2026-10-01T00:00:00Z";
  set.dataset.frozenBy = "TEST";
  set.dataset.frozenDigest = datasetDigest(set.dataset);
  set.shortfalls = [];
  assert.equal(
    aiReviewM5Progress(preparation, {
      state: "available",
      reports: [],
      problems: [],
    }).frozenAdequateSets,
    0,
    "a freeze label does not adopt candidate cases",
  );
});

test("threshold preparation leaves every new bound empty and cannot approve", () => {
  const html = renderToStaticMarkup(
    <AdminAiReviewThresholdDraft locale="ko" />,
  );
  assert.match(html, /미승인 기준 초안 내려받기/);
  assert.match(html, /disabled/);
  assert.match(html, /관측 점수를 보고 기준을 조정하지 마세요/);
  assert.doesNotMatch(html, /50\.0%|33\.3%/);
});
