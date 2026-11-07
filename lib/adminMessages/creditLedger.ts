import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the credit ledger on `/admin/credit-ledger`. */
export const adminCreditLedgerMessages = defineAdminMessages({
  en: {
    readFailed: {
      title: "Could not read the credit ledger",
      detail:
        "Nothing is shown because the read failed, not because no credits moved. Reload the page to try again.",
    },
    cards: {
      basis: (count: number) =>
        `The first three figures add up the ${count} entries read below. They are not period totals.`,
      granted: "Granted",
      grantedNone: "No grants in these entries",
      used: "Used",
      usedDetail: "Held for AI work, minus credits handed back",
      expired: "Expired",
      expiredDetail: "Credits that ran out of time",
      owed: "Credits owed",
      owedDetail: (customers: number) =>
        `${customers} ${customers === 1 ? "customer owes" : "customers owe"} credits, across all accounts`,
    },
    flow: {
      title: "Daily credit flow",
      description:
        "Above the line, credits granted. Below it, credits used. Days follow Brisbane time.",
      partial: "Only the newest entries are read, so the oldest day can be partial.",
      granted: "Granted",
      used: "Used",
      chartLabel: (days: number) => `Credits granted and used for each of ${days} days`,
    },
    table: {
      title: "Recent credit movements",
      description:
        "Reserve, settlement, refund, purchase, expiry, and administrative entries.",
      newestOnly: (limit: number) =>
        ` The ${limit} newest entries only, not a period total.`,
      openCustomer: " Open a customer for the complete account timeline.",
      caption: "Credit ledger entries",
    },
    filters: {
      label: "Filter by entry type",
      all: "All",
      searchLabel: "Find by customer",
      searchPlaceholder: "Find by customer",
      noMatch: {
        title: "No entries match",
        detail: "Change the type or the customer to see more of the entries read.",
      },
    },
    columns: {
      created: "Time",
      customer: "Customer",
      type: "Type",
      detail: "Detail",
      change: "Change",
      balance: "Lot balance",
    },
    detail: {
      reservation: (id: string) => `Reservation ${id}`,
      fundedCost: (usd: string) => `Funded cost ${usd}`,
    },
    types: {
      settle: "Settlement",
      reserve: "Reserve",
      refund: "Returned",
      purchase: "Purchase",
      payment_refund: "Refund clawback",
      chargeback: "Chargeback",
      admin_adjustment: "Admin adjustment",
      expire: "Expiry",
      debt_offset: "Debt offset",
      dispute_reinstatement: "Dispute reinstated",
    },
    empty: {
      title: "No credit ledger entries",
      detail: "No credit movement has been recorded yet.",
    },
  },
  ko: {
    readFailed: {
      title: "크레딧 원장을 읽지 못했어요",
      detail:
        "크레딧 변동이 없는 게 아니라 읽기에 실패해서 아무것도 보여 주지 못해요. 페이지를 새로 고쳐 다시 시도해 주세요.",
    },
    cards: {
      basis: (count: number) =>
        `앞의 세 숫자는 아래에서 읽은 ${count}건을 더한 값이에요. 기간 합계가 아니에요.`,
      granted: "지급",
      grantedNone: "읽은 항목에 지급이 없어요",
      used: "사용",
      usedDetail: "AI 작업에 잡아 둔 크레딧에서 돌려받은 만큼을 뺀 값이에요",
      expired: "만료",
      expiredDetail: "기간이 지나 없어진 크레딧이에요",
      owed: "갚을 크레딧",
      owedDetail: (customers: number) =>
        `전체 계정 기준으로 ${customers}명이 크레딧을 갚아야 해요`,
    },
    flow: {
      title: "하루 크레딧 흐름",
      description:
        "위는 지급, 아래는 사용한 크레딧이에요. 날짜는 브리즈번 시간 기준이에요.",
      partial: "가장 새로운 항목만 읽어서, 가장 오래된 날은 일부만 담겼을 수 있어요.",
      granted: "지급",
      used: "사용",
      chartLabel: (days: number) => `${days}일 동안 날마다 지급하고 사용한 크레딧`,
    },
    table: {
      title: "최근 크레딧 변동",
      description: "예약, 정산, 반환, 구매, 만료, 관리자 조정 항목이에요.",
      newestOnly: (limit: number) =>
        ` 최신 ${limit}건만 보여 주고, 기간 합계가 아니에요.`,
      openCustomer: " 계정 전체 타임라인은 고객 상세에서 확인해 주세요.",
      caption: "크레딧 원장 항목",
    },
    filters: {
      label: "항목 유형으로 걸러 보기",
      all: "전체",
      searchLabel: "고객으로 찾기",
      searchPlaceholder: "고객으로 찾기",
      noMatch: {
        title: "맞는 항목이 없어요",
        detail: "유형이나 고객을 바꾸면 읽은 항목을 더 볼 수 있어요.",
      },
    },
    columns: {
      created: "시각",
      customer: "고객",
      type: "유형",
      detail: "내용",
      change: "변동",
      balance: "묶음 잔액",
    },
    detail: {
      reservation: (id: string) => `예약 ${id}`,
      fundedCost: (usd: string) => `충당 비용 ${usd}`,
    },
    types: {
      settle: "정산",
      reserve: "예약",
      refund: "반환",
      purchase: "구매",
      payment_refund: "환불 회수",
      chargeback: "결제 분쟁 회수",
      admin_adjustment: "관리자 조정",
      expire: "만료",
      debt_offset: "빚 상계",
      dispute_reinstatement: "분쟁 복구",
    },
    empty: {
      title: "크레딧 원장 항목이 없어요",
      detail: "아직 기록된 크레딧 변동이 없어요.",
    },
  },
});
