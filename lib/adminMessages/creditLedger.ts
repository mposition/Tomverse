import { defineAdminMessages } from "@/lib/adminLocale";

/** Copy for the credit ledger panel on `/admin/credit-ledger`. */
export const adminCreditLedgerMessages = defineAdminMessages({
  en: {
    eyebrow: "Credit ledger",
    title: "Recent credit movements",
    description:
      "Reserve, settlement, refund, purchase, expiry, and administrative entries.",
    newestOnly: (limit: number) =>
      ` The ${limit} newest entries only, not a period total.`,
    openCustomer: " Open a customer for the complete account timeline.",
    latest: (count: number) => `Latest ${count}`,
    columns: {
      created: "Created",
      customer: "Customer",
      type: "Type",
      change: "Change",
      balance: "Balance",
      fundedCost: "Funded cost",
      reservation: "Reservation",
    },
    empty: "No credit ledger entries have been recorded.",
  },
  ko: {
    eyebrow: "크레딧 원장",
    title: "최근 크레딧 변동",
    description: "예약, 정산, 환불, 구매, 만료, 관리자 조정 항목입니다.",
    newestOnly: (limit: number) =>
      ` 최신 ${limit}건만 표시하며 기간 합계가 아닙니다.`,
    openCustomer: " 계정 전체 타임라인은 고객 상세에서 확인하세요.",
    latest: (count: number) => `최신 ${count}건`,
    columns: {
      created: "생성 시각",
      customer: "고객",
      type: "유형",
      change: "변동",
      balance: "잔액",
      fundedCost: "충당 비용",
      reservation: "예약",
    },
    empty: "기록된 크레딧 원장 항목이 없습니다.",
  },
});
