import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the import and memory metrics panel. Status keys and metric ids stay as sent. */
export const adminMemoryImportMessages = defineAdminMessages({
  en: {
    loadFailed: "Failed to load the memory report.",
    eyebrow: "Import & memory",
    title: "Review outcomes and extraction runs",
    description:
      "Content-free counts and rates only (docs/policy/ external-conversation-import-and-memory.md §22). Statements, evidence, titles and ids are excluded at the query layer, so nothing here can carry them.",
    refresh: "Refresh",
    noneInWindow: "None in this window.",
    memories: "Memories",
    memoriesDetail: (userAuthored: number, windowDays: number) =>
      `${userAuthored} written by hand · last ${windowDays}d`,
    approvedOfDecided: "Approved of decided",
    approvedDetail: (rejected: string, edited: string) =>
      `rejected ${rejected} · edited before approval ${edited}`,
    sensitiveShare: "Sensitive share",
    sensitiveDetail: "always excluded from bulk approval",
    extractionRuns: "Extraction runs",
    noPairRun: "no approved pair has run yet",
    pairCount: (count: number) => `${count} pair(s)`,
    memoriesByStatus: "Memories by status",
    runsByStatus: "Runs by status",
    counters: "Counters (window)",
    followupTitle: "Follow-up and regenerate proxy",
    followupNote:
      "A proxy, not a measurement of answer quality. A follow-up often means the answer was useful. Read the difference between the two arms, never either rate on its own, and never as a re-ask rate.",
    followupWithin: "Follow-up within 120s",
    regenerateWithin: "Regenerate within 120s",
    versus: (memory: string, plain: string) => `${memory} vs ${plain}`,
    followupDetail: (memoryAnswers: number, plainAnswers: number, difference: string) =>
      `memory-shaped (${memoryAnswers}) vs other answers (${plainAnswers}) · difference ${difference}`,
    regenerateDetail: (difference: string) => `difference ${difference}`,
    followupUnavailable:
      "Not measured — this report does not carry the follow-up proxy. Nothing is being claimed about either arm.",
    pair: "Pair",
    runs: "Runs",
    completed: "Completed",
    failed: "Failed",
    cancelled: "Cancelled",
    failureRate: "Failure rate",
    notMeasuredTitle: "Not measured yet",
    notMeasuredNote:
      "These §22 metrics have no source in this build. They are listed rather than shown as zero, because a zero would read as “nothing is happening”.",
    truncated: "The window hit the row cap; narrow it for exact figures.",
    notMigrated: "Some memory tables are not migrated in this environment.",
    importMissing:
      "The import report is unavailable in this environment; the memory figures above are unaffected.",
  },
  ko: {
    loadFailed: "메모리 보고서를 불러오지 못했습니다.",
    eyebrow: "가져오기·메모리",
    title: "검토 결과와 추출 실행",
    description:
      "내용이 없는 건수와 비율만 표시합니다(docs/policy/external-conversation-import-and-memory.md §22). 진술, 근거, 제목, id는 query 단계에서 제외되므로 여기에는 포함될 수 없습니다.",
    refresh: "새로고침",
    noneInWindow: "이 기간에는 없습니다.",
    memories: "메모리",
    memoriesDetail: (userAuthored: number, windowDays: number) =>
      `직접 작성 ${userAuthored}개 · 최근 ${windowDays}일`,
    approvedOfDecided: "결정된 항목 중 승인",
    approvedDetail: (rejected: string, edited: string) =>
      `거절 ${rejected} · 승인 전 수정 ${edited}`,
    sensitiveShare: "민감 항목 비율",
    sensitiveDetail: "일괄 승인에서는 항상 제외",
    extractionRuns: "추출 실행",
    noPairRun: "아직 실행된 승인 쌍이 없음",
    pairCount: (count: number) => `쌍 ${count}개`,
    memoriesByStatus: "상태별 메모리",
    runsByStatus: "상태별 실행",
    counters: "카운터 (기간)",
    followupTitle: "후속 질문·재생성 proxy",
    followupNote:
      "답변 품질을 측정한 값이 아니라 proxy입니다. 후속 질문은 답변이 유용했다는 뜻인 경우가 많습니다. 두 집단의 차이만 읽고, 한쪽 비율만 따로 읽거나 재질문율로 해석하지 마세요.",
    followupWithin: "120초 내 후속 질문",
    regenerateWithin: "120초 내 재생성",
    versus: (memory: string, plain: string) => `${memory} 대 ${plain}`,
    followupDetail: (memoryAnswers: number, plainAnswers: number, difference: string) =>
      `메모리 기반 답변(${memoryAnswers}) 대 기타 답변(${plainAnswers}) · 차이 ${difference}`,
    regenerateDetail: (difference: string) => `차이 ${difference}`,
    followupUnavailable:
      "측정되지 않음 — 이 보고서에는 후속 질문 proxy가 없습니다. 어느 집단에 대해서도 판단하지 않습니다.",
    pair: "쌍",
    runs: "실행",
    completed: "완료",
    failed: "실패",
    cancelled: "취소",
    failureRate: "실패율",
    notMeasuredTitle: "아직 측정되지 않음",
    notMeasuredNote:
      "이 §22 지표들은 이 빌드에 데이터 출처가 없습니다. 0은 “아무 일도 없다”로 읽히므로 0으로 표시하지 않고 목록으로 보여 줍니다.",
    truncated: "이 기간은 행 상한에 도달했습니다. 정확한 수치가 필요하면 기간을 좁히세요.",
    notMigrated: "이 환경에서는 일부 메모리 테이블이 migration되지 않았습니다.",
    importMissing:
      "이 환경에서는 가져오기 보고서를 사용할 수 없습니다. 위의 메모리 수치에는 영향이 없습니다.",
  },
});
