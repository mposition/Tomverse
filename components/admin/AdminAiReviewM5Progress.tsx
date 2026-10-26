"use client";
import type { AdminLocale } from "@/lib/adminLocale";
import type { AiReviewM5Progress } from "@/lib/aiReviewM5Progress";
import { downloadAiReviewDraft } from "./AdminAiReviewPreparationPanel";

export function AdminAiReviewM5Progress({
  progress,
  locale,
}: {
  progress: AiReviewM5Progress;
  locale: AdminLocale;
}) {
  const ko = locale === "ko";
  const recorded = (value: boolean) =>
    value
      ? ko
        ? "기록 있음 · 내용 검증은 별도"
        : "Recorded · content verification separate"
      : ko
        ? "미기록"
        : "Not recorded";
  const rows = [
    [
      ko ? "후보·채택 기록" : "Candidate / adoption records",
      `${progress.candidates} / ${progress.adopted}`,
    ],
    [
      ko
        ? "구조·규모·동결 검사를 통과한 표본"
        : "Structurally valid, adequate frozen sets",
      String(progress.frozenAdequateSets),
    ],
    [
      ko ? "서명된 judged 임계값 집합" : "Signed judged threshold sets",
      String(progress.signedJudgedThresholds),
    ],
    [
      ko ? "보고서 연결" : "Report connection",
      {
        unconfigured: ko ? "미설정" : "Not configured",
        unavailable: ko ? "읽기 실패" : "Unavailable",
        available: ko ? "연결됨" : "Connected",
      }[progress.reportConnection],
    ],
    [
      ko
        ? "검증된 실행 / 집계 거절 / 읽기 진단"
        : "Verified runs / refused / read diagnostics",
      `${progress.verifiedRuns} / ${progress.refusedRuns} / ${progress.unreadableReports}`,
    ],
    [
      ko
        ? "등록부의 승인 조합 (증거 재검증 별도)"
        : "Pairs marked approved in register (evidence verified separately)",
      String(progress.registeredApprovedPairs),
    ],
    [
      ko ? "운영 관측 기준" : "Observation policy",
      recorded(progress.observationPolicyRecorded),
    ],
    [
      ko ? "복구 훈련" : "Rollback drill",
      recorded(progress.rollbackDrillRecorded),
    ],
    [
      ko ? "M5 승급 서명" : "M5 promotion signature",
      recorded(progress.promotionSignatureRecorded),
    ],
  ];
  return (
    <section
      className="rounded-2xl border border-zinc-800 bg-zinc-900 p-5 sm:p-6"
      data-testid="ai-review-m5-progress"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-zinc-100">
            {ko ? "M5 운영 증거 현황" : "M5 operational evidence"}
          </h2>
          <p className="mt-2 text-sm text-zinc-400">
            {ko
              ? "실제 기록의 현황이며 승급 판정이 아닙니다. 검증된 보고서도 품질 임계값 통과나 운영 성과를 뜻하지 않습니다."
              : "An inventory, not a promotion verdict. Verified reports do not imply quality or operational success."}
          </p>
        </div>
        <button
          type="button"
          onClick={() =>
            downloadAiReviewDraft("ai-review-m5-progress.json", {
              kind: "evidence-inventory",
              promotionVerdict: "not-evaluated",
              ...progress,
            })
          }
          className="min-h-10 rounded-lg border border-zinc-700 px-3 text-sm text-zinc-200"
        >
          {ko ? "현황 내려받기" : "Download status"}
        </button>
      </div>
      <dl className="mt-5 divide-y divide-zinc-800">
        {rows.map(([label, value]) => (
          <div key={label} className="grid gap-1 py-3 text-sm sm:grid-cols-2">
            <dt className="text-zinc-400">{label}</dt>
            <dd className="break-words text-zinc-200">{value}</dd>
          </div>
        ))}
      </dl>
      {progress.reportConnection !== "available" && (
        <p className="mt-4 rounded-lg border border-zinc-700 p-3 text-sm text-zinc-300">
          {ko
            ? "서버의 보고서 디렉터리를 설정하면 검증된 실행이 여기에 나타납니다. 연결 전 로컬에서 report:ai-review-judged-catalog 명령으로 동일한 읽기 경로를 확인할 수 있습니다."
            : "Configure the server report directory to connect stored runs. Use report:ai-review-judged-catalog locally to check the same reader first."}
        </p>
      )}
    </section>
  );
}
