import { defineAdminMessages } from "@/lib/adminLocale";

/**
 * Copy for the Slack templates panel under Alerts.
 *
 * Only the console around the templates. Template names, descriptions, titles
 * and bodies come from the server and are what gets sent to Slack.
 */
export const adminSlackTemplatesMessages = defineAdminMessages({
  en: {
    loadFailed: "Could not load Slack templates.",
    saveFailed: "Could not save Slack template.",
    saved: "Slack template saved.",
    testFailed: "Slack test failed.",
    testSent: "Slack test message sent.",
    eyebrow: "Slack messages",
    title: "Templates and delivery tests",
    description:
      "Edit scheduled reports and provider alert messages, then send a safe test from Admin. Database outage alerts remain independent so they still work when the application database is unavailable. Every Slack delivery automatically starts with <!channel> to notify the channel.",
    daily: (schedule: string) => `Daily ${schedule}`,
    webhooksConfigured: "Webhooks configured",
    webhooksIncomplete: "Webhooks incomplete",
    loading: "Loading Slack templates...",
    scheduledDeliveryEnabled: "Scheduled delivery enabled",
    titleField: "Title",
    bodyField: "Message body",
    variables: "Variables: ",
    sendTest: "Send test",
    save: "Save",
  },
  ko: {
    loadFailed: "Slack 템플릿을 불러오지 못했습니다.",
    saveFailed: "Slack 템플릿을 저장하지 못했습니다.",
    saved: "Slack 템플릿을 저장했습니다.",
    testFailed: "Slack 테스트에 실패했습니다.",
    testSent: "Slack 테스트 메시지를 보냈습니다.",
    eyebrow: "Slack 메시지",
    title: "템플릿과 전송 테스트",
    description:
      "예약 보고서와 공급자 알림 메시지를 편집한 뒤 관리자 화면에서 안전하게 테스트를 보낼 수 있습니다. 데이터베이스 장애 알림은 별도로 동작하므로 애플리케이션 데이터베이스를 쓸 수 없을 때도 전송됩니다. 모든 Slack 전송은 채널에 알리도록 자동으로 <!channel>로 시작합니다.",
    daily: (schedule: string) => `매일 ${schedule}`,
    webhooksConfigured: "Webhook 설정됨",
    webhooksIncomplete: "Webhook 설정 미완료",
    loading: "Slack 템플릿을 불러오는 중...",
    scheduledDeliveryEnabled: "예약 전송 사용",
    titleField: "제목",
    bodyField: "메시지 본문",
    variables: "변수: ",
    sendTest: "테스트 전송",
    save: "저장",
  },
});
