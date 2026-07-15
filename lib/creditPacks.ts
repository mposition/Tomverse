import type { ModelTier } from "@/lib/models";

export type CreditPackId = "starter_500" | "project_1500" | "power_4000";

export type CreditPack = {
  id: CreditPackId;
  name: string;
  credits: number;
  priceCents: number;
  currency: "USD";
  fundedCostMicroUsd: number;
  validityDays: number;
  allowedPlans: ModelTier[];
  stripePriceId: string | null;
};

const positiveInteger = (value: string | undefined, fallback: number) => {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export const CREDIT_PACKS: readonly CreditPack[] = [
  {
    id: "starter_500",
    name: "Starter Credit Pack",
    credits: 500,
    priceCents: positiveInteger(
      process.env.CREDIT_PACK_STARTER_500_PRICE_CENTS,
      499
    ),
    currency: "USD",
    fundedCostMicroUsd: positiveInteger(
      process.env.CREDIT_PACK_STARTER_500_COST_MICROUSD,
      750_000
    ),
    validityDays: 365,
    allowedPlans: ["Free"],
    stripePriceId: process.env.STRIPE_CREDIT_PACK_STARTER_500_PRICE_ID || null,
  },
  {
    id: "project_1500",
    name: "Project Credit Pack",
    credits: 1_500,
    priceCents: positiveInteger(
      process.env.CREDIT_PACK_PROJECT_1500_PRICE_CENTS,
      999
    ),
    currency: "USD",
    fundedCostMicroUsd: positiveInteger(
      process.env.CREDIT_PACK_PROJECT_1500_COST_MICROUSD,
      2_500_000
    ),
    validityDays: 365,
    allowedPlans: ["Pro", "Max"],
    stripePriceId: process.env.STRIPE_CREDIT_PACK_PROJECT_1500_PRICE_ID || null,
  },
  {
    id: "power_4000",
    name: "Power Credit Pack",
    credits: 4_000,
    priceCents: positiveInteger(
      process.env.CREDIT_PACK_POWER_4000_PRICE_CENTS,
      1_999
    ),
    currency: "USD",
    fundedCostMicroUsd: positiveInteger(
      process.env.CREDIT_PACK_POWER_4000_COST_MICROUSD,
      6_000_000
    ),
    validityDays: 365,
    allowedPlans: ["Pro", "Max"],
    stripePriceId: process.env.STRIPE_CREDIT_PACK_POWER_4000_PRICE_ID || null,
  },
] as const;

export type PublicCreditPack = Pick<
  CreditPack,
  "id" | "name" | "credits" | "priceCents" | "currency" | "validityDays" | "allowedPlans"
>;

export const getPublicCreditPackCatalog = (): PublicCreditPack[] =>
  CREDIT_PACKS.map(
    ({ id, name, credits, priceCents, currency, validityDays, allowedPlans }) => ({
      id,
      name,
      credits,
      priceCents,
      currency,
      validityDays,
      allowedPlans: [...allowedPlans],
    })
  );

export const getCreditPack = (id: string) =>
  CREDIT_PACKS.find((pack) => pack.id === id);

export const getCreditPacksForPlan = (plan: ModelTier) =>
  CREDIT_PACKS.filter((pack) => pack.allowedPlans.includes(plan));

export type CreditRecommendation =
  | "upgrade_pro"
  | "upgrade_max"
  | "add_credits"
  | "business";

export const recommendCreditAction = ({
  plan,
  monthlyUsagePercents,
  addOnPurchasesLast90Days,
}: {
  plan: ModelTier;
  monthlyUsagePercents: number[];
  addOnPurchasesLast90Days: number;
}): { primary: CreditRecommendation; secondary: CreditRecommendation | null } => {
  if (plan === "Free") {
    return { primary: "upgrade_pro", secondary: "add_credits" };
  }
  const highUsageMonths = monthlyUsagePercents.filter((value) => value >= 80).length;
  const exhaustedMonths = monthlyUsagePercents.filter((value) => value >= 100).length;
  if (plan === "Pro") {
    return highUsageMonths >= 2 || addOnPurchasesLast90Days >= 2
      ? { primary: "upgrade_max", secondary: "add_credits" }
      : { primary: "add_credits", secondary: "upgrade_max" };
  }
  return exhaustedMonths >= 2 || addOnPurchasesLast90Days >= 2
    ? { primary: "add_credits", secondary: "business" }
    : { primary: "add_credits", secondary: null };
};
