import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the product-research (Scout) agent's head and its side tiles (admin redesign, step 6). */
export const adminScoutAgentMessages = defineAdminMessages({
  en: {
    name: "Product research (Scout)",
    description: "Uses Tomverse with a test account and reports what to fix. A suggestion goes to AMUX only when a person sends it.",
    status: { on: "Working", judgingOff: "Judging is off", off: "Off", unknown: "Unavailable" },
    nextRun: (time: string) => `Next run ${time} AEST`,
    nextRunUnknown: "Next run unavailable",
    testAccount: (configured: boolean): string => (configured ? "Test account is set" : "No test account"),
    weekTitle: "Suggestions kept, last 7 days",
    weekNone: "Daily counts could not be read.",
    weekSent: (n: number) => `Sent to AMUX: ${n}`,
    weekBarsLabel: "Suggestions kept per day",
    costTitle: "Model calls today",
    costOf: (cap: number) => `Daily limit ${cap} calls`,
    costNote: "The Scout records calls and tokens, not dollars, so this ring counts calls against the daily limit.",
    costOff: "No daily limit is set, so there is nothing to measure against.",
    lastRunTitle: "Last run",
    lastRunNone: "The Scout has not run yet.",
    lastRunDetail: (calls: number, failed: number, kept: number) =>
      `${calls} judged, ${failed} failed, ${kept} kept`,
    lastRunUnsettled: (n: number) => `${n} call${n === 1 ? "" : "s"} not closed`,
  },
  ko: {
    name: "제품 리서치 (Scout)",
    description: "테스트 계정으로 Tomverse를 직접 써 보고 고칠 점을 올려요. 제안은 사람이 보낼 때만 AMUX로 넘어가요.",
    status: { on: "일하는 중", judgingOff: "판단 꺼짐", off: "꺼짐", unknown: "확인 불가" },
    nextRun: (time: string) => `다음 실행 ${time} AEST`,
    nextRunUnknown: "다음 실행 시각을 알 수 없어요",
    testAccount: (configured: boolean): string => (configured ? "테스트 계정이 설정돼 있어요" : "테스트 계정이 없어요"),
    weekTitle: "최근 7일 남긴 제안",
    weekNone: "날짜별 숫자를 읽지 못했어요.",
    weekSent: (n: number) => `AMUX로 보낸 것 ${n}건`,
    weekBarsLabel: "날짜별 남긴 제안",
    costTitle: "오늘 모델 호출",
    costOf: (cap: number) => `하루 한도 ${cap}번`,
    costNote: "Scout는 호출 수와 토큰을 기록하고 금액은 기록하지 않아요. 그래서 이 링은 하루 한도 대비 호출 수예요.",
    costOff: "하루 한도가 없어서 견줄 기준이 없어요.",
    lastRunTitle: "마지막 실행",
    lastRunNone: "Scout가 아직 실행되지 않았어요.",
    lastRunDetail: (calls: number, failed: number, kept: number) =>
      `${calls}건 판단, ${failed}건 실패, ${kept}건 남김`,
    lastRunUnsettled: (n: number) => `마무리되지 않은 호출 ${n}건`,
  },
});
