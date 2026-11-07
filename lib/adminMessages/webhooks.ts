import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Stripe webhook panel under Automation. */
export const adminWebhooksMessages = defineAdminMessages({
  en: {
    loadFailed: "Could not load webhook logs.",
    loadFailedDetail: "Stripe events may be arriving fine. Only this page could not read them.",
    reprocessFailed: "Could not reprocess webhook.",
    reprocessed: "Stripe webhook was reprocessed.",
    title: "Billing event monitor",
    description:
      "Track recent Stripe webhook delivery and processing failures before they become plan sync issues.",
    refresh: "Refresh",
    recentEvents: "Recent webhook events",
    failedCount: (count: number) => `${count} failed`,
    replayed: "replayed",
    reprocess: "Reprocess",
    empty: { title: "No Stripe webhook events recorded yet.", detail: "Events show up here as Stripe sends them." },
    stats: {
      received: "Received",
      receivedDetail: (count: number) => `Latest ${count} events`,
      processed: "Processed",
      failed: "Failed",
      failedDetail: "Each one can be reprocessed below",
      waiting: "Still waiting",
    },
    status: { processed: "Processed", failed: "Failed" },
    columns: { event: "Event", received: "Received", status: "Status" },
  },
  ko: {
    loadFailed: "webhook 기록을 불러오지 못했어요.",
    loadFailedDetail: "Stripe 이벤트는 잘 들어오고 있을 수 있어요. 이 화면이 읽지 못한 것뿐이에요.",
    reprocessFailed: "webhook을 다시 처리하지 못했어요.",
    reprocessed: "Stripe webhook을 다시 처리했어요.",
    title: "결제 이벤트 모니터",
    description:
      "최근 Stripe webhook이 잘 도착하고 처리됐는지 봐요. 플랜 동기화 문제로 번지기 전에 잡을 수 있어요.",
    refresh: "새로고침",
    recentEvents: "최근 webhook 이벤트",
    failedCount: (count: number) => `실패 ${count}건`,
    replayed: "다시 처리함",
    reprocess: "다시 처리",
    empty: { title: "아직 기록된 Stripe webhook 이벤트가 없어요.", detail: "Stripe가 보내면 여기에 보여요." },
    stats: {
      received: "받은 수",
      receivedDetail: (count: number) => `최근 ${count}건`,
      processed: "처리됨",
      failed: "실패",
      failedDetail: "아래에서 하나씩 다시 처리할 수 있어요",
      waiting: "기다리는 중",
    },
    status: { processed: "처리됨", failed: "실패" },
    columns: { event: "이벤트", received: "받은 시각", status: "상태" },
  },
});
