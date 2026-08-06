// Which account data domains the unified export covers, how much of each, and
// why anything is withheld (PRIVACY-02).
//
// Deliberately free of Prisma and of `server-only`, so the registry validator
// can import it. The states live here, the registry YAML has to agree with
// them, and lib/accountDataExport.ts has to supply a fetcher for every domain
// that is exported at all. None of the three can drift without a check failing.
//
// Four states, and the distinction between the middle two is the whole design:
//
//   included          the row is the user's data; they receive all of it.
//   included_filtered the row mixes the user's data with Tomverse's internals,
//                     so they receive a projection and are told what was held
//                     back and why. Excluding the whole table instead would
//                     throw away the point of having a field allowlist -- and
//                     Apple's account-deletion guidance is explicit that
//                     account data is in scope except what must be retained,
//                     with the user told when something is.
//   excluded          nothing in the row is the user's data.
//   unverified        nobody has decided yet. Blocks PRIVACY-02 rather than
//                     being read as safe, and must be zero at the release gate.
//
// `publicName` is what appears in the export. Prisma model names are internal
// and change with refactors; a file a user downloaded two years ago should
// still parse.

export type ExportDomainState = "included" | "included_filtered" | "excluded" | "unverified";

export type ExportDomainDeclaration = {
  domain: string;
  /** Stable name in the exported file. Never a Prisma model name. */
  publicName: string;
  prismaModel: string;
  state: ExportDomainState;
  /** Required when excluded: why the user receives nothing from this table. */
  exclusionReason?: string;
  /** Required when included_filtered: what was held back, and why. */
  withheldReason?: string;
};

export const EXPORT_DOMAIN_DECLARATIONS: ExportDomainDeclaration[] = [
  // --- wholly the user's own data ------------------------------------------
  { domain: "userSettings", publicName: "settings", prismaModel: "UserSettings", state: "included" },
  {
    domain: "userMemorySettings",
    publicName: "memory_settings",
    prismaModel: "UserMemorySettings",
    state: "included",
  },
  { domain: "conversation", publicName: "conversations", prismaModel: "Conversation", state: "included" },
  {
    domain: "conversationProject",
    publicName: "projects",
    prismaModel: "ConversationProject",
    state: "included",
  },
  { domain: "memoryItem", publicName: "memories", prismaModel: "MemoryItem", state: "included" },
  {
    domain: "creditPurchase",
    publicName: "credit_purchases",
    prismaModel: "CreditPurchase",
    state: "included",
  },
  { domain: "feedback", publicName: "feedback", prismaModel: "Feedback", state: "included" },
  {
    domain: "privacyRequest",
    publicName: "privacy_requests",
    prismaModel: "PrivacyRequest",
    state: "included",
  },

  // --- the user's data mixed with Tomverse's internals ----------------------
  {
    domain: "user",
    publicName: "profile",
    prismaModel: "User",
    state: "included_filtered",
    withheldReason:
      "The user's own profile, plan and subscription state. Tomverse's internal signals about them are withheld: the billing risk status and reason, the security incident note, the suspension and AI-restriction reasons and the operator identities behind them, the credit debt balance, and the Stripe customer, subscription and price identifiers.",
  },
  {
    domain: "account",
    publicName: "linked_accounts",
    prismaModel: "Account",
    state: "included_filtered",
    withheldReason:
      "Which providers are linked, and when, is the user's own record. The access, refresh and ID tokens and the OAuth session state are withheld: exporting them would hand out live credentials for the user's Google, Microsoft or Apple account, making the export file itself a credential.",
  },
  {
    domain: "session",
    publicName: "active_sessions",
    prismaModel: "Session",
    state: "included_filtered",
    withheldReason:
      "When a session was created and when it expires is the user's own record. The session token is withheld, because a copy of it is a usable session.",
  },
  {
    domain: "accountDataExportRequest",
    publicName: "data_export_history",
    prismaModel: "AccountDataExportRequest",
    state: "included_filtered",
    withheldReason:
      "When the user requested a download of this file, whether it was collected, and how large it was. The token hash is withheld because it is the credential for that download, and the hashed request context is withheld because it is a pseudonymous identifier for the device rather than a record the user wrote.",
  },
  {
    domain: "billingTransaction",
    publicName: "payments",
    prismaModel: "BillingTransaction",
    state: "included_filtered",
    withheldReason:
      "What the user paid, in what currency and when. Internal risk and reconciliation fields, and the raw Stripe object identifiers, are withheld.",
  },
  {
    domain: "chatCreditReservation",
    publicName: "chat_credit_usage",
    prismaModel: "ChatCreditReservation",
    state: "included_filtered",
    withheldReason:
      "The model, outcome, credits charged and timings are the user's own usage record. Tomverse's provider cost basis -- pricingSnapshot, the micro-USD cost fields, provider request identifiers and internal error text -- is withheld.",
  },
  {
    domain: "imageCreditReservation",
    publicName: "image_credit_usage",
    prismaModel: "ImageCreditReservation",
    state: "included_filtered",
    withheldReason: "Same provider cost basis as chat_credit_usage.",
  },
  {
    domain: "memoryExtractionCreditReservation",
    publicName: "memory_extraction_credit_usage",
    prismaModel: "MemoryExtractionCreditReservation",
    state: "included_filtered",
    withheldReason: "Same provider cost basis as chat_credit_usage.",
  },

  // --- nothing in the row is the user's data --------------------------------
  {
    domain: "chatLimitDecisionEvent",
    publicName: "rate_limit_decisions",
    prismaModel: "ChatLimitDecisionEvent",
    state: "excluded",
    exclusionReason:
      "Internal enforcement telemetry: limit thresholds and cost estimates, with no content the user wrote. Anonymised on account deletion and purged on its own 90-day retention.",
  },
  {
    domain: "chatContextBundleConsumption",
    publicName: "context_bundle_nonces",
    prismaModel: "ChatContextBundleConsumption",
    state: "excluded",
    exclusionReason:
      "A short-lived concurrency nonce with no user-meaningful content, deleted with the account.",
  },
  {
    domain: "routingRun",
    publicName: "routing_observations",
    prismaModel: "RoutingRun",
    state: "excluded",
    exclusionReason:
      "Shadow routing telemetry: which model the Router would have chosen, as versions, labels and counts. It holds nothing the user wrote -- no message text, no memory content, not even a message id -- and is deleted with the account.",
  },

  // --- not yet decided ------------------------------------------------------
  // Each needs a field-level decision about which columns are the user's own
  // data and which are internal signals about them. This list must be empty
  // before the export can pass its release gate.
  { domain: "comparisonReview", publicName: "comparison_reviews", prismaModel: "ComparisonReview", state: "unverified" },
  { domain: "productAnalyticsEvent", publicName: "product_analytics", prismaModel: "ProductAnalyticsEvent", state: "unverified" },
  { domain: "billingPromotionRedemption", publicName: "promotions", prismaModel: "BillingPromotionRedemption", state: "unverified" },
  { domain: "creditLot", publicName: "credit_lots", prismaModel: "CreditLot", state: "unverified" },
  { domain: "creditLedgerEntry", publicName: "credit_ledger", prismaModel: "CreditLedgerEntry", state: "unverified" },
  { domain: "creditDebtEntry", publicName: "credit_debts", prismaModel: "CreditDebtEntry", state: "unverified" },
  { domain: "imageGeneration", publicName: "image_generations", prismaModel: "ImageGeneration", state: "unverified" },
  { domain: "imageGenerationGroup", publicName: "image_generation_groups", prismaModel: "ImageGenerationGroup", state: "unverified" },
  { domain: "refundRequest", publicName: "refund_requests", prismaModel: "RefundRequest", state: "unverified" },
  { domain: "planChangeRequest", publicName: "plan_changes", prismaModel: "PlanChangeRequest", state: "unverified" },
  { domain: "externalImport", publicName: "imports", prismaModel: "ExternalImport", state: "unverified" },
  { domain: "externalConversation", publicName: "imported_conversations", prismaModel: "ExternalConversation", state: "unverified" },
  { domain: "externalMessage", publicName: "imported_messages", prismaModel: "ExternalMessage", state: "unverified" },
  { domain: "memoryEvidence", publicName: "memory_evidence", prismaModel: "MemoryEvidence", state: "unverified" },
  { domain: "memoryExtractionRun", publicName: "memory_extraction_runs", prismaModel: "MemoryExtractionRun", state: "unverified" },
];

/** Domains whose data reaches the export at all. */
export const EXPORTED_STATES: ExportDomainState[] = ["included", "included_filtered"];

export const isExportedState = (state: ExportDomainState) => EXPORTED_STATES.includes(state);

export const exportDomainState = (domain: string) =>
  EXPORT_DOMAIN_DECLARATIONS.find((declaration) => declaration.domain === domain);
