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
      unreadable: "could not be read",
      generated: (at: string) => `Generated: ${at} UTC`,
      users: (total: number, paid: number, active: number) =>
        `Users: ${total} total / ${paid} paid / ${active} active subscriptions`,
      providers: (available: number, total: number) =>
        `Providers: ${available}/${total} available`,
      monthlySpend: (spend: string) => `Estimated monthly spend: ${spend}`,
      // `number | string` so an unread count reaches the pasted report as the
      // words "could not be read" rather than as a zero somebody will quote.
      openFeedback: (count: number | string) => `Open feedback: ${count}`,
      pendingRefunds: (count: number | string) => `Pending refunds: ${count}`,
      usersUnreadable: "Users: could not be read",
      providersUnreadable: "Providers: could not be read",
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
      explainScore: "How this score was worked out",
      environmentBlocking: (count: number) =>
        `${count} of them ${count === 1 ? "is" : "are"} blocking. The rest are listed so you can see them, and cost nothing.`,
      environmentNoneBlocking:
        "None of them are blocking. They are listed so you can see them, and cost nothing.",
      processStartedNote: (at: string) =>
        `Read from the process that started at ${at} UTC. A variable added to the host after that is not visible here until the service is redeployed — refreshing re-renders inside the same process.`,
      unreadable: "Could not be read",
      unreadableDetail:
        "This read failed. The figure is unknown, which is not the same as zero.",
      readsFailedTitle: (count: number) =>
        `${count} of this page's reads did not come back`,
      readsFailedDetail: (names: string) =>
        `${names}. Every other figure on this page is current; the ones above marked "Could not be read" are the only ones affected. Refresh to try again — a read that keeps failing is worth looking at rather than waiting out.`,
      healthScoreIncomplete: "Ceiling — some inputs unread",
      readName: {
        providerHealth: "Provider health",
        userStats: "Account statistics",
        billingPlans: "Plan price list",
        activePlanGroups: "Active plan mix",
        todayUsage: "Usage today",
        monthlyUsage: "Usage this month",
        openFeedback: "Open feedback",
        pendingRefunds: "Pending refunds",
        approvedRefunds: "Approved refunds",
        promotionRedemptions: "Promotion redemptions",
        alertFailures: "Alert failures",
        recentActivity: "Recent administrator activity",
      },
    },
    health: {
      title: "How this score was worked out",
      subtitle:
        "Every deduction, what produced it, and what to do about it. Nothing here is new information -- it is the arithmetic the Overview card performs.",
      backToSummary: "Back to the operations snapshot",
      score: (score: number) => `${score} out of 100`,
      formula: (total: number) => `100 − ${total} deducted`,
      perfect: "Nothing is deducting. Every input read cleanly and every one came back at zero.",
      flooredTitle: "The score has bottomed out",
      floored: (total: number) =>
        `Deductions come to ${total}, past the 100 the score starts from, so it is held at zero. While it is here a new outage moves nothing -- the number is least informative exactly when the most is wrong. Read the lines below rather than the number.`,
      incompleteTitle: "This score is a ceiling, not a reading",
      incomplete: (factors: string) =>
        `${factors} could not be read. An unreadable input deducts nothing rather than counting as zero, so the real score is this one or lower.`,
      unknownCount: "Could not be read",
      tableCaption: "Every factor, whether or not it is currently deducting",
      columnFactor: "Factor",
      columnCount: "Count",
      columnWeight: "Each",
      columnDeduction: "Deducted",
      columnAction: "What to do",
      noDeduction: "Nothing to do.",
      factors: {
        outage: "Providers in outage",
        limited: "Providers running limited",
        blockingEnv: "Blocking configuration",
        alertFailure: "Unacknowledged alert failures",
        pendingRefund: "Refund requests waiting",
        openFeedback: "Open feedback",
      },
      actions: {
        outage: "Open the provider that is down, resolve the incident or point traffic at a fallback model.",
        limited: "Check why the provider is rate-limited or degraded before it becomes an outage.",
        blockingEnv: "Set the variables under Required below, then redeploy so the running process picks them up.",
        alertFailure: "Read the failed notifications and acknowledge them once the underlying send is fixed.",
        pendingRefund: "Approve or reject the waiting refund requests.",
        openFeedback: "Work through the reports users filed.",
      },
      notCountedTitle: "What is deliberately not counted",
      notCounted:
        "Conditional, recommended and optional variables never deduct. A conditional one is needed only when a runtime condition holds, and this deployment cannot tell whether it does; a recommended one costs observability, not users; an optional one costs nothing. They are all listed below so nothing is hidden -- they are simply not priced.",
      environmentTitle: "Environment variables, by what their absence costs",
      groupRequired: "Required — deducting now",
      groupRequiredDetail: (weight: number) =>
        `Something is broken or unprotected until these are set. Each costs ${weight} points.`,
      groupConditional: "Conditional — not deducting",
      groupConditionalDetail:
        "Needed only when the named condition holds. The environment cannot answer whether it does, so this is a decision rather than a task.",
      groupRecommended: "Recommended — not deducting",
      groupRecommendedDetail:
        "Reporting or error retention is degraded. No user meets this.",
      groupOptional: "Optional — not deducting",
      groupOptionalDetail: "Nothing is lost by leaving these unset.",
      groupEmpty: "Nothing in this group.",
      conditionLabel: "Condition",
      processTitle: "What this page can and cannot see",
      processStarted: (at: string) =>
        `The process answering this request started at ${at} UTC.`,
      processCaveat:
        "It reads the environment it was started with. A variable added to the deployment host after that time is not visible here and refreshing will not bring it in -- the refresh re-renders inside this same process. If a variable is set on the host and reported missing here, redeploy or restart the service and read this page again.",
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
      unreadable: "읽지 못함",
      generated: (at: string) => `생성 시각: ${at} UTC`,
      users: (total: number, paid: number, active: number) =>
        `사용자: 전체 ${total}명 / 유료 ${paid}명 / 활성 구독 ${active}건`,
      providers: (available: number, total: number) =>
        `공급자: ${available}/${total} 정상`,
      monthlySpend: (spend: string) => `예상 월 비용: ${spend}`,
      openFeedback: (count: number | string) => `미처리 피드백: ${count}`,
      pendingRefunds: (count: number | string) => `대기 중인 환불: ${count}`,
      usersUnreadable: "사용자: 읽지 못함",
      providersUnreadable: "공급자: 읽지 못함",
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
      explainScore: "이 점수가 나온 계산 보기",
      environmentBlocking: (count: number) =>
        `그중 ${count}개가 조치 대상입니다. 나머지는 확인하실 수 있도록 함께 적었을 뿐 점수에 반영되지 않습니다.`,
      environmentNoneBlocking:
        "조치가 필요한 것은 없습니다. 나머지는 확인하실 수 있도록 함께 적었을 뿐 점수에 반영되지 않습니다.",
      processStartedNote: (at: string) =>
        `${at} UTC에 시작한 프로세스가 읽은 값입니다. 그 이후 호스트에 추가한 변수는 재배포 전까지 여기 보이지 않습니다 — 새로고침은 같은 프로세스 안에서 다시 그릴 뿐입니다.`,
      unreadable: "읽지 못함",
      unreadableDetail:
        "이 값을 읽지 못했습니다. 모르는 것이지 0이 아닙니다.",
      readsFailedTitle: (count: number) =>
        `이 화면의 조회 ${count}건이 돌아오지 않았습니다`,
      readsFailedDetail: (names: string) =>
        `${names}. 나머지 값은 모두 현재 값이며, 위에서 "읽지 못함"으로 표시된 것만 영향을 받았습니다. 새로고침으로 다시 시도할 수 있습니다 — 계속 실패한다면 기다릴 일이 아니라 확인할 일입니다.`,
      healthScoreIncomplete: "상한 — 일부 입력 미조회",
      readName: {
        providerHealth: "Provider 상태",
        userStats: "계정 통계",
        billingPlans: "플랜 가격표",
        activePlanGroups: "활성 플랜 구성",
        todayUsage: "오늘 사용량",
        monthlyUsage: "이번 달 사용량",
        openFeedback: "미처리 피드백",
        pendingRefunds: "대기 중인 환불",
        approvedRefunds: "승인된 환불",
        promotionRedemptions: "프로모션 상환",
        alertFailures: "알림 발송 실패",
        recentActivity: "최근 관리자 활동",
      },
    },
    health: {
      title: "이 점수가 나온 계산",
      subtitle:
        "감점 하나하나가 무엇에서 나왔고 무엇을 하면 되는지입니다. 새로운 정보는 없고, 개요 카드가 하는 계산을 펼쳐 놓은 것입니다.",
      backToSummary: "운영 스냅샷으로 돌아가기",
      score: (score: number) => `100점 만점에 ${score}점`,
      formula: (total: number) => `100 − ${total} 감점`,
      perfect: "감점이 없습니다. 모든 입력을 정상적으로 읽었고 전부 0이었습니다.",
      flooredTitle: "점수가 바닥에 닿았습니다",
      floored: (total: number) =>
        `감점 합계가 ${total}점으로 시작점인 100을 넘어서 0에서 멈춰 있습니다. 이 상태에서는 새 장애가 생겨도 숫자가 움직이지 않습니다 — 가장 많이 잘못됐을 때 이 숫자가 가장 쓸모없어집니다. 숫자 대신 아래 항목들을 보십시오.`,
      incompleteTitle: "이 점수는 실측이 아니라 상한입니다",
      incomplete: (factors: string) =>
        `${factors} 항목을 읽지 못했습니다. 읽지 못한 입력은 0으로 세지 않고 감점도 하지 않으므로, 실제 점수는 이 값이거나 이보다 낮습니다.`,
      unknownCount: "읽지 못함",
      tableCaption: "지금 감점 중인지와 무관하게, 모든 항목",
      columnFactor: "항목",
      columnCount: "개수",
      columnWeight: "개당",
      columnDeduction: "감점",
      columnAction: "조치",
      noDeduction: "조치할 것이 없습니다.",
      factors: {
        outage: "장애 상태 provider",
        limited: "제한 상태 provider",
        blockingEnv: "조치가 필요한 환경변수",
        alertFailure: "미확인 알림 발송 실패",
        pendingRefund: "대기 중인 환불 요청",
        openFeedback: "미처리 피드백",
      },
      actions: {
        outage: "해당 provider를 열어 인시던트를 해결하거나 트래픽을 fallback 모델로 돌립니다.",
        limited: "장애로 번지기 전에 rate limit이나 성능 저하의 원인을 확인합니다.",
        blockingEnv: "아래 '필수' 목록의 변수를 설정한 뒤, 실행 중인 프로세스가 읽도록 재배포합니다.",
        alertFailure: "실패한 알림을 읽고, 원인이 해결되면 확인 처리합니다.",
        pendingRefund: "대기 중인 환불 요청을 승인하거나 거절합니다.",
        openFeedback: "사용자가 남긴 신고를 처리합니다.",
      },
      notCountedTitle: "의도적으로 세지 않는 것",
      notCounted:
        "조건부·권장·선택 변수는 감점하지 않습니다. 조건부는 런타임 조건이 성립할 때만 필요한데 이 배포는 그 조건의 성립 여부를 알 수 없고, 권장은 관측이 아쉬워질 뿐 사용자가 마주치지 않으며, 선택은 없어도 잃는 것이 없습니다. 감추지 않으려고 아래에 전부 적었을 뿐, 값을 매기지 않았습니다.",
      environmentTitle: "환경변수 — 없을 때 무엇을 잃는지 기준",
      groupRequired: "필수 — 지금 감점 중",
      groupRequiredDetail: (weight: number) =>
        `설정하기 전까지 무언가가 고장 나 있거나 보호되지 않습니다. 개당 ${weight}점입니다.`,
      groupConditional: "조건부 — 감점 없음",
      groupConditionalDetail:
        "명시된 조건이 성립할 때만 필요합니다. 그 성립 여부는 환경변수가 답할 수 있는 사실이 아니므로, 작업이 아니라 결정의 대상입니다.",
      groupRecommended: "권장 — 감점 없음",
      groupRecommendedDetail:
        "보고나 오류 보존이 약해집니다. 사용자가 마주치는 것은 없습니다.",
      groupOptional: "선택 — 감점 없음",
      groupOptionalDetail: "설정하지 않아도 잃는 것이 없습니다.",
      groupEmpty: "이 분류에 해당하는 항목이 없습니다.",
      conditionLabel: "조건",
      processTitle: "이 화면이 볼 수 있는 것과 없는 것",
      processStarted: (at: string) =>
        `이 요청에 답한 프로세스는 ${at} UTC에 시작했습니다.`,
      processCaveat:
        "프로세스는 시작할 때 주어진 환경만 읽습니다. 그 시각 이후에 배포 호스트에 추가한 변수는 여기 보이지 않고, 새로고침해도 들어오지 않습니다 — 새로고침은 같은 프로세스 안에서 다시 그릴 뿐입니다. 호스트에는 설정돼 있는데 여기서 미설정으로 보인다면, 서비스를 재배포하거나 재시작한 뒤 이 화면을 다시 보십시오.",
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
