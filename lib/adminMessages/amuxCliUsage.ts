import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAmuxCliUsageMessages = defineAdminMessages({
  en: {
    title: "Worker CLI usage coverage",
    description: "Last 30 days. Tokens and API estimates sum reported calls only; missing calls are never zero-cost. Estimates are not subscription charges or user credits.",
    unavailable: "Usage coverage is unavailable; do not interpret this as zero usage.",
    empty: "No completed attempts or usage receipts in this window.",
    worker: "Worker", model: "Served model", round: "Round",
    recorded: "Recorded calls", unknown: "Unknown usage",
    missing: "Attempts without a receipt", rate: "Unmeasured ≥", none: "unknown",
    reportedInput: "Reported input", reportedOutput: "Reported output",
    cacheRead: "Reported cache read", cacheWrite: "Reported cache write",
    projected: "Known API estimate", projectedUnknown: "unpriced",
    partialCoverage: "known subset only",
    totals: (recorded: number, missing: number) =>
      `${recorded} recorded calls · at least ${missing} unmeasured`,
  },
  ko: {
    title: "worker CLI 사용량 수집 상태",
    description: "최근 30일입니다. 토큰·API 예상액은 보고된 호출만 합산하며 누락 호출은 0원으로 취급하지 않습니다. 예상액은 구독료나 사용자 크레딧이 아닙니다.",
    unavailable: "사용량 수집 상태를 읽을 수 없습니다. 사용량 0으로 해석하지 마세요.",
    empty: "이 기간에 종료된 시도나 사용량 접수 기록이 없습니다.",
    worker: "worker", model: "실제 모델", round: "회차",
    recorded: "기록된 호출", unknown: "사용량 불명",
    missing: "접수 기록 없는 시도", rate: "미측정률 ≥", none: "미확인",
    reportedInput: "보고된 입력", reportedOutput: "보고된 출력",
    cacheRead: "보고된 캐시 읽기", cacheWrite: "보고된 캐시 쓰기",
    projected: "확인된 API 예상액", projectedUnknown: "가격 미확인",
    partialCoverage: "확인된 일부만",
    totals: (recorded: number, missing: number) =>
      `기록된 호출 ${recorded}건 · 측정되지 않은 최소 ${missing}건`,
  },
});
