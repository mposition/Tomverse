import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the model metrics panel (AdminModelMetricsPanel). */
export const adminModelMetricsMessages = defineAdminMessages({
  en: {
    title: "Failure rate and latency watch",
    description:
      "Failures in the current 5 minute window, with the latest manual provider check. Most failures first; the first 12 models are shown.",
    caption: "Models with their latest failure and latency signals",
    model: "Model",
    status: "Status",
    failures5m: "5m failures",
    lastLatency: "Last check latency",
    lastSignal: "Last signal",
    noRecentError: "No recent error",
    noLatency: "None",
    empty: "No model metrics are available yet.",
    stateAvailable: "Healthy",
    stateLimited: "Limited",
    stateOutage: "Outage",
  },
  ko: {
    title: "실패율과 지연 시간 감시",
    description:
      "지금 5분 구간의 실패 수와 가장 최근 수동 공급자 점검을 함께 보여 줘요. 실패가 많은 순서로, 앞의 12개 모델만 보여 줘요.",
    caption: "모델별 최근 실패와 지연 신호",
    model: "모델",
    status: "상태",
    failures5m: "5분 실패",
    lastLatency: "마지막 점검 응답",
    lastSignal: "마지막 신호",
    noRecentError: "최근 오류 없음",
    noLatency: "없음",
    empty: "아직 모델 지표가 없어요.",
    stateAvailable: "정상",
    stateLimited: "제한됨",
    stateOutage: "장애",
  },
});
