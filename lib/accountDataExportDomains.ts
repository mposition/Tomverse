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

  {
    domain: "externalImport",
    publicName: "imports",
    prismaModel: "ExternalImport",
    state: "included_filtered",
    withheldReason:
      "Which provider was imported, how it ended, how much it carried and when. The machinery that produced it is withheld: parser and digest versions, the content digests, the batch protocol's sequence numbers and idempotency key, and the client fingerprint -- a pseudonymous device identifier rather than anything the user wrote.",
  },
  {
    domain: "externalConversation",
    publicName: "imported_conversations",
    prismaModel: "ExternalConversation",
    state: "included_filtered",
    withheldReason:
      "The conversations the user imported, with their titles, source timestamps and counts. Integrity digests are withheld as internals, and the snapshot lock password is withheld because a copy of it is an offline attack on the one secret this table holds. A conversation the owner has locked is reduced to existence metadata -- that it exists, that it is locked, and when it arrived -- because an export is a document that leaves the account, where a title outlives the lock (policy §13.2).",
  },
  {
    domain: "externalMessage",
    publicName: "imported_messages",
    prismaModel: "ExternalMessage",
    state: "included_filtered",
    withheldReason:
      "The messages of the imported conversations, in order. Content digests and the provider's own stable identifiers are withheld as internals, and the messages of a locked conversation are withheld entirely, for the same reason their conversation's title is.",
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
  // Records where the linked user is the operator who acted, not the person
  // the row is about. The subject is referenced by an untyped targetType and
  // targetId pair with no foreign key, so a subject access request cannot be
  // answered by joining -- it has to be answered by the manual PrivacyRequest
  // path, where the rights of the operator and of any third party named in the
  // text can actually be weighed.
  {
    domain: "adminAuditLog",
    publicName: "admin_actions",
    prismaModel: "AdminAuditLog",
    state: "excluded",
    exclusionReason:
      "A tamper-evident record of administrator action. Each entry names the operator and carries their address, IP and the internal action metadata, and entries can name third parties. A subject access request plausibly reaches entries about the requester, but automating that would publish the operator's identity, so it is answered through the manual PrivacyRequest path instead. Retained rather than deleted: the entry recording an account's suspension or deletion is the one most worth auditing.",
  },
  {
    domain: "adminNote",
    publicName: "admin_notes",
    prismaModel: "AdminNote",
    state: "excluded",
    exclusionReason:
      "Free text written by staff, which can name the operator and third parties as readily as the subject. Redacting free text cannot be automated safely, so a request for notes about a requester is answered through the manual PrivacyRequest path. Notes about a user are deleted with that user's account.",
  },
  {
    domain: "modelOverride",
    publicName: "model_overrides",
    prismaModel: "ModelOverride",
    state: "excluded",
    exclusionReason:
      "Global per-model configuration keyed by modelId, not anybody's setting. It carries a user link only because the operator who last changed it is stamped on it.",
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
