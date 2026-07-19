export const ADMIN_USER_SEGMENTS = [
  "all",
  "free",
  "pro",
  "max",
  "activePaid",
  "testerPass",
  "canceling",
  "billingRisk",
] as const;

export type AdminUserSegment = (typeof ADMIN_USER_SEGMENTS)[number];

export const normalizeAdminUserSegment = (
  value: string | null | undefined
): AdminUserSegment =>
  ADMIN_USER_SEGMENTS.includes(value as AdminUserSegment)
    ? (value as AdminUserSegment)
    : "all";

export type AdminUserStats = {
  generatedAt: string;
  totalAccounts: number;
  freeUsers: number;
  proUsers: number;
  maxUsers: number;
  activePaidSubscriptions: number;
  testerPassUsers: number;
  cancelingSubscriptions: number;
  billingRiskUsers: number;
  newUsers7d: number;
  newUsers30d: number;
  paidConversionRatePercent: number;
};

export type AdminUserRow = {
  id: string;
  email: string | null;
  name: string | null;
  plan: string | null;
  createdAt: string | null;
  subscriptionStatus: string | null;
  subscriptionCurrentPeriodEnd: string | null;
  subscriptionBillingInterval: string | null;
  subscriptionCancelAtPeriodEnd: boolean;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  timeZone: string;
  messagesToday: number;
  creditsToday: number;
  creditDebtCredits: number;
  creditDebtCostMicroUsd: number;
  billingRiskStatus: string;
  _count: {
    conversations: number;
    accounts: number;
    refundRequests: number;
    promotionRedemptions: number;
  };
};

export type AdminUsersPage = {
  users: AdminUserRow[];
  nextCursor: string | null;
};
