import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the cost-efficiency diagnostic and the real Chat serving-cost report on Admin › Routing. */
export const costEfficiencyMessages = defineAdminMessages({
  en: {
    title: "Cost-efficiency diagnostic (diagnostic only)",
    scope: "Price-blind quality comparison against cheaper candidates on tool-free text answers. Never promoted, never changes a setting; search, attachments, files, Memory and continuation are not measured.",
    candidateTitle: "Current pick vs a cheaper candidate",
    guidanceTitle: "Frozen current guidance vs proposed guidance",
    samples: (savings: number, quality: number, none: number) => `${savings} savings samples · ${quality} quality-only comparisons (no cheaper candidate) · ${none} without an alternative`,
    basis: (credit: number, estimated: number) => `drawn by lower credits ${credit} · by lower estimated provider cost ${estimated}`,
    quality: (better: number, worse: number, equal: number, insufficient: number, disagreement: number, undecided: number) =>
      `cheaper better ${better} · current better ${worse} · equal ${equal} · insufficient ${insufficient} · order disagreement ${disagreement} · no verdict ${undecided}`,
    regressions: (count: number) => `${count} critical regressions (a requirement the current answer met)`,
    exact: (graded: number, current: number, cheaper: number) => `exact-answer cases ${graded}: current passed ${current}, cheaper passed ${cheaper}`,
    credits: (pairs: number, current: number, cheaper: number) => `credits over ${pairs} pairs: ${current} → ${cheaper} (a credit change is not a saving)`,
    observed: (known: number, unknown: number, current: string, cheaper: string, lower: number, unanswered: number) =>
      `observed answer cost over ${known} known pairs: ${current} → ${cheaper}; cheaper lower in ${lower}; ${unknown} pairs unknown; ${unanswered} pairs without both answers`,
    latency: (pairs: number, current: number | null, cheaper: number | null) =>
      `answer time median over ${pairs} pairs: ${current ?? "-"} ms → ${cheaper ?? "-"} ms`,
    guidance: (evaluated: number, unchanged: number, changed: number, unrouted: number) =>
      `${evaluated} evaluated · ${unchanged} same pick · ${changed} changed and answered · ${unrouted} routing failed`,
    guidanceCredits: (baseline: number | null, candidate: number | null) => `credits ${baseline ?? "-"} → ${candidate ?? "-"}`,
    serving: (baseline: string, candidate: string, complete: boolean) =>
      `partial serving cost (router + changed answers): ${baseline} → ${candidate}${complete ? "" : " · incomplete"}`,
    experiment: (known: string, unknown: number, failed: number, retries: number, notStarted: number) =>
      `experiment cost ${known} known · ${unknown} unknown calls · ${failed} failed · ${retries} answer retries · ${notStarted} not started`,
    taskUnlinked: "Task cost (regenerations and follow-ups) is not linked in this cycle.",
    criteria: (version: string, status: string) => `criteria ${version} (${status})`,
    notApplicable: "Not applicable as guidance:",
    measured: "The sample met the recorded criteria within its scope; promotion still needs a separate decision.",
    reasons: {
      diagnostic_only: "diagnostic only",
      criteria_unconfirmed: "criteria not yet confirmed by the owner",
      cycle_incomplete: "the cycle did not finish",
      cost_coverage_incomplete: "cost coverage incomplete",
      savings_samples_below_minimum: "too few savings samples",
      critical_regression_observed: "a critical regression was observed",
      quality_loss_above_tolerance: "the current pick won too often",
      undecided_above_tolerance: "too many undecided comparisons",
      answer_failures_above_tolerance: "the cheaper model failed to answer too often",
      no_observed_saving: "no observed answer-cost saving",
      guidance_not_cheaper: "the proposed guidance does not pick cheaper",
      tool_free_scope_only: "tool-free scope only",
    } as Record<string, string>,
    servingTitle: "Real Auto Chat serving cost (last 7 days, answer cost only)",
    servingNote: "Answer attempts are linked by trace id with their recorded adjustments. Router tokens have no price snapshot; Prompt Refiner and app-managed search are not linked to a request. Those are unknown, not zero.",
    servingUnavailable: "The serving-cost report could not be read.",
    servingRow: (traces: number, linked: number, known: number, unknown: number, cost: string, credits: number, retried: number, p50: number | null) =>
      `${traces} turns · ${linked} linked · answer cost known ${known} / unknown ${unknown} · ${cost} · ${credits} credits · ${retried} retried · first content p50 ${p50 ?? "-"} ms`,
  },
  ko: {
    title: "비용 효율 진단 (진단 전용)",
    scope: "도구 없는 텍스트 답변에서 더 저렴한 후보와 가격을 숨긴 품질을 비교합니다. 승격하거나 설정을 바꾸지 않으며, 검색·첨부·파일·Memory·이어가기는 측정하지 않습니다.",
    candidateTitle: "현재 선택 vs 더 저렴한 후보",
    guidanceTitle: "고정한 현재 지침 vs 제안 지침",
    samples: (savings: number, quality: number, none: number) => `절감 표본 ${savings}건 · 품질 비교만(더 싼 후보 없음) ${quality}건 · 대안 없음 ${none}건`,
    basis: (credit: number, estimated: number) => `낮은 credit으로 고름 ${credit} · 낮은 provider 비용 추정으로 고름 ${estimated}`,
    quality: (better: number, worse: number, equal: number, insufficient: number, disagreement: number, undecided: number) =>
      `저가 우수 ${better} · 현재 우수 ${worse} · 동등 ${equal} · 판단 불가 ${insufficient} · 순서 불일치 ${disagreement} · 판정 없음 ${undecided}`,
    regressions: (count: number) => `치명적 회귀 ${count}건 (현재 답변이 지킨 요구를 저가 답변이 어김)`,
    exact: (graded: number, current: number, cheaper: number) => `정답형 ${graded}건: 현재 통과 ${current}, 저가 통과 ${cheaper}`,
    credits: (pairs: number, current: number, cheaper: number) => `${pairs}쌍 credit: ${current} → ${cheaper} (credit 변화는 절감이 아닙니다)`,
    observed: (known: number, unknown: number, current: string, cheaper: string, lower: number, unanswered: number) =>
      `관측 답변 비용(비용 확인 ${known}쌍): ${current} → ${cheaper}; 저가가 낮음 ${lower}쌍; 불명 ${unknown}쌍; 답변 없음 ${unanswered}쌍`,
    latency: (pairs: number, current: number | null, cheaper: number | null) =>
      `${pairs}쌍 답변 시간 중앙값: ${current ?? "-"} ms → ${cheaper ?? "-"} ms`,
    guidance: (evaluated: number, unchanged: number, changed: number, unrouted: number) =>
      `평가 ${evaluated} · 같은 선택 ${unchanged} · 바뀌고 답변 비교 ${changed} · 라우팅 실패 ${unrouted}`,
    guidanceCredits: (baseline: number | null, candidate: number | null) => `credit ${baseline ?? "-"} → ${candidate ?? "-"}`,
    serving: (baseline: string, candidate: string, complete: boolean) =>
      `부분 serving 비용(router + 바뀐 답변): ${baseline} → ${candidate}${complete ? "" : " · 불완전"}`,
    experiment: (known: string, unknown: number, failed: number, retries: number, notStarted: number) =>
      `실험비 확인 ${known} · 비용 불명 호출 ${unknown} · 실패 ${failed} · 답변 재시도 ${retries} · 미시작 ${notStarted}`,
    taskUnlinked: "작업 비용(재생성·후속 수정)은 이 회차에 연결되지 않습니다.",
    criteria: (version: string, status: string) => `판정 기준 ${version} (${status})`,
    notApplicable: "지침 적용 불가 이유:",
    measured: "이 표본은 기록된 기준을 범위 안에서 충족했습니다. 승격은 별도 결정이 필요합니다.",
    reasons: {
      diagnostic_only: "진단 전용",
      criteria_unconfirmed: "운영자가 기준을 아직 확정하지 않음",
      cycle_incomplete: "회차가 끝나지 않음",
      cost_coverage_incomplete: "비용 coverage 불완전",
      savings_samples_below_minimum: "절감 표본 부족",
      critical_regression_observed: "치명적 회귀 관측",
      quality_loss_above_tolerance: "현재 선택이 너무 자주 우세",
      undecided_above_tolerance: "미판정 비교가 너무 많음",
      answer_failures_above_tolerance: "저가 모델 답변 실패가 너무 많음",
      no_observed_saving: "관측 답변 비용 절감 없음",
      guidance_not_cheaper: "제안 지침이 더 싸게 고르지 않음",
      tool_free_scope_only: "도구 없는 범위만",
    } as Record<string, string>,
    servingTitle: "실제 Auto Chat serving 비용 (최근 7일, 답변 비용만)",
    servingNote: "답변 시도는 trace id로 연결하고 기록된 보정을 반영합니다. Router token에는 가격 snapshot이 없고 Prompt Refiner와 앱 검색은 요청에 연결되지 않습니다. 이 항목은 0이 아니라 불명입니다.",
    servingUnavailable: "serving 비용 보고를 읽지 못했습니다.",
    servingRow: (traces: number, linked: number, known: number, unknown: number, cost: string, credits: number, retried: number, p50: number | null) =>
      `${traces}턴 · 연결 ${linked} · 답변 비용 확인 ${known} / 불명 ${unknown} · ${cost} · ${credits} credit · 재시도 ${retried} · 첫 응답 p50 ${p50 ?? "-"} ms`,
  },
});
