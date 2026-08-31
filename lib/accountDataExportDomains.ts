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
  // The user's own verdicts on individual AI Review claims. Wholly theirs: a
  // closed verdict, the section it was about, and when. The derived item id is
  // included because without it a row says "you marked something unclear" and
  // names nothing.
  {
    domain: "comparisonReviewItemFeedback",
    publicName: "ai_review_item_feedback",
    prismaModel: "ComparisonReviewItemFeedback",
    state: "included",
  },
  // Registered on 2026-08-27 having escaped the sweep entirely: both carry
  // actorUserId but no User relation. "unverified" is the honest state -- what
  // the export should do with a child row of an anonymised parent has not been
  // decided, and claiming "excluded" would assert a decision nobody made.
  {
    domain: "feedbackLifecycleEvent",
    publicName: "feedback_lifecycle_events",
    prismaModel: "FeedbackLifecycleEvent",
    state: "unverified",
  },
  {
    domain: "refundRequestTimelineEvent",
    publicName: "refund_request_timeline_events",
    prismaModel: "RefundRequestTimelineEvent",
    state: "unverified",
  },
  {
    domain: "privacyRequest",
    publicName: "privacy_requests",
    prismaModel: "PrivacyRequest",
    state: "included",
  },
  {
    domain: "emailPreference",
    publicName: "email_preferences",
    prismaModel: "EmailPreference",
    state: "included",
  },

  // --- the user's data mixed with Tomverse's internals ----------------------
  {
    domain: "modelMigrationRecord",
    publicName: "model_changes",
    prismaModel: "ModelMigrationRecord",
    state: "included_filtered",
    withheldReason:
      "Which of their stored model settings an approved retirement moved, from what to what, and when. Held back: the operator's email and the internal ticket that authorised the run, and the lifecycle work item the run belonged to. The person is entitled to know we changed their model and what it held before, not to the staff identity behind an internal decision or to the queue row that tracked it.",
  },
  {
    domain: "consentRecord",
    publicName: "email_consent_history",
    prismaModel: "ConsentRecord",
    state: "included_filtered",
    withheldReason:
      "When they agreed to what, on which policy version, and how it was captured -- returned in full. Held back: ipHash and userAgentHash, which are salted digests kept to prove a consent event happened and are not readable by the person they describe, and the evidence blob, which holds the consent wording's hash and an internal screen identifier rather than anything they wrote.",
  },
  {
    domain: "emailCampaignRecipient",
    publicName: "email_campaign_audience",
    prismaModel: "EmailCampaignRecipient",
    state: "included_filtered",
    withheldReason:
      "Which announcement audiences they were part of, and -- when nothing was sent -- why: no address, a suppression, a plan the replacement model does not reach, or that they had already changed the setting the notice was about. Held back: the campaign and wave ids and the delivery id, which are internal handles onto the send rather than facts about them, and the malformed flag, which describes a stored value this system could not read rather than anything they did.",
  },
  {
    domain: "emailDelivery",
    publicName: "email_deliveries",
    prismaModel: "EmailDelivery",
    state: "included_filtered",
    withheldReason:
      "Which messages went to them, when, in what language, and whether each arrived. Held back: the provider's message id, the idempotency key, the rendered-body HMAC and its key version, the template and policy version ids, and the error classification -- delivery machinery that says nothing about them and, in the hash's case, is a keyed value that must not travel with the body it covers. The credential lane never carries a rendered-data snapshot at all.",
  },
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
    domain: "conversationContinuationBridge",
    publicName: "continued_conversations",
    prismaModel: "ConversationContinuationBridge",
    state: "included_filtered",
    withheldReason:
      "Which Tomverse conversation was started from which imported one, the provider it came from, when the original was imported, how much of it the model was given as context, and whether the original has since been deleted. Withheld: the snapshot digest and its version, which identify a snapshot rather than describe it and are integrity internals like every other digest here, and the creation idempotency key, which is a protocol artefact of one click.",
  },
  {
    domain: "externalMessage",
    publicName: "imported_messages",
    prismaModel: "ExternalMessage",
    state: "included_filtered",
    withheldReason:
      "The messages of the imported conversations, in order. Content digests and the provider's own stable identifiers are withheld as internals, and the messages of a locked conversation are withheld entirely, for the same reason their conversation's title is.",
  },

  {
    domain: "assistantProfile",
    publicName: "assistant_profiles",
    prismaModel: "AssistantProfile",
    state: "included_filtered",
    withheldReason:
      "The profiles the user created: name, icon, description and when each was last changed. The pointer to the currently published version is withheld as an internal identifier -- the versions themselves are exported beside this, each carrying its own revision number, which is what a reader needs to tell them apart.",
  },
  {
    domain: "assistantProfileVersion",
    publicName: "assistant_profile_versions",
    prismaModel: "AssistantProfileVersion",
    state: "included_filtered",
    withheldReason:
      "Every published revision of every profile, with its instructions and the model, tool and memory choices it was published with. The knowledge manifest is withheld: it names files by internal id and digest, and the files themselves are exported as their own domain, so including it would add identifiers without adding anything the user wrote. The retrieval and prompt format versions are withheld as internals.",
  },

  {
    domain: "assistantKnowledgeFile",
    publicName: "assistant_knowledge_files",
    prismaModel: "AssistantKnowledgeFile",
    state: "included_filtered",
    withheldReason:
      "The knowledge files attached to each profile: name, media type, size, whether processing succeeded and when. The storage key is withheld because it is an internal object path, and the content digest as an internal. The text itself is exported as its chunks beside this.",
  },
  {
    domain: "assistantKnowledgeChunk",
    publicName: "assistant_knowledge_chunks",
    prismaModel: "AssistantKnowledgeChunk",
    state: "included_filtered",
    withheldReason:
      "The text of each knowledge file, in order, as the pieces retrieval actually reads. The derived search terms are withheld: they are an index over the same text rather than anything the user wrote, and a list of tokens beside the passage they came from is noise in a file somebody has to read.",
  },
  {
    domain: "assistantProfileImport",
    publicName: "assistant_profile_imports",
    prismaModel: "AssistantProfileImport",
    state: "included_filtered",
    withheldReason:
      "Where an imported assistant came from and what the person assembled before publishing it, including an import they abandoned -- that draft is still their words. The declared source name and address are exported as what the package or the person claimed rather than as anything verified. Withheld: the validator version and ingest path, the expected target revision and identity digest, the candidate and approved digests, and the published version's id, all internal identifiers of the same kind the profile and version exports already withhold.",
  },
  {
    domain: "assistantKnowledgeUploadReservation",
    publicName: "assistant_knowledge_upload_reservations",
    prismaModel: "AssistantKnowledgeUploadReservation",
    state: "excluded",
    exclusionReason:
      "Bookkeeping for an upload in progress. It holds nothing the user wrote -- an object key, whose owner claims it, and whether a finalize is currently in flight -- and the key is a storage path the policy forbids putting in any response. A successful upload deletes the row, so a completed import leaves none of these behind.",
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
    domain: "comparisonReviewRun",
    publicName: "ai_review_runs",
    prismaModel: "ComparisonReviewRun",
    state: "excluded",
    exclusionReason:
      "Internal reliability telemetry for AI Review: outcome, reviewer model ids, durations, token counts and quote counts, with no content the user wrote and no field one could be written into. The review the user actually saw is exported through the conversation itself. Anonymised on account deletion and purged on its own 90-day retention.",
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
    domain: "routingAttempt",
    publicName: "routing_attempts",
    prismaModel: "RoutingAttempt",
    state: "excluded",
    exclusionReason:
      "The per-attempt half of the routing record: which model was tried, whether it reached a provider, and how it ended. Operational reliability data about Tomverse's own infrastructure, holding nothing the user wrote. Deleted with the account.",
  },
  {
    domain: "contextManifest",
    publicName: "context_manifests",
    prismaModel: "ContextManifest",
    state: "excluded",
    exclusionReason:
      "The immutable proof of what one attempt sent to a provider: source references, versions, hashes and token counts. Deliberately not a copy of the prompt -- the policy forbids duplicating it here -- so there is no content of the user's to return, and the source references point at their conversations, which the export already carries in full. Deleted with the account.",
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
    domain: "messageArtifact",
    publicName: "generated_files",
    prismaModel: "MessageArtifact",
    state: "included_filtered",
    withheldReason:
      "The files an assistant answer produced for the user: name, format, size, which answer and which model made each one. The file bytes themselves are not in this export -- they are binaries in object storage and a JSON file cannot carry them, which is a gap rather than a withholding, and they remain downloadable from the conversation while it exists. Also withheld: the object storage key, which is Tomverse's internal address for the object and grants nothing on its own.",
  },
  {
    domain: "messageAttachment",
    publicName: "message_attachments",
    prismaModel: "MessageAttachment",
    state: "included_filtered",
    withheldReason:
      "The files the user attached to their own messages: name, type, size and which message each belongs to. The file bytes themselves are not in this export -- they are binaries in object storage and a JSON file cannot carry them, which is a gap rather than a withholding, and the person already holds the originals they uploaded. Also withheld: the object storage key, which is Tomverse's internal address for the object and grants nothing on its own.",
  },
  {
    domain: "messageAttachmentUpload",
    publicName: "pending_attachment_uploads",
    prismaModel: "MessageAttachmentUpload",
    state: "included_filtered",
    withheldReason:
      "Files the user uploaded in the composer and never sent: name, type, size and when. Withheld for the same reason as above: the bytes are in object storage and the storage key is an internal address. Rows here are usually transient -- an upload becomes a message attachment the moment the message is saved.",
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

  // --- native mobile sign-in -----------------------------------------------
  //
  // Three of the five mobile auth tables appear here; MobileRefreshRotation
  // does not, because it carries no user column at all -- it hangs off a family
  // and holds a digest, a pepper generation and four timestamps.
  {
    domain: "mobileDevice",
    publicName: "mobile_devices",
    prismaModel: "MobileDevice",
    state: "included_filtered",
    withheldReason:
      "The devices the person signed in on: the name they gave each one, whether it is an iPhone or an Android, the app version, when it was registered, when it was last used and whether it has been removed. Withheld: the server-issued device id, which is the value a live refresh token is bound to. Nothing else about the device is collected -- no model name, OS build, advertising identifier, IDFV or ANDROID_ID -- so what is missing from this export is mostly missing from the database.",
  },
  {
    domain: "mobileTokenFamily",
    publicName: "mobile_sessions",
    prismaModel: "MobileTokenFamily",
    state: "included_filtered",
    withheldReason:
      "One row per mobile sign-in: when it started, when it last refreshed, when it expires regardless, and whether and why it was ended. Withheld: the family id and the invalidation generation counter, both internal handles that a session-revocation check reads and that identify nothing to the person holding them.",
  },
  {
    domain: "mobileAuthEvent",
    publicName: "mobile_sign_in_events",
    prismaModel: "MobileAuthEvent",
    state: "included_filtered",
    withheldReason:
      "What happened on their mobile sign-ins -- an exchange, a refresh, a refusal, a device removed -- and when. Withheld: the device and family identifiers the row carries, which are the same internal handles withheld above. No token, fragment, digest or header value is in the table to withhold.",
  },
  {
    domain: "mobileLoginGrant",
    publicName: "mobile_login_grants",
    prismaModel: "MobileLoginGrant",
    state: "excluded",
    exclusionReason:
      "A sixty-second handshake row that lets a signed-in browser hand the native app one exchange. It holds two digests -- of the grant secret and of the PKCE verifier -- an expiry and a consumed-at, and no content the user wrote. A completed sign-in consumes it and the sweep deletes it, so an export run at any ordinary moment would find nothing to include.",
  },
];

/** Domains whose data reaches the export at all. */
export const EXPORTED_STATES: ExportDomainState[] = ["included", "included_filtered"];

export const isExportedState = (state: ExportDomainState) => EXPORTED_STATES.includes(state);

export const exportDomainState = (domain: string) =>
  EXPORT_DOMAIN_DECLARATIONS.find((declaration) => declaration.domain === domain);
