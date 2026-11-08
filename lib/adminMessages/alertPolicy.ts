import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Alert policy panel under Operator alerts. */
export const adminAlertPolicyMessages = defineAdminMessages({
  en: {
    loadFailed: "Could not load alert policies.",
    loadFailedDetail: "The policies could not be read, so nothing is shown here. Try again.",
    saveFailed: "Could not save alert policy.",
    saved: "Alert policy saved.",
    // The routes tile.
    routesTitle: "How urgent, and where it goes",
    routesDescription: "Each policy says which problems raise an alert and which channels carry it.",
    routesCaption: "Alert policies and where they send",
    routesEmpty: "No alert policies are set up.",
    columns: {
      policy: "Policy",
      appliesTo: "Applies to",
      budget: "Budget alerts at",
      goesTo: "Goes to",
      state: "State",
    },
    active: "On",
    inactive: "Off",
    noChannel: "No channel",
    // The editor tile keeps the heading the console has always used.
    title: "Budget and incident thresholds",
    description:
      "Configure the operational thresholds used by provider budget, failure surge, and model incident alerts.",
    loading: "Loading alert policy...",
    name: "Name",
    budgetPercent: "Budget %",
    providerFail: "Provider fail",
    modelFail: "Model fail",
    email: "Email",
    save: "Save",
    allProviders: "all providers",
    appliesTo: (target: string) => `Applies to ${target}.`,
    percent: (value: number) => `${value}%`,
    failures: (provider: number, model: number) =>
      `${provider} provider failures, ${model} model failures`,
    // Recent alerts.
    recentTitle: "Recent alerts",
    recentDescription: "The latest messages the platform tried to send.",
    recentEmpty: "Nothing has been sent yet.",
    recentFailed: (count: number) => `${count} failed`,
    recentStatus: { sent: "Sent", failed: "Failed", skipped: "Skipped" },
    recentOpen: "Open the delivery log",
    // The mail path test shortcut.
    probeTitle: "Mail path test",
    probeDescription:
      "Send one real test message through each operator alert email path, and see the address the provider accepted.",
    probeOpen: "Open the mail path test",
  },
  ko: {
    loadFailed: "알림 정책을 불러오지 못했어요.",
    loadFailedDetail: "정책을 읽지 못해서 아무것도 보여 주지 않았어요. 다시 시도해 주세요.",
    saveFailed: "알림 정책을 저장하지 못했어요.",
    saved: "알림 정책을 저장했어요.",
    routesTitle: "얼마나 급하면, 어디로",
    routesDescription: "정책마다 어떤 문제에 알림을 보내고, 어느 경로로 보내는지 보여요.",
    routesCaption: "알림 정책과 보내는 곳",
    routesEmpty: "만들어 둔 알림 정책이 없어요.",
    columns: {
      policy: "정책",
      appliesTo: "적용 대상",
      budget: "예산 알림 기준",
      goesTo: "보내는 곳",
      state: "상태",
    },
    active: "켜짐",
    inactive: "꺼짐",
    noChannel: "경로 없음",
    title: "예산 및 장애 임계값",
    description:
      "공급자 예산, 실패 급증, 모델 장애 알림에 쓰이는 운영 임계값을 설정해요.",
    loading: "알림 정책을 불러오는 중...",
    name: "이름",
    budgetPercent: "예산 %",
    providerFail: "공급자 실패",
    modelFail: "모델 실패",
    email: "이메일",
    save: "저장",
    allProviders: "모든 공급자",
    appliesTo: (target: string) => `${target}에 적용돼요.`,
    percent: (value: number) => `${value}%`,
    failures: (provider: number, model: number) =>
      `공급자 실패 ${provider}번, 모델 실패 ${model}번`,
    recentTitle: "최근 알림",
    recentDescription: "플랫폼이 가장 최근에 보내려 한 메시지예요.",
    recentEmpty: "아직 보낸 알림이 없어요.",
    recentFailed: (count: number) => `실패 ${count}건`,
    recentStatus: { sent: "보냄", failed: "실패", skipped: "건너뜀" },
    recentOpen: "발송 기록 열기",
    probeTitle: "메일 경로 시험",
    probeDescription:
      "운영자 알림 메일 경로마다 실제 시험 메일을 한 통씩 보내고, 공급자가 받은 주소를 확인해요.",
    probeOpen: "메일 경로 시험 열기",
  },
});
