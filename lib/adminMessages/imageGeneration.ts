import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the image generation operations panel (AdminImageGenerationPanel). */
export const adminImageGenerationMessages = defineAdminMessages({
  en: {
    loadFailed: "Failed to load the image generation report.",
    badge: "Image generation",
    title: "Budget, billing and lifecycle",
    description:
      "Provider budget enforcement vs usage, reservation vs settlement, failure phases, storage growth, and the maintenance-sweep invariants (docs/policy/image-generation.md).",
    flagOn: "Flag ON",
    flagOff: "Flag OFF",
    refresh: "Refresh",
    budgetToday: "Budget today",
    unconfigured: "unconfigured",
    dailyCapDetail: (percent: number, source: string) =>
      `${percent}% of the daily cap · source: ${source}`,
    sourceDetail: (source: string) => `source: ${source}`,
    budgetThisMonth: "Budget this month",
    floor: (amount: string) => `floor ${amount}`,
    overridesRaised: (count: number) => ` · ${count} override(s) raised to the floor`,
    perCreditCeiling: "Per-credit cost ceiling",
    ceilingDetail: (headroom: string, version: string, verifiedAt: string) =>
      `${headroom} headroom · ${version} · verified ${verifiedAt}`,
    invariants: "Invariants",
    clean: "clean",
    issues: (count: number) => `${count} issue(s)`,
    invariantsDetail: (counts: {
      empty: number;
      stale: number;
      stranded: number;
      cleanup: number;
      thumbnailsQueued: number;
      thumbnailsExhausted: number;
      orphaned: number;
      orphanedCost: string;
    }) =>
      `${counts.empty} empty conversations · ${counts.stale} stale (${counts.stranded} stranded mid-settlement) · ${counts.cleanup} cleanup backlog · ${counts.thumbnailsQueued} thumbnails queued (${counts.thumbnailsExhausted} exhausted) · ${counts.orphaned} orphaned reservations holding ${counts.orphanedCost}`,
    providerBudgets: "Provider budgets",
    providerBudgetsNote:
      "Each provider spends against its own ceiling. A provider with no row has spent nothing today.",
    provider: "Provider",
    today: "Today",
    thisMonth: "This month",
    source: "Source",
    problems: (count: number) => ` · ${count} problem(s)`,
    raisedToFloor: (count: number) => ` · ${count} raised to floor`,
    generations: "Generations",
    noGenerations: "No generations yet.",
    noStoredAssets: "No stored assets.",
    assetCount: (count: number) => `: ${count} asset(s) · `,
    reservationsVsSettlement: "Reservations vs settlement",
    credits: "Credits",
    settledReserved: "settled / reserved",
    providerCost: "Provider cost",
    option: "Option",
    count: "Count",
    avgSettledCost: "Avg settled cost",
    modelRegistry: "Model registry",
    enabled: "enabled",
    verified: (date: string) => `verified ${date}`,
    priceUnverified: "price unverified",
    pricedOptions: (count: number) => `· ${count} priced option(s)`,
    settledSpendByProvider: "Settled spend by provider",
    providerModel: "Provider · model",
    settlements: "Settlements",
    settledCost: "Settled cost",
    measuredDimensions: "Measured output dimensions",
    measured: (measured: number, succeeded: number) => `${measured}/${succeeded} measured`,
    unreadable: (count: number) => ` · ${count} unreadable`,
  },
  ko: {
    loadFailed: "이미지 생성 보고서를 불러오지 못했습니다.",
    badge: "이미지 생성",
    title: "예산, 과금, 수명주기",
    description:
      "공급자 예산 강제와 사용량, 예약과 정산, 실패 단계, 저장소 증가, maintenance sweep 불변식(docs/policy/image-generation.md)을 보여 줍니다.",
    flagOn: "Flag 켜짐",
    flagOff: "Flag 꺼짐",
    refresh: "새로고침",
    budgetToday: "오늘 예산",
    unconfigured: "설정 안 됨",
    dailyCapDetail: (percent: number, source: string) =>
      `일 한도의 ${percent}% · 출처: ${source}`,
    sourceDetail: (source: string) => `출처: ${source}`,
    budgetThisMonth: "이번 달 예산",
    floor: (amount: string) => `하한 ${amount}`,
    overridesRaised: (count: number) => ` · override ${count}개를 하한으로 올림`,
    perCreditCeiling: "크레딧당 비용 상한",
    ceilingDetail: (headroom: string, version: string, verifiedAt: string) =>
      `여유분 ${headroom} · ${version} · ${verifiedAt} 확인`,
    invariants: "불변식",
    clean: "이상 없음",
    issues: (count: number) => `문제 ${count}건`,
    invariantsDetail: (counts: {
      empty: number;
      stale: number;
      stranded: number;
      cleanup: number;
      thumbnailsQueued: number;
      thumbnailsExhausted: number;
      orphaned: number;
      orphanedCost: string;
    }) =>
      `빈 대화 ${counts.empty}건 · 정체 ${counts.stale}건(정산 중 멈춤 ${counts.stranded}건) · 정리 대기 ${counts.cleanup}건 · 썸네일 대기 ${counts.thumbnailsQueued}건(재시도 소진 ${counts.thumbnailsExhausted}건) · 고아 예약 ${counts.orphaned}건이 ${counts.orphanedCost} 점유`,
    providerBudgets: "공급자 예산",
    providerBudgetsNote:
      "각 공급자는 자기 상한 안에서 지출합니다. 행이 없는 공급자는 오늘 지출이 없습니다.",
    provider: "공급자",
    today: "오늘",
    thisMonth: "이번 달",
    source: "출처",
    problems: (count: number) => ` · 문제 ${count}건`,
    raisedToFloor: (count: number) => ` · ${count}개 하한으로 올림`,
    generations: "생성",
    noGenerations: "아직 생성 기록이 없습니다.",
    noStoredAssets: "저장된 asset이 없습니다.",
    assetCount: (count: number) => `: asset ${count}개 · `,
    reservationsVsSettlement: "예약 대비 정산",
    credits: "크레딧",
    settledReserved: "정산 / 예약",
    providerCost: "공급자 비용",
    option: "옵션",
    count: "건수",
    avgSettledCost: "평균 정산 비용",
    modelRegistry: "모델 레지스트리",
    enabled: "활성",
    verified: (date: string) => `${date} 확인`,
    priceUnverified: "가격 미검증",
    pricedOptions: (count: number) => `· 가격 옵션 ${count}개`,
    settledSpendByProvider: "공급자별 정산 지출",
    providerModel: "공급자 · 모델",
    settlements: "정산 건수",
    settledCost: "정산 비용",
    measuredDimensions: "측정된 출력 크기",
    measured: (measured: number, succeeded: number) => `${measured}/${succeeded} 측정됨`,
    unreadable: (count: number) => ` · 읽을 수 없음 ${count}건`,
  },
});
