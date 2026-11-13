import type { Language } from "@/components/LanguageProvider";

export type PricingMobilePlanSummaryCopy = {
  lead: string;
  label: string;
  title: string;
  priceNote: string;
  monthlyCredits: (credits: number) => string;
  viewOptions: string;
  viewOptionsLabel: (planName: string) => string;
};

// Phone-only summary shown above the full plan cards so all three prices are
// visible without scrolling past the Free card. Languages without an entry
// keep the cards-only layout.
export const pricingMobilePlanSummaryCopy: Partial<Record<Language, PricingMobilePlanSummaryCopy>> = {
  en: {
    lead: "Compare monthly prices and AI credits, then open a plan’s purchase options.",
    label: "Quick plan comparison",
    title: "Compare plans at a glance",
    priceNote: "Regular monthly prices. Annual billing and offers are in plan options.",
    monthlyCredits: (credits) => `${credits.toLocaleString("en-US")} monthly credits`,
    viewOptions: "View options",
    viewOptionsLabel: (planName) => `View ${planName} plan options`,
  },
  ko: {
    lead: "월 요금과 AI 크레딧을 먼저 비교한 뒤 플랜별 구매 옵션을 열어 보세요.",
    label: "플랜 빠른 비교",
    title: "한눈에 보는 플랜 비교",
    priceNote: "정가 월 요금 기준입니다. 연간 결제와 할인은 플랜 옵션에서 확인하세요.",
    monthlyCredits: (credits) => `월 ${credits.toLocaleString("ko-KR")} 크레딧`,
    viewOptions: "옵션 보기",
    viewOptionsLabel: (planName) => `${planName} 플랜 옵션 보기`,
  },
};
