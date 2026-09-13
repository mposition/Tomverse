import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the model metrics panel (AdminModelMetricsPanel). */
export const adminModelMetricsMessages = defineAdminMessages({
  en: {
    eyebrow: "Model metrics",
    title: "Failure rate and latency watch",
    description:
      "Model-level incident signals from the current monitoring window, combined with the latest manual provider health checks.",
    lastSignal: (date: string, error: string) => `Last signal ${date} UTC / ${error}`,
    noRecentError: "No recent error",
    failures5m: "5m failures",
    lastLatency: "Last latency",
    empty: "No model metrics are available yet.",
  },
  ko: {
    eyebrow: "모델 지표",
    title: "실패율과 지연 시간 감시",
    description:
      "현재 모니터링 창의 모델 단위 장애 신호와 가장 최근의 수동 공급자 상태 점검을 함께 보여 줍니다.",
    lastSignal: (date: string, error: string) => `마지막 신호 ${date} UTC / ${error}`,
    noRecentError: "최근 오류 없음",
    failures5m: "5분 실패",
    lastLatency: "마지막 지연 시간",
    empty: "아직 모델 지표가 없습니다.",
  },
});
