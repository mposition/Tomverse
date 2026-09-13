import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the Overview page, its summary sections and snapshot actions. */
export const adminOverviewMessages = defineAdminMessages({
  en: {
    providerStatus: {
      available: "Available",
      limited: "Limited",
      outage: "Outage",
    },
    attention: {
      providerStatus: (provider: string, status: string) => `${provider} is ${status}`,
      apiKeyMissing: (provider: string) => `${provider} API key missing`,
      apiKeyMissingDetail:
        "Provider calls will fail or remain unavailable until the key is configured.",
      openFeedback: (count: number) =>
        `${count} open feedback item${count === 1 ? "" : "s"}`,
      openFeedbackDetail: "Review user-reported issues before launch traffic grows.",
      pendingRefunds: (count: number) =>
        `${count} pending refund request${count === 1 ? "" : "s"}`,
      pendingRefundsDetail:
        "Review billing cancellation requests and approve or reject them before renewal disputes grow.",
    },
    report: {
      title: "Tomverse Admin Snapshot",
      generated: (at: string) => `Generated: ${at} UTC`,
      users: (total: number, paid: number, active: number) =>
        `Users: ${total} total / ${paid} paid / ${active} active subscriptions`,
      providers: (available: number, total: number) =>
        `Providers: ${available}/${total} available`,
      monthlySpend: (spend: string) => `Estimated monthly spend: ${spend}`,
      openFeedback: (count: number) => `Open feedback: ${count}`,
      pendingRefunds: (count: number) => `Pending refunds: ${count}`,
      missingEnv: (names: string) => `Missing environment setup: ${names}`,
      none: "none",
      needsAttention: "Needs attention:",
      noAttentionItems: "- none",
    },
    kpi: {
      users: "Users",
      usersDetail: (paid: number, active: number) =>
        `${paid} paid · ${active} active subscriptions`,
      workQueue: "Work queue",
      workQueueDetail: (feedback: number, refunds: number) =>
        `${feedback} feedback / ${refunds} refunds`,
      providers: "Providers",
      providersDetail: (limited: number, outage: number) =>
        `${limited} limited · ${outage} outage`,
      monthlySpend: "Monthly spend",
      monthlySpendDetail: (today: number | bigint, month: number | bigint) =>
        `Estimated from reserved token budgets. ${today} plan credits today, ${month} this month (UTC).`,
      estimatedMrr: "Estimated MRR",
      estimatedMrrDetail: "Calculated from active Pro and Max monthly list prices.",
      paidConversion: "Paid conversion",
      paidConversionDetail: (paid: number, total: number) =>
        `${paid} active paid users out of ${total} total accounts.`,
      planMix: "Plan mix",
      planMixDetail: "Active Pro / Max subscriptions.",
      promoRedemptions: "Promo redemptions",
      promoRedemptionsDetail: "Total redeemed promotion records in the database.",
      churnWatch: "Churn watch",
      churnWatchDetail: (refundRate: string) =>
        `Cancel at period end. Approved refund rate ${refundRate}.`,
    },
    summary: {
      snapshotTitle: "Operations snapshot",
      generated: (generatedAt: string, role: string) =>
        `Generated ${generatedAt} UTC · signed in as ${role}.`,
      healthScore: "Health score",
      healthScoreDetail:
        "Readiness out of 100, weighted by outages, queue depth, and missing configuration.",
      revenueTitle: "Revenue and retention snapshot",
      revenueDescription:
        "Paid conversion, active plan mix, promotions, refunds, and subscriptions scheduled to cancel.",
      launchQueueTitle: "Launch readiness queue",
      openWorkQueue: "Open work queue",
      launchQueueDescription:
        "The highest-signal items to review before they become user-facing incidents. Capped at six; the work queue lists every open item.",
      noIssues: "No immediate operational issues detected.",
      environmentTitle: "Environment health",
      environmentAllConfigured: (total: number) =>
        `All ${total} tracked variables are configured.`,
      environmentMissing: (missing: number, total: number) =>
        `${missing} of ${total} tracked variables are not configured.`,
      showAllVariables: (total: number) => `Show all ${total} tracked variables`,
      configured: "Configured",
      notConfigured: "Not configured",
      latestChangesTitle: "Latest administrator changes",
      openAuditLog: "Open audit log",
      latestChangesDescription: (limit: number) =>
        `The ${limit} most recent audit entries, newest first. Not a count of all administrator activity.`,
      noActivity: "No administrator activity has been recorded yet.",
      fallbackActor: "Administrator",
    },
    snapshotActions: {
      copied: "Admin snapshot copied.",
      copyFailed: "Could not copy admin snapshot.",
      sendFailed: "Could not send test email.",
      sentWithId: (id: string) => `Test email sent. Resend ID: ${id}`,
      sent: "Test email sent.",
      copySnapshot: "Copy snapshot",
      sending: "Sending...",
      sendTestEmail: "Send test email",
    },
  },
  ko: {
    providerStatus: {
      available: "정상",
      limited: "제한됨",
      outage: "장애",
    },
    attention: {
      providerStatus: (provider: string, status: string) => `${provider} 상태: ${status}`,
      apiKeyMissing: (provider: string) => `${provider} API key 없음`,
      apiKeyMissingDetail:
        "key를 설정하기 전까지 공급자 호출이 실패하거나 사용할 수 없는 상태로 남습니다.",
      openFeedback: (count: number) => `미처리 피드백 ${count}건`,
      openFeedbackDetail: "출시 트래픽이 늘기 전에 사용자가 신고한 문제를 검토하세요.",
      pendingRefunds: (count: number) => `대기 중인 환불 요청 ${count}건`,
      pendingRefundsDetail:
        "갱신 분쟁이 커지기 전에 결제 취소 요청을 검토하고 승인하거나 거절하세요.",
    },
    report: {
      title: "Tomverse 관리자 스냅샷",
      generated: (at: string) => `생성 시각: ${at} UTC`,
      users: (total: number, paid: number, active: number) =>
        `사용자: 전체 ${total}명 / 유료 ${paid}명 / 활성 구독 ${active}건`,
      providers: (available: number, total: number) =>
        `공급자: ${available}/${total} 정상`,
      monthlySpend: (spend: string) => `예상 월 비용: ${spend}`,
      openFeedback: (count: number) => `미처리 피드백: ${count}건`,
      pendingRefunds: (count: number) => `대기 중인 환불: ${count}건`,
      missingEnv: (names: string) => `누락된 환경 설정: ${names}`,
      none: "없음",
      needsAttention: "확인 필요:",
      noAttentionItems: "- 없음",
    },
    kpi: {
      users: "사용자",
      usersDetail: (paid: number, active: number) =>
        `유료 ${paid}명 · 활성 구독 ${active}건`,
      workQueue: "작업 대기열",
      workQueueDetail: (feedback: number, refunds: number) =>
        `피드백 ${feedback}건 / 환불 ${refunds}건`,
      providers: "공급자",
      providersDetail: (limited: number, outage: number) =>
        `제한 ${limited}개 · 장애 ${outage}개`,
      monthlySpend: "월 비용",
      monthlySpendDetail: (today: number | bigint, month: number | bigint) =>
        `예약된 token 예산 기준 추정치입니다. 플랜 크레딧 오늘 ${today}, 이번 달 ${month} (UTC).`,
      estimatedMrr: "예상 MRR",
      estimatedMrrDetail: "활성 Pro·Max 구독의 월간 정가로 계산했습니다.",
      paidConversion: "유료 전환율",
      paidConversionDetail: (paid: number, total: number) =>
        `전체 계정 ${total}개 중 활성 유료 사용자 ${paid}명.`,
      planMix: "플랜 구성",
      planMixDetail: "활성 Pro / Max 구독.",
      promoRedemptions: "프로모션 사용",
      promoRedemptionsDetail: "데이터베이스에 기록된 프로모션 사용 건수 전체.",
      churnWatch: "이탈 주시",
      churnWatchDetail: (refundRate: string) =>
        `기간 종료 시 해지 예정. 승인된 환불 비율 ${refundRate}.`,
    },
    summary: {
      snapshotTitle: "운영 스냅샷",
      generated: (generatedAt: string, role: string) =>
        `${generatedAt} UTC 생성 · ${role} 역할로 로그인.`,
      healthScore: "상태 점수",
      healthScoreDetail:
        "100점 만점의 준비도로, 장애·대기열 적체·누락된 설정에 가중치를 둡니다.",
      revenueTitle: "매출·유지 스냅샷",
      revenueDescription:
        "유료 전환, 활성 플랜 구성, 프로모션, 환불, 해지 예정 구독.",
      launchQueueTitle: "출시 준비 대기열",
      openWorkQueue: "작업 대기열 열기",
      launchQueueDescription:
        "사용자에게 드러나는 장애가 되기 전에 검토할 가장 중요한 항목입니다. 최대 6개까지 표시하며, 미처리 항목 전체는 작업 대기열에 있습니다.",
      noIssues: "즉시 조치할 운영 문제가 발견되지 않았습니다.",
      environmentTitle: "환경 설정 상태",
      environmentAllConfigured: (total: number) =>
        `추적 중인 변수 ${total}개가 모두 설정되어 있습니다.`,
      environmentMissing: (missing: number, total: number) =>
        `추적 중인 변수 ${total}개 중 ${missing}개가 설정되지 않았습니다.`,
      showAllVariables: (total: number) => `추적 중인 변수 ${total}개 모두 보기`,
      configured: "설정됨",
      notConfigured: "설정되지 않음",
      latestChangesTitle: "최근 관리자 변경",
      openAuditLog: "감사 로그 열기",
      latestChangesDescription: (limit: number) =>
        `최근 감사 로그 항목 ${limit}건, 최신순. 전체 관리자 활동 건수가 아닙니다.`,
      noActivity: "아직 기록된 관리자 활동이 없습니다.",
      fallbackActor: "관리자",
    },
    snapshotActions: {
      copied: "관리자 스냅샷을 복사했습니다.",
      copyFailed: "관리자 스냅샷을 복사하지 못했습니다.",
      sendFailed: "테스트 이메일을 보내지 못했습니다.",
      sentWithId: (id: string) => `테스트 이메일을 보냈습니다. Resend ID: ${id}`,
      sent: "테스트 이메일을 보냈습니다.",
      copySnapshot: "스냅샷 복사",
      sending: "보내는 중...",
      sendTestEmail: "테스트 이메일 보내기",
    },
  },
});
