"use client";

import { useState } from "react";
import type { AdminLocale } from "@/lib/adminLocale";
import {
  AI_REVIEW_JUDGED_CEILINGS,
  AI_REVIEW_JUDGED_FLOORS,
  emptyJudgedThresholdDraft,
  judgedThresholdProblems,
} from "@/lib/aiReviewJudgedThresholds";
import { downloadAiReviewDraft } from "./AdminAiReviewPreparationPanel";

const field =
  "min-h-10 w-full rounded-lg border border-zinc-700 bg-zinc-950 p-2 text-sm text-zinc-100 focus-visible:outline-2 focus-visible:outline-blue-400";
export function AdminAiReviewThresholdDraft({
  locale,
}: {
  locale: AdminLocale;
}) {
  const ko = locale === "ko";
  const [draft, setDraft] = useState(emptyJudgedThresholdDraft);
  const [downloaded, setDownloaded] = useState(false);
  const problems = judgedThresholdProblems(draft, false);
  const number = (value: string) => (value === "" ? null : Number(value));
  const labels: Record<string, string> = ko
    ? {
        contradictionRecall: "모순 재현율 하한",
        contradictionPrecision: "모순 정밀도 하한",
        omissionRecall: "누락 재현율 하한",
        omissionPrecision: "누락 정밀도 하한",
        exactQuoteMatchRate: "원문 인용 일치율 하한",
        schemaValidRate: "출력 형식 준수율 하한",
        missedEveryPlantedIssueRate: "심은 문제 전무보고율 상한",
        inventedFindingRate: "지어낸 발견 비율 상한",
        maxLanguageArmGap: "언어 간 최대 격차",
        maxTaskTypeArmShortfall: "작업 유형별 허용 차이",
        minBlindReviewedCases: "블라인드 검토 최소 사례 수",
      }
    : {};
  return (
    <details
      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5"
      data-testid="ai-review-threshold-draft"
    >
      <summary className="cursor-pointer font-semibold text-zinc-100">
        {ko
          ? "평가 준비 · 품질 기준 초안"
          : "Evaluation preparation · threshold draft"}
      </summary>
      <p className="my-4 text-sm text-zinc-400">
        {ko
          ? "관측 점수를 보고 기준을 조정하지 마세요. 이 양식은 미승인 초안을 내려받으며, 게이트나 서명을 변경하지 않습니다. 비율은 0~1로 입력합니다."
          : "Choose criteria before inspecting observed scores. Download an unsigned draft; this does not change gates or signatures. Enter rates from 0 to 1."}
      </p>
      <label className="block text-sm text-zinc-200">
        {ko ? "임계값 버전" : "Threshold version"}
        <input
          className={`${field} mt-2`}
          value={draft.version}
          onChange={(event) =>
            setDraft({ ...draft, version: event.target.value })
          }
        />
      </label>
      <div className="my-5 grid gap-4 sm:grid-cols-2">
        {(["minWilsonLower", "maxWilsonUpper"] as const).map((group) =>
          (group === "minWilsonLower"
            ? AI_REVIEW_JUDGED_FLOORS
            : AI_REVIEW_JUDGED_CEILINGS
          ).map((key) => (
            <label key={key} className="min-w-0 text-sm text-zinc-200">
              {labels[key] ?? key}
              <input
                className={`${field} mt-2`}
                type="number"
                min="0"
                max="1"
                step="0.01"
                value={
                  (draft[group] as Record<string, number | null>)[key] ?? ""
                }
                onChange={(event) => {
                  setDraft({
                    ...draft,
                    [group]: {
                      ...draft[group],
                      [key]: number(event.target.value),
                    },
                  });
                  setDownloaded(false);
                }}
              />
            </label>
          )),
        )}
        {(
          [
            "maxLanguageArmGap",
            "maxTaskTypeArmShortfall",
            "minBlindReviewedCases",
          ] as const
        ).map((key) => (
          <label key={key} className="text-sm text-zinc-200">
            {labels[key] ?? key}
            <input
              className={`${field} mt-2`}
              type="number"
              min={key === "minBlindReviewedCases" ? 1 : 0}
              max={key === "minBlindReviewedCases" ? undefined : 1}
              step={key === "minBlindReviewedCases" ? 1 : 0.01}
              value={draft[key] ?? ""}
              onChange={(event) =>
                setDraft({ ...draft, [key]: number(event.target.value) })
              }
            />
          </label>
        ))}
        <label className="text-sm text-zinc-200">
          {ko ? "음성 사례 부분집합" : "Negative-case subset"}
          <select
            className={`${field} mt-2`}
            value={draft.negativeSubset.policy}
            onChange={(event) =>
              setDraft({
                ...draft,
                negativeSubset:
                  event.target.value === "gate"
                    ? { policy: "gate", maxWilsonUpper: null }
                    : {
                        policy: event.target.value as
                          | "undecided"
                          | "diagnostic",
                      },
              })
            }
          >
            <option value="undecided">{ko ? "미결정" : "Undecided"}</option>
            <option value="diagnostic">
              {ko ? "진단으로만 표시" : "Diagnostic only"}
            </option>
            <option value="gate">{ko ? "상한 적용" : "Apply a ceiling"}</option>
          </select>
        </label>
        {draft.negativeSubset.policy === "gate" && (
          <label className="text-sm text-zinc-200">
            {ko ? "음성 부분집합 상한" : "Negative subset ceiling"}
            <input
              className={`${field} mt-2`}
              type="number"
              min="0"
              max="1"
              step="0.01"
              value={draft.negativeSubset.maxWilsonUpper ?? ""}
              onChange={(event) =>
                setDraft({
                  ...draft,
                  negativeSubset: {
                    policy: "gate",
                    maxWilsonUpper: number(event.target.value),
                  },
                })
              }
            />
          </label>
        )}
      </div>
      <label className="block text-sm text-zinc-200">
        {ko ? "선택 근거" : "Rationale"}
        <textarea
          className={`${field} my-2`}
          value={draft.rationale}
          onChange={(event) =>
            setDraft({ ...draft, rationale: event.target.value })
          }
        />
      </label>
      <p className="mb-3 text-xs text-zinc-400">
        {ko
          ? "모순·누락의 네 하한은 키워드 진단입니다. 새 오류율 두 개만 judged 지표입니다."
          : "The four contradiction/omission floors remain keyword diagnostics. Only the two new error rates use judged evidence."}
      </p>
      <button
        type="button"
        className="min-h-10 rounded-lg border border-zinc-700 px-4 py-2 text-sm text-zinc-100 disabled:opacity-40"
        disabled={problems.length > 0}
        onClick={() => {
          downloadAiReviewDraft("ai-review-judged-thresholds-draft.json", {
            ...draft,
            approvedBy: null,
            approvedAt: null,
          });
          setDownloaded(true);
        }}
      >
        {ko ? "미승인 기준 초안 내려받기" : "Download unsigned threshold draft"}
      </button>
      <p role="status" className="mt-3 text-xs text-zinc-400">
        {downloaded
          ? ko
            ? "미승인 초안을 내려받았습니다."
            : "Unsigned draft downloaded."
          : `${problems.length} ${ko ? "개 입력을 확인하세요." : "input issue(s) remain."}`}
      </p>
    </details>
  );
}
