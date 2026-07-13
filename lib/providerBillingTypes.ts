export type ProviderPricingModel =
  | "usage_based"
  | "subscription"
  | "committed_capacity"
  | "unknown";

export type ProviderSettlementModel =
  | "prepaid"
  | "postpaid"
  | "hybrid"
  | "invoice"
  | "unknown";

export type ProviderBillingSource =
  | "provider_api"
  | "admin_verified"
  | "documented_default";

export type ProviderBillingProfile = {
  pricingModel: ProviderPricingModel;
  settlementModel: ProviderSettlementModel;
  source: ProviderBillingSource;
  currency: string;
  monthlyLimitMicroUsd: number | null;
  verifiedAt: string | null;
  note: string | null;
  isPersisted: boolean;
};
