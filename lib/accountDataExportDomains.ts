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
//                     It is zero today; the state stays because the next table
//                     somebody adds starts there.
//
// Of the 33 registered domains, 8 are wholly the user's own data, 23 are
// projections and 2 hold nothing of theirs. That the filtered case is the
// common one is the finding rather than a drafting accident: a table recording
// something a person did almost always also records what it cost Tomverse,
// which idempotency key deduplicated it, or which digest reconciles it.
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

  // Every one of the remaining domains turned out to mix. Not one was wholly
  // the user's data, which is the finding rather than an accident of drafting:
  // a table that records something a person did almost always records what it
  // cost Tomverse, which idempotency key deduplicated it, or which digest
  // reconciles it. That is exactly why the state exists.
  {
    domain: "comparisonReview",
    publicName: "comparison_reviews",
    prismaModel: "ComparisonReview",
    state: "included_filtered",
    withheldReason:
      "The review the user asked for and read, and what it cost them. The prompt version, the internal message identifiers and the dedupe hash are Tomverse's bookkeeping for producing it.",
  },
  {
    domain: "productAnalyticsEvent",
    publicName: "product_analytics",
    prismaModel: "ProductAnalyticsEvent",
    state: "included_filtered",
    withheldReason:
      "What the user did in the product, when, and which campaign brought them: behavioural data about them, so theirs to receive. The anonymous and session identifier hashes are withheld because they are pseudonymous identifiers for a device rather than anything the user did, and the free-form properties bag is withheld because its contents are not enumerated anywhere -- exporting an unreviewed field bag is the 'everything except' pattern a field allowlist exists to prevent. Giving it a declared shape is what would let it be exported.",
  },
  {
    domain: "billingPromotionRedemption",
    publicName: "promotions",
    prismaModel: "BillingPromotionRedemption",
    state: "included_filtered",
    withheldReason:
      "Which promotion was redeemed, for what plan, and the access period it bought. The client IP and payment-method fingerprint hashes and the risk flags are abuse signals: handing a user their own fraud assessment teaches whoever is abusing the promotion how the control works.",
  },
  {
    domain: "creditLot",
    publicName: "credit_lots",
    prismaModel: "CreditLot",
    state: "included_filtered",
    withheldReason:
      "How many credits the user has, where they came from, and when they expire. The funded-cost columns are what those credits cost Tomverse, not what the user paid.",
  },
  {
    domain: "creditLedgerEntry",
    publicName: "credit_ledger",
    prismaModel: "CreditLedgerEntry",
    state: "included_filtered",
    withheldReason:
      "Every movement of the user's credit balance and what it stood at afterwards. The funded-cost deltas are Tomverse's cost basis, and the metadata bag is an unenumerated field bag.",
  },
  {
    domain: "creditDebtEntry",
    publicName: "credit_debts",
    prismaModel: "CreditDebtEntry",
    state: "included_filtered",
    withheldReason: "Same cost basis and metadata bag as credit_ledger.",
  },
  {
    domain: "imageGeneration",
    publicName: "image_generations",
    prismaModel: "ImageGeneration",
    state: "included_filtered",
    withheldReason:
      "The prompt the user wrote, the settings they chose, what came back and any error they were shown, with the shape of each image produced. The image files themselves are not in this file -- they are binaries in object storage, and a JSON export cannot carry them; that is a gap rather than a withholding. Also withheld: the internal error detail, the provider request identifier, the worker lease and the idempotency keys.",
  },
  {
    domain: "imageGenerationGroup",
    publicName: "image_generation_groups",
    prismaModel: "ImageGenerationGroup",
    state: "included_filtered",
    withheldReason:
      "The grouping that makes the groupId in image_generations resolvable, and nothing else. The group idempotency key is a client-supplied deduplication token.",
  },
  {
    domain: "refundRequest",
    publicName: "refund_requests",
    prismaModel: "RefundRequest",
    state: "included_filtered",
    withheldReason:
      "What the user asked to be refunded, why, and what was decided. The internal admin note, the reviewing operator and the Stripe object identifiers are Tomverse's side of the same request.",
  },
  {
    domain: "planChangeRequest",
    publicName: "plan_changes",
    prismaModel: "PlanChangeRequest",
    state: "included_filtered",
    withheldReason:
      "Which plan the user moved between, when it applies and what it was quoted at. The Stripe subscription, item, price and schedule identifiers and the internal request fingerprint are withheld.",
  },
  {
    domain: "externalImport",
    publicName: "imports",
    prismaModel: "ExternalImport",
    state: "included_filtered",
    withheldReason:
      "What the user imported, from where, how much of it arrived and what was truncated or de-duplicated. The parser and digest versions, the batch checkpoints and the client fingerprint are how the import was executed, not what it contained.",
  },
  {
    domain: "externalConversation",
    publicName: "imported_conversations",
    prismaModel: "ExternalConversation",
    state: "included_filtered",
    withheldReason:
      "The imported conversation as the user brought it, with its original timestamps and model labels. The stored lock password is withheld -- it is a credential the user set, and an export carrying it would unlock every conversation it protects. The content digests are reconciliation values.",
  },
  {
    domain: "externalMessage",
    publicName: "imported_messages",
    prismaModel: "ExternalMessage",
    state: "included_filtered",
    withheldReason:
      "The message text itself, with which conversation it belongs to, its position, and whether it was truncated on the way in and by how much. The content digests are reconciliation values.",
  },
  {
    domain: "memoryEvidence",
    publicName: "memory_evidence",
    prismaModel: "MemoryEvidence",
    state: "included_filtered",
    withheldReason:
      "Why each memory exists: what it was drawn from, and the text where the user wrote it themselves. The evidence digest is a deduplication value.",
  },
  {
    domain: "memoryExtractionRun",
    publicName: "memory_extraction_runs",
    prismaModel: "MemoryExtractionRun",
    state: "included_filtered",
    withheldReason:
      "Each extraction the user ran, which conversations they chose for it, and how far it got. The worker lease, the prompt version and the pricing version are how Tomverse executed it.",
  },
];

/** Domains whose data reaches the export at all. */
export const EXPORTED_STATES: ExportDomainState[] = ["included", "included_filtered"];

export const isExportedState = (state: ExportDomainState) => EXPORTED_STATES.includes(state);

export const exportDomainState = (domain: string) =>
  EXPORT_DOMAIN_DECLARATIONS.find((declaration) => declaration.domain === domain);
