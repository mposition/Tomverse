import "server-only";

// The unified account export PRIVACY-02 grades.
//
// The domain states live in lib/accountDataExportDomains.ts, which is free of
// Prisma so the registry validator can import it. This file supplies a fetcher
// for every domain that is exported at all -- `included` or `included_filtered`
// -- and `exportDomainWiringProblems` keeps the two in step: an exported domain
// with no fetcher, or a fetcher for a domain declared excluded or unverified,
// is a wiring bug rather than a silent gap.

import {
  EXPORT_DOMAIN_DECLARATIONS,
  isExportedState,
  type ExportDomainDeclaration,
} from "@/lib/accountDataExportDomains";
import { prisma } from "@/lib/prisma";

/**
 * Bumped whenever the shape of the file changes in a way a reader has to know
 * about: a renamed key, a removed field, a different manifest. Domains coming
 * and going do not move it, because the manifest already names them.
 */
export const EXPORT_SCHEMA_VERSION = 1;

const EXPORT_ROW_CAP = 5_000;

/**
 * One fetcher per included domain, each with an explicit field allowlist.
 *
 * Never a spread, never `include`, never "everything except". This repository
 * has already shipped the other pattern once, when /api/models/catalog spread a
 * registry row and published Tomverse's per-model USD cost basis to anyone who
 * asked. An export is the same mistake with the user's data on one side and the
 * company's internals on the other, so a new column stays invisible here until
 * somebody adds it deliberately.
 */
const FETCHERS: Record<string, (userId: string) => Promise<unknown[]>> = {
  userSettings: (userId) =>
    prisma.userSettings.findMany({
      where: { userId },
      select: {
        theme: true,
        language: true,
        defaultModel: true,
        newConversationModelIds: true,
        preferredTasks: true,
        preferredPriority: true,
        usesFilesFrequently: true,
        timeZone: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

  userMemorySettings: (userId) =>
    prisma.userMemorySettings.findMany({
      where: { userId },
      select: {
        masterEnabled: true,
        styleEnabled: true,
        defaultConversationMode: true,
        createdAt: true,
        updatedAt: true,
      },
    }),

  conversation: (userId) =>
    prisma.conversation.findMany({
      where: { userId },
      select: {
        id: true,
        title: true,
        kind: true,
        // The product the conversation belongs to, exported for the same
        // reason `kind` is: it is server-decided identity the account can see
        // in the product, so an export that omitted it would be narrower than
        // the screen.
        productKey: true,
        createdAt: true,
        updatedAt: true,
        messages: {
          select: { role: true, content: true, modelId: true, createdAt: true },
          orderBy: { createdAt: "asc" },
        },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  conversationProject: (userId) =>
    prisma.conversationProject.findMany({
      where: { userId },
      select: { id: true, name: true, createdAt: true, updatedAt: true },
      take: EXPORT_ROW_CAP,
    }),

  memoryItem: (userId) =>
    prisma.memoryItem.findMany({
      where: { userId },
      select: {
        id: true,
        kind: true,
        statement: true,
        status: true,
        sensitivity: true,
        confidence: true,
        importance: true,
        pinned: true,
        userEdited: true,
        expiresAt: true,
        approvedAt: true,
        createdAt: true,
        updatedAt: true,
      },
      take: EXPORT_ROW_CAP,
    }),

  // Amounts the user was charged -- not what those requests cost Tomverse.
  // That distinction is the whole reason these are listed field by field.
  billingTransaction: (userId) =>
    prisma.billingTransaction.findMany({
      where: { userId },
      select: {
        id: true,
        productType: true,
        billingInterval: true,
        amountPaidMinor: true,
        currency: true,
        status: true,
        paidAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // What the user bought and what is left of it. The funded-cost and
  // dispute-revocation columns are Tomverse's side of the same row.
  creditPurchase: (userId) =>
    prisma.creditPurchase.findMany({
      where: { userId },
      select: {
        id: true,
        packId: true,
        creditsPurchased: true,
        amountPaidCents: true,
        currency: true,
        refundedAmountCents: true,
        status: true,
        purchasedAt: true,
        expiresAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  feedback: (userId) =>
    prisma.feedback.findMany({
      where: { userId },
      select: { id: true, message: true, status: true, createdAt: true },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered. The profile and the plan the user is on. Everything
  // Tomverse concluded *about* them -- billing risk, the security incident
  // note, why they were suspended and which operator did it -- is an internal
  // signal, and handing a user their own fraud assessment both teaches an
  // abuser how the controls work and exposes the operator behind them.
  user: (userId) =>
    prisma.user.findMany({
      where: { id: userId },
      select: {
        name: true,
        email: true,
        emailVerified: true,
        image: true,
        plan: true,
        subscriptionStatus: true,
        subscriptionCurrentPeriodEnd: true,
        subscriptionBillingInterval: true,
        subscriptionCancelAtPeriodEnd: true,
        accountStatus: true,
        accountDeletionScheduledFor: true,
        emailLoginEnabled: true,
        lastLoginAt: true,
        createdAt: true,
      },
    }),

  // included_filtered. Which providers are linked, never the tokens: an
  // exported refresh token is a live credential for the user's Google,
  // Microsoft or Apple account, and the export file would become one too.
  account: (userId) =>
    prisma.account.findMany({
      where: { userId },
      select: { provider: true, type: true },
    }),

  // included_filtered. When a session exists and when it lapses, never the
  // token -- a copy of that is a usable session.
  session: (userId) =>
    prisma.session.findMany({
      where: { userId },
      select: { expires: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered. The user's own usage record: which model, what
  // happened, how many credits it cost them, and when. The micro-USD cost
  // fields, pricingSnapshot, provider request identifiers and internal error
  // text are Tomverse's provider cost basis and stay out.
  chatCreditReservation: (userId) =>
    prisma.chatCreditReservation.findMany({
      where: { userId },
      select: {
        modelId: true,
        provider: true,
        status: true,
        outcome: true,
        reservedCredits: true,
        settledCredits: true,
        settledInputTokens: true,
        settledOutputTokens: true,
        createdAt: true,
        settledAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  imageCreditReservation: (userId) =>
    prisma.imageCreditReservation.findMany({
      where: { userId },
      select: {
        modelId: true,
        provider: true,
        status: true,
        outcome: true,
        preset: true,
        quality: true,
        size: true,
        reservedCredits: true,
        settledCredits: true,
        createdAt: true,
        settledAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  memoryExtractionCreditReservation: (userId) =>
    prisma.memoryExtractionCreditReservation.findMany({
      where: { userId },
      select: {
        extractionModelId: true,
        provider: true,
        status: true,
        outcome: true,
        chunkTotal: true,
        chunksCharged: true,
        reservedCredits: true,
        settledCredits: true,
        createdAt: true,
        settledAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered. The user's own record of who downloaded their account
  // data and when -- which is exactly the trail that has to survive an export
  // being taken by someone who should not have had it. The token hash is the
  // download credential and the request-context hashes identify a device, so
  // neither belongs in a file the user may forward.
  accountDataExportRequest: (userId) =>
    prisma.accountDataExportRequest.findMany({
      where: { userId },
      select: {
        status: true,
        refusalReason: true,
        expiresAt: true,
        consumedAt: true,
        exportSchemaVersion: true,
        includedDomainCount: true,
        filteredDomainCount: true,
        byteLength: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered. The user uploaded these themselves, so the import event
  // is their own record. What stays internal is the machinery that produced
  // it: parser and digest versions, the content digests, the batch protocol's
  // sequence and idempotency keys, and the client fingerprint -- a pseudonymous
  // device identifier rather than anything the user wrote, withheld on the same
  // ground as the request context on a download request.
  externalImport: (userId) =>
    prisma.externalImport.findMany({
      where: { userId },
      select: {
        id: true,
        provider: true,
        status: true,
        failureCode: true,
        conversationCount: true,
        messageCount: true,
        truncationCount: true,
        duplicateCount: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // included_filtered, and the filter is a lock rather than a column list.
  //
  // Policy §13.2, as applied to the memory export in #427: a locked source
  // leaves the account as existence metadata and nothing more. The argument is
  // the same here and stronger. A snapshot lock is a password the owner set on
  // their own conversation, and the review screen honours it by refusing the
  // page with 423 -- but an export is a document that leaves the account, so a
  // title carried out in one survives the lock entirely. Whoever holds the
  // session can request an export; the lock exists precisely because holding
  // the session is not supposed to be enough.
  //
  // So a locked snapshot exports as: it exists, it is locked, and when it
  // arrived. No title, no counts, no source timestamps -- each of those
  // describes the thing the lock is hiding. The row is still listed, because a
  // user is entitled to know what their account holds; that is what existence
  // metadata means.
  externalConversation: async (userId) => {
    const rows = await prisma.externalConversation.findMany({
      where: { userId },
      select: {
        id: true,
        importId: true,
        provider: true,
        title: true,
        sourceModelLabels: true,
        sourceCreatedAt: true,
        sourceUpdatedAt: true,
        messageCount: true,
        importedAt: true,
        // Read to decide, never emitted: it is a scrypt hash of the owner's
        // lock password, and a copy of it in a downloadable file is an offline
        // cracking target for the one secret this table has.
        password: true,
      },
      orderBy: { importedAt: "asc" },
      take: EXPORT_ROW_CAP,
    });
    // Both shapes are written out field by field. A spread of the select
    // above would be correct today and wrong the moment somebody adds a
    // column to it -- which is the whole reason this file forbids one.
    return rows.map((row) =>
      row.password
        ? {
              id: row.id,
              importId: row.importId,
              locked: Boolean(row.password),
              importedAt: row.importedAt,
          }
        : {
              id: row.id,
              importId: row.importId,
              provider: row.provider,
              title: row.title,
              sourceModelLabels: row.sourceModelLabels,
              sourceCreatedAt: row.sourceCreatedAt,
              sourceUpdatedAt: row.sourceUpdatedAt,
              messageCount: row.messageCount,
              importedAt: row.importedAt,
              locked: Boolean(row.password),
          }
    );
  },

  // included_filtered for the same reason, applied to the content itself: a
  // locked conversation's messages do not leave the account at all. Filtered in
  // the query rather than after it, so a locked conversation's text is never
  // read into a process that is building a file for download.
  externalMessage: (userId) =>
    prisma.externalMessage.findMany({
      where: { userId, conversation: { password: null } },
      select: {
        externalConversationId: true,
        role: true,
        content: true,
        sourceModelLabel: true,
        sourceTimestamp: true,
        ordinal: true,
        truncated: true,
        originalCharacterCount: true,
        retainedCharacterCount: true,
      },
      orderBy: [{ externalConversationId: "asc" }, { ordinal: "asc" }],
      take: EXPORT_ROW_CAP,
    }),

  privacyRequest: (userId) =>
    prisma.privacyRequest.findMany({
      where: { userId },
      // handledById and handledByEmail identify a Tomverse operator, not the
      // requester, so they stay internal.
      select: { id: true, requestType: true, status: true, createdAt: true, completedAt: true },
      take: EXPORT_ROW_CAP,
    }),

  // What an approved retirement did to their stored model settings. The
  // person is entitled to know we changed a setting of theirs and what it held
  // before; the operator who ran it and the ticket that authorised it are an
  // internal decision about the catalogue, not a fact about them. workItemId
  // names a row in the lifecycle queue, which they cannot read either.
  modelMigrationRecord: (userId) =>
    prisma.modelMigrationRecord.findMany({
      where: { userId },
      select: {
        id: true,
        conversationId: true,
        field: true,
        fromModelId: true,
        toModelId: true,
        changedAt: true,
      },
      orderBy: { changedAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  emailPreference: (userId) =>
    prisma.emailPreference.findMany({
      where: { userId },
      // Wholly theirs, including the confirmation-notice dates: those say when
      // we last told them what they had agreed to, which is a fact about them.
      select: {
        id: true,
        purpose: true,
        enabled: true,
        source: true,
        grantedAt: true,
        lastConfirmationNoticeAt: true,
        nextConfirmationNoticeAt: true,
        createdAt: true,
        updatedAt: true,
      },
      take: EXPORT_ROW_CAP,
    }),

  consentRecord: (userId) =>
    prisma.consentRecord.findMany({
      where: { userId },
      // ipHash and userAgentHash are salted digests: they exist to prove a
      // consent event happened, and returning them tells the subject nothing
      // they do not already know while handing anyone else a value to test
      // guesses against. evidence holds the consent wording's hash and a screen
      // identifier -- ours, not theirs.
      select: {
        id: true,
        emailAddress: true,
        purpose: true,
        action: true,
        occurredAt: true,
        jurisdiction: true,
        jurisdictionSource: true,
        capturedVia: true,
      },
      take: EXPORT_ROW_CAP,
    }),

  emailCampaignRecipient: (userId) =>
    prisma.emailCampaignRecipient.findMany({
      where: { userId },
      // Which announcement audiences they were in, and -- when nothing was
      // sent -- why. The campaign, wave and delivery ids are withheld: they are
      // internal handles onto the send rather than facts about the person.
      // `malformed` is withheld too, because it describes a stored value this
      // system could not read rather than anything they did.
      select: {
        id: true,
        emailAddress: true,
        language: true,
        jurisdictionCountry: true,
        eligibilityReason: true,
        excludedReason: true,
        createdAt: true,
      },
      take: EXPORT_ROW_CAP,
    }),

  emailDelivery: (userId) =>
    prisma.emailDelivery.findMany({
      where: { userId },
      // What they can check: which message, when, where to, and whether it
      // arrived. renderedHash is withheld as well as the ids -- it is a keyed
      // HMAC over a body that may contain a login code, and shipping it beside
      // the record of that message is the one place it could do harm.
      select: {
        id: true,
        emailAddress: true,
        language: true,
        lane: true,
        status: true,
        skipReason: true,
        renderedSubject: true,
        sentAt: true,
        deliveredAt: true,
        createdAt: true,
      },
      take: EXPORT_ROW_CAP,
    }),

  comparisonReview: (userId) =>
    prisma.comparisonReview.findMany({
      where: { userId },
      select: {
        id: true,
        conversationId: true,
        reviewerModelId: true,
        reviewMode: true,
        result: true,
        usageCredits: true,
        isStale: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  comparisonReviewItemFeedback: (userId) =>
    prisma.comparisonReviewItemFeedback.findMany({
      where: { userId },
      select: {
        comparisonReviewId: true,
        reviewItemId: true,
        section: true,
        verdict: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // Behavioural data about the user, so theirs. `properties` is deliberately
  // absent: it is a free-form Json bag whose keys are not enumerated anywhere,
  // and passing an unreviewed field bag through is the one thing an allowlist
  // is for. Giving it a declared shape is what would let it be exported.
  productAnalyticsEvent: (userId) =>
    prisma.productAnalyticsEvent.findMany({
      where: { userId },
      select: {
        eventName: true,
        source: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        language: true,
        country: true,
        modelCount: true,
        plan: true,
        occurredAt: true,
      },
      orderBy: { occurredAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  billingPromotionRedemption: (userId) =>
    prisma.billingPromotionRedemption.findMany({
      where: { userId },
      select: {
        promotionId: true,
        planId: true,
        billingInterval: true,
        accessStartsAt: true,
        accessEndsAt: true,
        expiredAt: true,
        redeemedAt: true,
      },
      orderBy: { redeemedAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  creditLot: (userId) =>
    prisma.creditLot.findMany({
      where: { userId },
      select: {
        id: true,
        source: true,
        originalCredits: true,
        remainingCredits: true,
        expiresAt: true,
        status: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  creditLedgerEntry: (userId) =>
    prisma.creditLedgerEntry.findMany({
      where: { userId },
      select: {
        creditLotId: true,
        type: true,
        creditsDelta: true,
        balanceAfterCredits: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  creditDebtEntry: (userId) =>
    prisma.creditDebtEntry.findMany({
      where: { userId },
      select: {
        type: true,
        creditsDelta: true,
        balanceAfterCredits: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // The prompt is unambiguously the user's. The images are not here: they are
  // binaries in object storage and a JSON file cannot carry them, so the asset
  // rows describe what exists rather than pretending it was delivered.
  imageGeneration: (userId) =>
    prisma.imageGeneration.findMany({
      where: { userId },
      select: {
        id: true,
        conversationId: true,
        groupId: true,
        prompt: true,
        preset: true,
        provider: true,
        modelId: true,
        size: true,
        quality: true,
        outputWidth: true,
        outputHeight: true,
        backgroundMode: true,
        outputFormat: true,
        status: true,
        failurePhase: true,
        publicErrorCode: true,
        attemptNumber: true,
        createdAt: true,
        completedAt: true,
        failedAt: true,
        assets: {
          select: {
            role: true,
            status: true,
            mimeType: true,
            width: true,
            height: true,
            byteSize: true,
            createdAt: true,
            deletedAt: true,
          },
        },
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // The files answers produced for this account. Same shape of gap as the
  // images below: the bytes are in object storage, so the export describes
  // what exists rather than pretending it was delivered. `objectKey` is
  // deliberately absent -- it is Tomverse's address for the object and means
  // nothing to the person holding the file.
  messageArtifact: (userId) =>
    prisma.messageArtifact.findMany({
      where: { userId },
      select: {
        id: true,
        messageId: true,
        conversationId: true,
        ordinal: true,
        format: true,
        filename: true,
        mediaType: true,
        byteSize: true,
        status: true,
        failureCode: true,
        modelId: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // The files this account attached to its own messages. Same shape of gap as
  // the generated files above -- the bytes are in object storage, so the
  // export describes what exists rather than pretending it was delivered --
  // and `objectKey` is absent for the same reason: it is Tomverse's address
  // for the object and means nothing to the person holding the original.
  messageAttachment: (userId) =>
    prisma.messageAttachment.findMany({
      where: { userId },
      select: {
        id: true,
        messageId: true,
        conversationId: true,
        ordinal: true,
        name: true,
        mediaType: true,
        size: true,
        kind: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  // Uploads that were never sent. Usually empty: an upload becomes a message
  // attachment the moment the message it belongs to is saved.
  messageAttachmentUpload: (userId) =>
    prisma.messageAttachmentUpload.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        mediaType: true,
        size: true,
        kind: true,
        boundAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  imageGenerationGroup: (userId) =>
    prisma.imageGenerationGroup.findMany({
      where: { userId },
      select: { id: true, conversationId: true, createdAt: true },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  refundRequest: (userId) =>
    prisma.refundRequest.findMany({
      where: { userId },
      select: {
        id: true,
        plan: true,
        subscriptionBillingInterval: true,
        reason: true,
        status: true,
        refundAmountCents: true,
        refundCurrency: true,
        requestedAt: true,
        reviewedAt: true,
      },
      orderBy: { requestedAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  planChangeRequest: (userId) =>
    prisma.planChangeRequest.findMany({
      where: { userId },
      select: {
        id: true,
        direction: true,
        execution: true,
        fromTier: true,
        toTier: true,
        billingInterval: true,
        currency: true,
        quotedAmountMinor: true,
        status: true,
        appliesAt: true,
        confirmedAt: true,
        settledAt: true,
        failureCode: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  memoryEvidence: (userId) =>
    prisma.memoryEvidence.findMany({
      where: { userId },
      select: {
        memoryItemId: true,
        sourceType: true,
        externalMessageId: true,
        tomverseMessageId: true,
        manualContent: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  memoryExtractionRun: (userId) =>
    prisma.memoryExtractionRun.findMany({
      where: { userId },
      select: {
        id: true,
        status: true,
        extractionModelId: true,
        // A sorted list of the conversation ids the user chose. Narrow and
        // typed, unlike the analytics properties bag above.
        sourceSelection: true,
        chunkTotal: true,
        chunkCompleted: true,
        createdAt: true,
        completedAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  assistantProfile: (userId) =>
    prisma.assistantProfile.findMany({
      where: { userId },
      select: {
        id: true,
        name: true,
        icon: true,
        description: true,
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  assistantProfileVersion: (userId) =>
    prisma.assistantProfileVersion.findMany({
      where: { userId },
      select: {
        id: true,
        profileId: true,
        revision: true,
        instructions: true,
        models: true,
        toolPolicy: true,
        memoryPolicy: true,
        starters: true,
        createdAt: true,
      },
      orderBy: [{ profileId: "asc" }, { revision: "asc" }],
      take: EXPORT_ROW_CAP,
    }),

  assistantKnowledgeFile: (userId) =>
    prisma.assistantKnowledgeFile.findMany({
      where: { userId },
      select: {
        id: true,
        profileId: true,
        name: true,
        mime: true,
        bytes: true,
        processingStatus: true,
        failureCode: true,
        extractedCharacters: true,
        // Beside the character count rather than instead of it: the two are
        // the same text measured two ways, and exporting one without the
        // other would be an asymmetry nobody could explain.
        extractedBytes: true,
        chunkCount: true,
        createdAt: true,
        processedAt: true,
      },
      orderBy: [{ profileId: "asc" }, { createdAt: "asc" }],
      take: EXPORT_ROW_CAP,
    }),

  assistantProfileImport: (userId) =>
    prisma.assistantProfileImport.findMany({
      where: { userId },
      select: {
        id: true,
        profileId: true,
        mode: true,
        status: true,
        // What the person assembled, including for an import they abandoned.
        // That draft is still their words, which is the whole reason this
        // table is exported rather than treated as machinery.
        stagingManifest: true,
        // Claims, exported as claims. Nothing here was checked and nothing
        // fetched the address.
        declaredSourceKind: true,
        declaredSourceName: true,
        declaredSourceUrl: true,
        declaredPreviousProvenance: true,
        serverReceivedAt: true,
        userApprovedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: "asc" },
      take: EXPORT_ROW_CAP,
    }),

  assistantKnowledgeChunk: (userId) =>
    prisma.assistantKnowledgeChunk.findMany({
      where: { userId },
      select: {
        fileId: true,
        ordinal: true,
        content: true,
        sourceMetadata: true,
      },
      orderBy: [{ fileId: "asc" }, { ordinal: "asc" }],
      take: EXPORT_ROW_CAP,
    }),
};

/**
 * Every exported domain needs a fetcher, every fetcher a declaration, and every
 * partial answer its reason.
 *
 * `included_filtered` is the state that needs the most care: it hands the user
 * a projection of a table and tells them so. Without `withheldReason` the user
 * receives something that looks complete and is not, which is worse than an
 * outright exclusion because nothing on the page says so.
 */
export const exportDomainWiringProblems = () => {
  const problems: string[] = [];
  const publicNames = new Map<string, string>();

  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    const exported = isExportedState(declaration.state);

    if (exported && !FETCHERS[declaration.domain]) {
      problems.push(`${declaration.domain} is declared ${declaration.state} but has no fetcher`);
    }
    if (!exported && FETCHERS[declaration.domain]) {
      problems.push(`${declaration.domain} has a fetcher but is declared ${declaration.state}`);
    }
    if (declaration.state === "excluded" && !declaration.exclusionReason?.trim()) {
      problems.push(`${declaration.domain} is excluded without a reason`);
    }
    if (declaration.state !== "excluded" && declaration.exclusionReason?.trim()) {
      problems.push(`${declaration.domain} is ${declaration.state} but explains an exclusion`);
    }
    if (declaration.state === "included_filtered" && !declaration.withheldReason?.trim()) {
      problems.push(
        `${declaration.domain} is included_filtered without a withheldReason. A projection the ` +
          "user is not told about reads as a complete answer."
      );
    }
    if (declaration.state !== "included_filtered" && declaration.withheldReason?.trim()) {
      problems.push(`${declaration.domain} is ${declaration.state} but explains a projection`);
    }

    // The public name is the part of this file a user's own tooling depends on,
    // so it has to be stable, unique, and obviously not a Prisma model name.
    if (!/^[a-z][a-z0-9_]*$/.test(declaration.publicName)) {
      problems.push(
        `${declaration.domain} has publicName "${declaration.publicName}", which is not a stable ` +
          "lower_snake_case name"
      );
    }
    const claimedBy = publicNames.get(declaration.publicName);
    if (claimedBy) {
      problems.push(
        `publicName "${declaration.publicName}" is claimed by both ${claimedBy} and ${declaration.domain}`
      );
    } else {
      publicNames.set(declaration.publicName, declaration.domain);
    }
  }

  for (const domain of Object.keys(FETCHERS)) {
    if (!EXPORT_DOMAIN_DECLARATIONS.some((declaration) => declaration.domain === domain)) {
      problems.push(`${domain} has a fetcher but no declaration`);
    }
  }
  return problems;
};

export type AccountDataExportManifest = {
  schemaVersion: number;
  generatedAt: string;
  /** Present in full. */
  includedDomains: string[];
  /** Present as a projection, each with what was held back and why. */
  filteredDomains: { domain: string; reason: string }[];
  /** Named with their reasons, so an export says what it is not. */
  excludedDomains: { domain: string; reason: string }[];
  /** Named without data, so a gap is visible rather than absent. */
  undecidedDomains: string[];
  /**
   * Domains that hit the row cap. A truncated list is indistinguishable from a
   * complete one unless the file says which it is.
   */
  truncatedDomains: { domain: string; rowCap: number }[];
};

export type AccountDataExport = {
  manifest: AccountDataExportManifest;
  userId: string;
  /** Keyed by public domain name, never by Prisma model name. */
  data: Record<string, unknown[]>;
};

/**
 * Builds the export. Excluded and undecided domains are named in the manifest
 * rather than omitted: an export that silently leaves a domain out is
 * indistinguishable from one where the domain held nothing, and a user cannot
 * tell they were given a partial answer.
 */
export const buildAccountDataExport = async (userId: string): Promise<AccountDataExport> => {
  const wiringProblems = exportDomainWiringProblems();
  if (wiringProblems.length > 0) {
    // Refuse rather than hand out a silently incomplete export.
    throw new Error(`Account export is mis-wired: ${wiringProblems.join("; ")}`);
  }

  const data: Record<string, unknown[]> = {};
  const includedDomains: string[] = [];
  const filteredDomains: { domain: string; reason: string }[] = [];
  const truncatedDomains: { domain: string; rowCap: number }[] = [];

  for (const declaration of EXPORT_DOMAIN_DECLARATIONS) {
    const fetch = FETCHERS[declaration.domain];
    if (!isExportedState(declaration.state) || !fetch) continue;

    const rows = await fetch(userId);
    data[declaration.publicName] = rows;

    if (declaration.state === "included_filtered") {
      filteredDomains.push({
        domain: declaration.publicName,
        reason: declaration.withheldReason ?? "",
      });
    } else {
      includedDomains.push(declaration.publicName);
    }
    if (rows.length >= EXPORT_ROW_CAP) {
      truncatedDomains.push({ domain: declaration.publicName, rowCap: EXPORT_ROW_CAP });
    }
  }

  return {
    manifest: {
      schemaVersion: EXPORT_SCHEMA_VERSION,
      generatedAt: new Date().toISOString(),
      includedDomains,
      filteredDomains,
      excludedDomains: EXPORT_DOMAIN_DECLARATIONS.filter(
        (declaration) => declaration.state === "excluded"
      ).map((declaration) => ({
        domain: declaration.publicName,
        reason: declaration.exclusionReason ?? "",
      })),
      undecidedDomains: EXPORT_DOMAIN_DECLARATIONS.filter(
        (declaration) => declaration.state === "unverified"
      ).map((declaration) => declaration.publicName),
      truncatedDomains,
    },
    userId,
    data,
  };
};

export const EXPORT_DOMAINS: ExportDomainDeclaration[] = EXPORT_DOMAIN_DECLARATIONS;
