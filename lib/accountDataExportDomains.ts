// Which account data domains the unified export covers, and why the rest are
// not covered (PRIVACY-02).
//
// Deliberately free of Prisma and of `server-only`, so the registry validator
// can import it. That is the point of the split: the states live in one place,
// docs/policy/tomverse-chat-data-domain-registry.yaml has to agree with them,
// and lib/accountDataExport.ts has to supply a fetcher for every "included"
// one. None of the three can drift from the other two without a check failing.
//
// Three states, and "excluded" always carries its reason. An export that
// silently omits a domain is indistinguishable from one where the domain held
// nothing, so a user cannot tell they were given a partial answer.

export type ExportDomainState = "included" | "excluded" | "unverified";

export type ExportDomainDeclaration = {
  domain: string;
  prismaModel: string;
  state: ExportDomainState;
  /** Required when excluded. */
  exclusionReason?: string;
};

export const EXPORT_DOMAIN_DECLARATIONS: ExportDomainDeclaration[] = [
  { domain: "userSettings", prismaModel: "UserSettings", state: "included" },
  { domain: "userMemorySettings", prismaModel: "UserMemorySettings", state: "included" },
  { domain: "conversation", prismaModel: "Conversation", state: "included" },
  { domain: "conversationProject", prismaModel: "ConversationProject", state: "included" },
  { domain: "memoryItem", prismaModel: "MemoryItem", state: "included" },
  { domain: "billingTransaction", prismaModel: "BillingTransaction", state: "included" },
  { domain: "creditPurchase", prismaModel: "CreditPurchase", state: "included" },
  { domain: "feedback", prismaModel: "Feedback", state: "included" },
  { domain: "privacyRequest", prismaModel: "PrivacyRequest", state: "included" },
  {
    domain: "account",
    prismaModel: "Account",
    state: "excluded",
    exclusionReason:
      "Holds encrypted OAuth access and refresh tokens. Exporting them would hand out live credentials for the user's Google, Microsoft or Apple account.",
  },
  {
    domain: "session",
    prismaModel: "Session",
    state: "excluded",
    exclusionReason:
      "Session tokens. A copy is a usable session, and the export itself would become a credential.",
  },
  {
    domain: "chatCreditReservation",
    prismaModel: "ChatCreditReservation",
    state: "excluded",
    exclusionReason:
      "Carries Tomverse's provider cost basis in pricingSnapshot and settledCostMicroUsd. What the user was charged is exported through billingTransaction and creditPurchase instead.",
  },
  {
    domain: "imageCreditReservation",
    prismaModel: "ImageCreditReservation",
    state: "excluded",
    exclusionReason:
      "Same provider cost basis as chatCreditReservation.",
  },
  {
    domain: "memoryExtractionCreditReservation",
    prismaModel: "MemoryExtractionCreditReservation",
    state: "excluded",
    exclusionReason:
      "Same provider cost basis as chatCreditReservation.",
  },
  {
    domain: "chatLimitDecisionEvent",
    prismaModel: "ChatLimitDecisionEvent",
    state: "excluded",
    exclusionReason:
      "Internal enforcement telemetry carrying cost estimates and limit thresholds. Purged on its own 90-day retention.",
  },
  {
    domain: "chatContextBundleConsumption",
    prismaModel: "ChatContextBundleConsumption",
    state: "excluded",
    exclusionReason:
      "A short-lived concurrency nonce with no user-meaningful content, deleted at expiresAt.",
  },
  { domain: "comparisonReview", prismaModel: "ComparisonReview", state: "unverified" },
  { domain: "productAnalyticsEvent", prismaModel: "ProductAnalyticsEvent", state: "unverified" },
  { domain: "billingPromotionRedemption", prismaModel: "BillingPromotionRedemption", state: "unverified" },
  { domain: "creditLot", prismaModel: "CreditLot", state: "unverified" },
  { domain: "creditLedgerEntry", prismaModel: "CreditLedgerEntry", state: "unverified" },
  { domain: "creditDebtEntry", prismaModel: "CreditDebtEntry", state: "unverified" },
  { domain: "imageGeneration", prismaModel: "ImageGeneration", state: "unverified" },
  { domain: "imageGenerationGroup", prismaModel: "ImageGenerationGroup", state: "unverified" },
  { domain: "refundRequest", prismaModel: "RefundRequest", state: "unverified" },
  { domain: "planChangeRequest", prismaModel: "PlanChangeRequest", state: "unverified" },
  { domain: "externalImport", prismaModel: "ExternalImport", state: "unverified" },
  { domain: "externalConversation", prismaModel: "ExternalConversation", state: "unverified" },
  { domain: "externalMessage", prismaModel: "ExternalMessage", state: "unverified" },
  { domain: "memoryEvidence", prismaModel: "MemoryEvidence", state: "unverified" },
  { domain: "memoryExtractionRun", prismaModel: "MemoryExtractionRun", state: "unverified" },
];

export const exportDomainState = (domain: string) =>
  EXPORT_DOMAIN_DECLARATIONS.find((declaration) => declaration.domain === domain);
