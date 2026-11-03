import { defineAdminMessages } from "@/lib/adminLocale";

export const adminAiReviewM5ProgressMessages = defineAdminMessages({
  en: {
    recorded: "Recorded · content verification separate",
    notRecorded: "Not recorded",
    candidates: "Candidate / adoption records",
    frozenSets: "Structurally valid, adequate frozen sets",
    thresholdSets: "Signed judged threshold sets",
    reportConnection: "Report connection",
    unconfigured: "Not configured",
    unavailable: "Unavailable",
    connected: "Connected",
    runs: "Verified runs / refused / read diagnostics",
    approvedPairs:
      "Pairs marked approved in register (evidence verified separately)",
    observationPolicy: "Observation policy",
    rollbackDrill: "Rollback drill",
    promotionSignature: "M5 promotion signature",
    title: "M5 operational evidence",
    description:
      "An inventory, not a promotion verdict. Verified reports do not imply quality or operational success.",
    download: "Download status",
    connectionHelp:
      "Configure the server report directory to connect stored runs. Use report:ai-review-judged-catalog locally to check the same reader first.",
  },
  ko: {
    recorded: "기록 있음 · 내용 검증은 별도",
    notRecorded: "미기록",
    candidates: "후보·채택 기록",
    frozenSets: "구조·규모·동결 검사를 통과한 표본",
    thresholdSets: "서명된 judged 임계값 집합",
    reportConnection: "보고서 연결",
    unconfigured: "미설정",
    unavailable: "읽기 실패",
    connected: "연결됨",
    runs: "검증된 실행 / 집계 거절 / 읽기 진단",
    approvedPairs: "등록부의 승인 조합 (증거 재검증 별도)",
    observationPolicy: "운영 관측 기준",
    rollbackDrill: "복구 훈련",
    promotionSignature: "M5 승급 서명",
    title: "M5 운영 증거 현황",
    description:
      "실제 기록의 현황이며 승급 판정이 아닙니다. 검증된 보고서도 품질 임계값 통과나 운영 성과를 뜻하지 않습니다.",
    download: "현황 내려받기",
    connectionHelp:
      "서버의 보고서 디렉터리를 설정하면 검증된 실행이 여기에 나타납니다. 연결 전 로컬에서 report:ai-review-judged-catalog 명령으로 동일한 읽기 경로를 확인할 수 있습니다.",
  },
});

export const adminAiReviewThresholdDraftMessages = defineAdminMessages({
  en: {
    title: "Evaluation preparation · threshold draft",
    description:
      "Choose criteria before inspecting observed scores. Download an unsigned draft; this does not change gates or signatures. Enter rates from 0 to 1.",
    version: "Threshold version",
    negativeSubset: "Negative-case subset",
    undecided: "Undecided",
    diagnosticOnly: "Diagnostic only",
    applyCeiling: "Apply a ceiling",
    negativeCeiling: "Negative subset ceiling",
    rationale: "Rationale",
    metricNotice:
      "The four contradiction/omission floors remain keyword diagnostics. Only the two new error rates use judged evidence.",
    download: "Download unsigned threshold draft",
    downloaded: "Unsigned draft downloaded.",
    inputIssues: (count: number) => `${count} input issue(s) remain.`,
    labels: {
      contradictionRecall: "Contradiction recall floor",
      contradictionPrecision: "Contradiction precision floor",
      omissionRecall: "Omission recall floor",
      omissionPrecision: "Omission precision floor",
      exactQuoteMatchRate: "Exact quotation match floor",
      schemaValidRate: "Schema validity floor",
      missedEveryPlantedIssueRate: "Missed every planted issue ceiling",
      inventedFindingRate: "Invented finding ceiling",
      maxLanguageArmGap: "Maximum language gap",
      maxTaskTypeArmShortfall: "Task type allowance",
      minBlindReviewedCases: "Minimum blind-reviewed cases",
    },
  },
  ko: {
    title: "평가 준비 · 품질 기준 초안",
    description:
      "관측 점수를 보고 기준을 조정하지 마세요. 이 양식은 미승인 초안을 내려받으며, 게이트나 서명을 변경하지 않습니다. 비율은 0~1로 입력합니다.",
    version: "임계값 버전",
    negativeSubset: "음성 사례 부분집합",
    undecided: "미결정",
    diagnosticOnly: "진단으로만 표시",
    applyCeiling: "상한 적용",
    negativeCeiling: "음성 부분집합 상한",
    rationale: "선택 근거",
    metricNotice:
      "모순·누락의 네 하한은 키워드 진단입니다. 새 오류율 두 개만 judged 지표입니다.",
    download: "미승인 기준 초안 내려받기",
    downloaded: "미승인 초안을 내려받았습니다.",
    inputIssues: (count: number) => `${count}개 입력을 확인하세요.`,
    labels: {
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
    },
  },
});

export const adminAiReviewPreparationPanelMessages = defineAdminMessages({
  en: {
    question: "Question",
    answer: "Answer",
    gold: "Current gold and completeness",
    notes: "Review notes and open questions",
    downloadEdit: "Download edit proposal",
    downloaded:
      "Proposal downloaded. The original and adoption state are unchanged.",
    draftNotice:
      "Edits are local drafts, not adoption or approval of gold correctness.",
    candidate: "Candidate to review",
    composition: "Sample composition draft",
    shortfalls:
      "Shortfalls of the stored sample. Unsaved edit proposals are not included.",
    includeCandidates: "Original candidates to include",
    version: "New sample version",
    downloadSample: "Download sample proposal",
    signatureNotice:
      "Adoption and freeze signatures are not copied. The sample remains a candidate draft.",
    title: "Evaluation preparation · candidates and sample",
    description:
      "Review source text and download proposals. This does not change server files or execute an evaluation.",
    empty: "No decision candidate sets available.",
    candidateSet: "Candidate set",
  },
  ko: {
    question: "질문",
    answer: "답변",
    gold: "현재 gold와 완전성 주장",
    notes: "검토 메모·미결 사항",
    downloadEdit: "편집 초안 내려받기",
    downloaded: "초안을 내려받았습니다. 원본과 채택 상태는 바뀌지 않았습니다.",
    draftNotice:
      "변경은 이 화면의 초안입니다. 후보 채택이나 gold의 정확성을 승인하지 않습니다.",
    candidate: "검토할 후보",
    composition: "표본 구성 초안",
    shortfalls:
      "현재 저장된 표본의 부족분입니다. 편집 초안은 아직 포함하지 않습니다.",
    includeCandidates: "포함할 원본 후보",
    version: "새 표본 버전",
    downloadSample: "표본 구성 초안 내려받기",
    signatureNotice:
      "채택·동결 서명을 복사하지 않습니다. 표본은 후보 상태로 내려받습니다.",
    title: "평가 준비 · 후보 검토와 표본 구성",
    description:
      "원문을 검토하고 수정안을 내려받습니다. 서버 파일을 변경하거나 평가를 실행하지 않습니다.",
    empty: "검토할 판정용 후보 세트가 없습니다.",
    candidateSet: "후보 세트",
  },
});
