import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the delivery log and the suppression list. */
export const adminEmailDeliveryMessages = defineAdminMessages({
  en: {
    eyebrow: "Email",
    deliveries: {
      title: "Deliveries",
      intro:
        "Every message the outbox has handled, and what became of it. Abandoned rows are the dead-letter queue — they stay here with their attempt count and error rather than moving somewhere that loses both.",
      filtersLabel: "Delivery status filters",
      didNotArrive: "Did not arrive",
      scope: (count: number, statuses: string) =>
        `Showing ${count} row${count === 1 ? "" : "s"} in ${statuses}.`,
      hiddenRows: (count: number) =>
        ` ${count} row${count === 1 ? "" : "s"} in other statuses are not shown.`,
      columns: {
        status: "Status",
        template: "Template",
        recipient: "Recipient",
        attempts: "Attempts",
        lastError: "Last error",
        created: "Created",
      },
      empty: "Nothing in these statuses.",
      older: "Older",
    },
    suppressions: {
      title: "Suppressions",
      intro:
        "Addresses this system will not send to. A hard bounce or a complaint has no expiry; a soft bounce holds for a day. Lifting one is audited and needs a written reason, and lifting a hard bounce or a complaint needs a second administrator.",
      providerNotice:
        "This is our list, not the provider's. Resend keeps its own suppression list across the whole account and region, so an address removed here can still be refused there — and a promotion's complaint can refuse a login code no matter what this table says.",
      columns: {
        address: "Address",
        reason: "Reason",
        scope: "Scope",
        source: "Source",
        occurred: "Occurred",
        expires: "Expires",
      },
      empty: "No addresses are suppressed.",
      allMail: "all mail",
      never: "never",
    },
  },
  ko: {
    eyebrow: "이메일",
    deliveries: {
      title: "전송",
      intro:
        "outbox가 처리한 모든 메시지와 그 결과입니다. abandoned 행이 dead-letter queue입니다 — 시도 횟수와 오류를 모두 잃는 다른 곳으로 옮기지 않고 그대로 여기에 남습니다.",
      filtersLabel: "전송 상태 필터",
      didNotArrive: "도착하지 않음",
      scope: (count: number, statuses: string) =>
        `${statuses} 상태의 행 ${count}개를 표시합니다.`,
      hiddenRows: (count: number) =>
        ` 다른 상태의 행 ${count}개는 표시하지 않습니다.`,
      columns: {
        status: "상태",
        template: "템플릿",
        recipient: "수신자",
        attempts: "시도",
        lastError: "마지막 오류",
        created: "생성",
      },
      empty: "이 상태에 해당하는 항목이 없습니다.",
      older: "이전 항목",
    },
    suppressions: {
      title: "수신 차단",
      intro:
        "이 시스템이 메일을 보내지 않는 주소입니다. hard bounce나 스팸 신고(complaint)는 만료되지 않고, soft bounce는 하루 동안 유지됩니다. 차단 해제는 감사 로그에 남고 사유를 적어야 하며, hard bounce나 스팸 신고로 인한 차단을 해제하려면 두 번째 관리자가 필요합니다.",
      providerNotice:
        "이 목록은 공급자의 목록이 아니라 우리 목록입니다. Resend는 계정과 region 전체에 걸쳐 자체 수신 차단 목록을 유지하므로, 여기서 제거한 주소도 그쪽에서 여전히 거절될 수 있습니다 — 그리고 프로모션 메일의 스팸 신고 하나가 이 표와 상관없이 로그인 코드 발송을 막을 수 있습니다.",
      columns: {
        address: "주소",
        reason: "사유",
        scope: "범위",
        source: "출처",
        occurred: "발생",
        expires: "만료",
      },
      empty: "수신 차단된 주소가 없습니다.",
      allMail: "모든 메일",
      never: "없음",
    },
  },
});
