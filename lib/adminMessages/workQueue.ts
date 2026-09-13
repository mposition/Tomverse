import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the work queue page: the open-work queue and the approvals tab. */
export const adminWorkQueueMessages = defineAdminMessages({
  en: {
    queue: {
      title: "Open work, oldest first",
      itemCount: (count: number) => `${count} item${count === 1 ? "" : "s"}`,
      description:
        "Approvals, refunds, incidents, support, privacy requests, webhooks, alerts and scheduled jobs, ranked by severity and then by age. Each row opens the page that owns the action.",
      failed: (categories: string) =>
        `Could not load ${categories}. This queue is incomplete — do not read it as clear.`,
      truncated: (limit: number, categories: string) =>
        `Showing the ${limit} oldest of ${categories}. Open the owning page for the full list.`,
      empty: "Nothing is waiting on an operator.",
      age: {
        noStartTime: "no start time",
        underAnHour: "under an hour",
        hours: (hours: number) => `${hours}h open`,
        days: (days: number) => `${days}d open`,
      },
      severity: {
        critical: "critical",
        high: "high",
        normal: "normal",
      },
      // Keyed by the category names `lib/adminWorkQueue.ts` emits.
      categories: {
        Approval: "Approval",
        Approvals: "Approvals",
        Refund: "Refund",
        Refunds: "Refunds",
        Incident: "Incident",
        Incidents: "Incidents",
        Feedback: "Feedback",
        Support: "Support",
        Privacy: "Privacy",
        "Privacy requests": "Privacy requests",
        Webhook: "Webhook",
        Webhooks: "Webhooks",
        Model: "Model",
        "Model lifecycle": "Model lifecycle",
        Alert: "Alert",
        Alerts: "Alerts",
        "Scheduled job": "Scheduled job",
      },
    },
    approvals: {
      loadFailed: "Could not load approval queue.",
      updateFailed: "Could not update approval.",
      approvedToast: "Approval approved.",
      rejectedToast: "Approval rejected.",
      eyebrow: "Approval workflow",
      title: "High-risk admin approvals",
      description:
        "A second authorized administrator reviews each exact target and payload. After approval, the original requester must retry the same action before expiry; successful execution consumes it once.",
      pendingCount: (count: number) => `${count} pending`,
      loading: "Loading approvals...",
      empty: "No approval requests yet.",
      status: {
        pending: "pending",
        approved: "approved",
        consumed: "consumed",
        rejected: "rejected",
        expired: "expired",
      },
      noReason: "No reason provided.",
      target: (targetType: string, targetId: string, requester: string) =>
        `Target: ${targetType} ${targetId} / Requested by ${requester}`,
      fallbackAdmin: "admin",
      expires: (date: string) => `Expires ${date} UTC`,
      consumed: (date: string) => ` / Consumed ${date} UTC`,
      reviewed: (date: string, reviewer: string) => `Reviewed ${date} by ${reviewer}`,
      approve: "Approve",
      reject: "Reject",
      awaitingReviewer: "Awaiting another authorized administrator",
      approvedRetry: "Approved · original requester must retry exact action",
    },
  },
  ko: {
    queue: {
      title: "미처리 작업, 오래된 순",
      itemCount: (count: number) => `${count}건`,
      description:
        "승인, 환불, 장애, 고객 지원, 개인정보 요청, webhook, 알림, 예약 작업을 심각도순, 그다음 경과 시간순으로 정렬합니다. 각 행은 해당 조치를 담당하는 페이지를 엽니다.",
      failed: (categories: string) =>
        `${categories} 항목을 불러오지 못했습니다. 이 대기열은 불완전합니다. 처리할 항목이 없다고 판단하지 마세요.`,
      truncated: (limit: number, categories: string) =>
        `${categories} 항목은 오래된 ${limit}건만 표시합니다. 전체 목록은 담당 페이지에서 확인하세요.`,
      empty: "운영자 조치를 기다리는 항목이 없습니다.",
      age: {
        noStartTime: "시작 시각 없음",
        underAnHour: "1시간 미만",
        hours: (hours: number) => `${hours}시간 경과`,
        days: (days: number) => `${days}일 경과`,
      },
      severity: {
        critical: "긴급",
        high: "높음",
        normal: "보통",
      },
      categories: {
        Approval: "승인",
        Approvals: "승인",
        Refund: "환불",
        Refunds: "환불",
        Incident: "장애",
        Incidents: "장애",
        Feedback: "피드백",
        Support: "고객 지원",
        Privacy: "개인정보",
        "Privacy requests": "개인정보 요청",
        Webhook: "Webhook",
        Webhooks: "Webhook",
        Model: "모델",
        "Model lifecycle": "모델 수명주기",
        Alert: "알림",
        Alerts: "알림",
        "Scheduled job": "예약 작업",
      },
    },
    approvals: {
      loadFailed: "승인 대기열을 불러오지 못했습니다.",
      updateFailed: "승인 상태를 변경하지 못했습니다.",
      approvedToast: "승인했습니다.",
      rejectedToast: "거절했습니다.",
      eyebrow: "승인 절차",
      title: "고위험 관리자 작업 승인",
      description:
        "권한이 있는 다른 관리자가 정확한 대상과 payload를 하나씩 검토합니다. 승인 후에는 원래 요청자가 만료 전에 같은 작업을 다시 실행해야 하며, 실행에 성공하면 승인은 한 번만 소비됩니다.",
      pendingCount: (count: number) => `대기 ${count}건`,
      loading: "승인 요청을 불러오는 중...",
      empty: "아직 승인 요청이 없습니다.",
      status: {
        pending: "대기 중",
        approved: "승인됨",
        consumed: "소비됨",
        rejected: "거절됨",
        expired: "만료됨",
      },
      noReason: "사유가 입력되지 않았습니다.",
      target: (targetType: string, targetId: string, requester: string) =>
        `대상: ${targetType} ${targetId} / 요청자 ${requester}`,
      fallbackAdmin: "관리자",
      expires: (date: string) => `만료 ${date} UTC`,
      consumed: (date: string) => ` / 소비 ${date} UTC`,
      reviewed: (date: string, reviewer: string) => `검토 ${date} / 검토자 ${reviewer}`,
      approve: "승인",
      reject: "거절",
      awaitingReviewer: "권한이 있는 다른 관리자의 검토를 기다리는 중",
      approvedRetry: "승인됨 · 원래 요청자가 같은 작업을 다시 실행해야 합니다",
    },
  },
});
