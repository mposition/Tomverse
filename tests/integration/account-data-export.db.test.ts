import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { buildAccountDataExport, exportDomainWiringProblems } from "@/lib/accountDataExport";
import { EXPORT_DOMAIN_DECLARATIONS, isExportedState } from "@/lib/accountDataExportDomains";

// The sentinel test PRIVACY-02 actually rests on.
//
// A source scan over lib/accountDataExport.ts can only see the selects written
// there. It cannot see a helper that widens one, a custom serializer that
// re-attaches a field, a raw query, or a Prisma middleware. So instead of
// reading the code, this plants a unique unguessable string in every column
// that is supposed to be withheld, builds the export the way the download route
// will, and asserts that no sentinel survives into JSON.stringify.
//
// If a future change starts exporting a refresh token, a session token, a
// pricing snapshot or Tomverse's assessment of the user, this fails -- whatever
// route the value took to get there.

const SENTINEL_PREFIX = "TVC-WITHHELD-SENTINEL";
const sentinels: string[] = [];

/** A value that cannot occur by accident and is traceable back to its column. */
const sentinel = (label: string) => {
  const value = `${SENTINEL_PREFIX}-${label}-${randomUUID()}`;
  sentinels.push(value);
  return value;
};

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "Account", "Session", "UserSettings", "UserMemorySettings",
      "Conversation", "ConversationProject", "MemoryItem",
      "BillingTransaction", "CreditPurchase", "Feedback", "PrivacyRequest",
      "ChatCreditReservation", "ImageCreditReservation",
      "MemoryExtractionCreditReservation", "AccountDataExportRequest",
      "ComparisonReview", "ProductAnalyticsEvent", "BillingPromotion",
      "BillingPromotionRedemption", "CreditLot", "CreditLedgerEntry",
      "CreditDebtEntry", "ImageGenerationGroup", "ImageGenerationTarget",
      "ImageGeneration", "RefundRequest", "PlanChangeRequest",
      "ExternalImport", "ExternalConversation", "ExternalMessage",
      "MemoryEvidence", "MemoryExtractionRun", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  sentinels.length = 0;
  await reset();
});
after(async () => {
  await reset();
  await prisma.$disconnect();
});

/**
 * One row per exported domain, with a sentinel in every column the declaration
 * says is withheld. Where a column is genuinely the user's own data it gets an
 * ordinary value, so a fetcher that drops everything would not pass by
 * accident -- the completeness assertions below would catch it.
 */
const seedUser = async () => {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      name: "Export Subject",
      plan: "Pro",
      // Internal signals about the user. None of these belong in their export.
      stripeCustomerId: sentinel("user-stripeCustomerId"),
      stripeSubscriptionId: sentinel("user-stripeSubscriptionId"),
      stripePriceId: sentinel("user-stripePriceId"),
      billingRiskStatus: "normal",
      billingRiskReason: sentinel("user-billingRiskReason"),
      securityIncidentNote: sentinel("user-securityIncidentNote"),
      accountSuspensionReason: sentinel("user-accountSuspensionReason"),
      accountSuspendedByEmail: sentinel("user-accountSuspendedByEmail"),
      aiUsageRestrictionReason: sentinel("user-aiUsageRestrictionReason"),
      aiUsageRestrictedByEmail: sentinel("user-aiUsageRestrictedByEmail"),
    },
  });
  const userId = user.id;

  await prisma.account.create({
    data: {
      userId,
      type: "oauth",
      provider: "google",
      providerAccountId: sentinel("account-providerAccountId"),
      // Live credentials for the user's Google account. An export carrying
      // these is a credential, not a data file.
      access_token: sentinel("account-access_token"),
      refresh_token: sentinel("account-refresh_token"),
      id_token: sentinel("account-id_token"),
      session_state: sentinel("account-session_state"),
      scope: sentinel("account-scope"),
      token_type: "bearer",
    },
  });

  await prisma.session.create({
    data: {
      userId,
      sessionToken: sentinel("session-sessionToken"),
      expires: new Date(Date.now() + 86_400_000),
    },
  });

  await prisma.userSettings.create({
    data: { userId, language: "ko", theme: "dark" },
  });
  await prisma.userMemorySettings.create({ data: { userId, masterEnabled: true } });

  const conversation = await prisma.conversation.create({
    data: { userId, title: "Kept", kind: "chat" },
  });
  await prisma.message.create({
    data: {
      conversationId: conversation.id,
      role: "user",
      content: "the user's own words, which they do receive",
      modelId: "gpt-5",
    },
  });

  await prisma.conversationProject.create({ data: { userId, name: "Project" } });
  await prisma.memoryItem.create({
    data: {
      userId,
      kind: "preference",
      statement: "a memory the user receives",
      confidence: 0.9,
    },
  });

  await prisma.billingTransaction.create({
    data: {
      userId,
      productType: "subscription",
      productId: "pro-monthly",
      // Stripe object identifiers resolve to the customer at a third party.
      stripeCheckoutSessionId: sentinel("billing-stripeCheckoutSessionId"),
      stripePaymentIntentId: sentinel("billing-stripePaymentIntentId"),
      stripeSubscriptionId: sentinel("billing-stripeSubscriptionId"),
      amountPaidMinor: 2000,
      currency: "AUD",
      amountPaidUsdMicroUsd: BigInt(13_000_000),
      usdConversionSource: sentinel("billing-usdConversionSource"),
      paidAt: new Date(),
    },
  });

  await prisma.creditPurchase.create({
    data: {
      userId,
      packId: "pack-100",
      creditsPurchased: 100,
      amountPaidCents: 500,
      // Tomverse's own cost of the credits it sold, not what the user paid.
      fundedCostMicroUsd: BigInt(3_000_000),
      stripeCheckoutSessionId: sentinel("creditPurchase-stripeCheckoutSessionId"),
      stripePaymentIntentId: sentinel("creditPurchase-stripePaymentIntentId"),
      stripeChargeId: sentinel("creditPurchase-stripeChargeId"),
      status: "paid",
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
    },
  });

  await prisma.feedback.create({
    data: {
      userId,
      type: "bug",
      message: "the report the user wrote",
      // Internal provenance and diagnostics, not the submitter's own record.
      traceId: sentinel("feedback-traceId"),
      userAgent: sentinel("feedback-userAgent"),
      path: sentinel("feedback-path"),
      email: sentinel("feedback-email"),
    },
  });

  // The audit trail of previous downloads. The token hash is the credential
  // for one of them, and the context hashes identify a device.
  await prisma.accountDataExportRequest.create({
    data: {
      userId,
      tokenHash: sentinel("exportRequest-tokenHash"),
      status: "downloaded",
      expiresAt: new Date(Date.now() + 300_000),
      consumedAt: new Date(),
      issuedIpHash: sentinel("exportRequest-issuedIpHash"),
      issuedUserAgentHash: sentinel("exportRequest-issuedUserAgentHash"),
      consumedIpHash: sentinel("exportRequest-consumedIpHash"),
      consumedUserAgentHash: sentinel("exportRequest-consumedUserAgentHash"),
    },
  });

  await prisma.privacyRequest.create({
    data: {
      userId,
      email: `${randomUUID()}@example.test`,
      requestType: "export",
      dueAt: new Date(Date.now() + 86_400_000),
      // The operator who handled it, not the requester.
      handledById: sentinel("privacy-handledById"),
      handledByEmail: sentinel("privacy-handledByEmail"),
      note: sentinel("privacy-note"),
      legalHoldReason: sentinel("privacy-legalHoldReason"),
    },
  });

  await prisma.chatCreditReservation.create({
    data: {
      id: `chat-res-${randomUUID()}`,
      userId,
      // Join keys back to the chat logs and to the provider's own records.
      subjectKey: sentinel("chatReservation-subjectKey"),
      traceId: sentinel("chatReservation-traceId"),
      source: "chat",
      provider: "openai",
      modelId: "gpt-5",
      idempotencyKey: sentinel("chatReservation-idempotencyKey"),
      providerRequestId: sentinel("chatReservation-providerRequestId"),
      providerResponseId: sentinel("chatReservation-providerResponseId"),
      lastError: sentinel("chatReservation-lastError"),
      // Tomverse's provider cost basis. Publishing this is the incident
      // /api/models/catalog already had once.
      reservationPayload: { note: sentinel("chatReservation-reservationPayload") },
      pricingSnapshot: { note: sentinel("chatReservation-pricingSnapshot") },
      providerUsageSnapshot: { note: sentinel("chatReservation-providerUsageSnapshot") },
      reservedCredits: 10,
      reservedCostMicroUsd: BigInt(1_000),
      planReservedCredits: 10,
      addOnReservedCredits: 0,
      expiresAt: new Date(Date.now() + 600_000),
    },
  });

  await prisma.imageCreditReservation.create({
    data: {
      id: `image-res-${randomUUID()}`,
      userId,
      generationId: sentinel("imageReservation-generationId"),
      conversationId: sentinel("imageReservation-conversationId"),
      targetId: sentinel("imageReservation-targetId"),
      preset: "standard",
      quality: "high",
      size: "1024x1024",
      provider: "openai",
      modelId: "gpt-image-1",
      reservedCredits: 20,
      planReservedCredits: 20,
      addOnReservedCredits: 0,
      reservedCostMicroUsd: BigInt(2_000),
      pricingVersion: "v1",
      costSource: sentinel("imageReservation-costSource"),
      pricingSnapshot: { note: sentinel("imageReservation-pricingSnapshot") },
      reservationPayload: { note: sentinel("imageReservation-reservationPayload") },
      providerRequestId: sentinel("imageReservation-providerRequestId"),
      lastError: sentinel("imageReservation-lastError"),
    },
  });

  await prisma.memoryExtractionCreditReservation.create({
    data: {
      id: `memory-res-${randomUUID()}`,
      userId,
      runId: sentinel("memoryReservation-runId"),
      provider: "anthropic",
      extractionModelId: "claude-haiku",
      promptVersion: sentinel("memoryReservation-promptVersion"),
      chunkTotal: 5,
      chunksCharged: 2,
      reservedCredits: 5,
      planReservedCredits: 5,
      addOnReservedCredits: 0,
      reservedCostMicroUsd: BigInt(500),
      pricingVersion: "v1",
      costSource: sentinel("memoryReservation-costSource"),
      pricingSnapshot: { note: sentinel("memoryReservation-pricingSnapshot") },
      reservationPayload: { note: sentinel("memoryReservation-reservationPayload") },
    },
  });

  // --- the fifteen domains that were unverified until PRIVACY-02 closed them --

  await prisma.comparisonReview.create({
    data: {
      userId,
      conversationId: conversation.id,
      // Internal identifiers and the dedupe hash for producing the review.
      promptMessageId: sentinel("comparisonReview-promptMessageId"),
      assistantMessageIds: [sentinel("comparisonReview-assistantMessageIds")],
      promptVersion: sentinel("comparisonReview-promptVersion"),
      inputHash: sentinel("comparisonReview-inputHash"),
      reviewerModelId: "gpt-5",
      reviewMode: "balanced",
      result: { verdict: "the review the user read" },
      usageCredits: 3,
    },
  });

  await prisma.productAnalyticsEvent.create({
    data: {
      userId,
      dedupeKey: sentinel("analytics-dedupeKey"),
      eventName: "chat_started",
      source: "client",
      // Pseudonymous device identifiers, and an unenumerated field bag.
      anonymousIdHash: sentinel("analytics-anonymousIdHash"),
      sessionIdHash: sentinel("analytics-sessionIdHash"),
      properties: { internal: sentinel("analytics-properties") },
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "launch",
      language: "ko",
      country: "AU",
      modelCount: 2,
      plan: "Pro",
    },
  });

  const promotion = await prisma.billingPromotion.create({
    data: { code: `PROMO-${randomUUID()}`, durationMonths: 3 },
  });
  await prisma.billingPromotionRedemption.create({
    data: {
      userId,
      promotionId: promotion.id,
      planId: "pro",
      billingInterval: "monthly",
      // Abuse signals and Stripe identifiers.
      clientIpHash: sentinel("promotion-clientIpHash"),
      paymentMethodFingerprintHash: sentinel("promotion-paymentMethodFingerprintHash"),
      riskFlags: sentinel("promotion-riskFlags"),
      stripeCheckoutSessionId: sentinel("promotion-stripeCheckoutSessionId"),
      stripeSubscriptionId: sentinel("promotion-stripeSubscriptionId"),
    },
  });

  const lot = await prisma.creditLot.create({
    data: {
      userId,
      source: "purchase",
      originalCredits: 100,
      remainingCredits: 60,
      // Tomverse's cost of the credits, not the user's price.
      originalFundedCostMicroUsd: BigInt(5_000_000),
      remainingFundedCostMicroUsd: BigInt(3_000_000),
      expiresAt: new Date(Date.now() + 365 * 86_400_000),
    },
  });

  await prisma.creditLedgerEntry.create({
    data: {
      userId,
      creditLotId: lot.id,
      type: "debit",
      creditsDelta: -40,
      balanceAfterCredits: 60,
      fundedCostMicroUsdDelta: BigInt(-2_000_000),
      balanceAfterFundedCostMicroUsd: BigInt(3_000_000),
      metadata: { internal: sentinel("creditLedger-metadata") },
      reservationId: sentinel("creditLedger-reservationId"),
    },
  });

  await prisma.creditDebtEntry.create({
    data: {
      userId,
      type: "dispute",
      creditsDelta: -10,
      balanceAfterCredits: 50,
      fundedCostMicroUsdDelta: BigInt(-500_000),
      balanceAfterCostMicroUsd: BigInt(2_500_000),
      metadata: { internal: sentinel("creditDebt-metadata") },
    },
  });

  const imageGroup = await prisma.imageGenerationGroup.create({
    data: {
      userId,
      conversationId: conversation.id,
      groupIdempotencyKey: sentinel("imageGroup-groupIdempotencyKey"),
    },
  });
  const imageTarget = await prisma.imageGenerationTarget.create({
    data: { groupId: imageGroup.id, provider: "openai", modelId: "gpt-image-1" },
  });
  const generation = await prisma.imageGeneration.create({
    data: {
      userId,
      conversationId: conversation.id,
      groupId: imageGroup.id,
      targetId: imageTarget.id,
      prompt: "a picture the user asked for",
      preset: "standard",
      size: "1024x1024",
      quality: "high",
      status: "completed",
      // Worker and provider internals.
      idempotencyKey: sentinel("imageGeneration-idempotencyKey"),
      retryIdempotencyKey: sentinel("imageGeneration-retryIdempotencyKey"),
      internalErrorDetail: sentinel("imageGeneration-internalErrorDetail"),
      providerRequestId: sentinel("imageGeneration-providerRequestId"),
      leaseId: sentinel("imageGeneration-leaseId"),
      providerRequestParams: { internal: sentinel("imageGeneration-providerRequestParams") },
    },
  });
  await prisma.imageAsset.create({
    data: {
      generationId: generation.id,
      role: "original",
      status: "ready",
      // The storage path and content digest are Tomverse's, not the user's.
      r2Key: sentinel("imageAsset-r2Key"),
      sha256: sentinel("imageAsset-sha256"),
      mimeType: "image/png",
      width: 1024,
      height: 1024,
      byteSize: 400_000,
    },
  });

  await prisma.refundRequest.create({
    data: {
      userId,
      email: sentinel("refundRequest-email"),
      reason: "the reason the user gave",
      status: "pending",
      // Operator side of the same request.
      adminNote: sentinel("refundRequest-adminNote"),
      reviewedByUserId: sentinel("refundRequest-reviewedByUserId"),
      stripeCustomerId: sentinel("refundRequest-stripeCustomerId"),
      stripeRefundId: sentinel("refundRequest-stripeRefundId"),
      stripeChargeId: sentinel("refundRequest-stripeChargeId"),
    },
  });

  await prisma.planChangeRequest.create({
    data: {
      userId,
      direction: "upgrade",
      execution: "immediate_upgrade",
      fromTier: "Pro",
      toTier: "Max",
      billingInterval: "monthly",
      currency: "AUD",
      status: "confirmed",
      // Stripe object identifiers and the internal request fingerprint.
      stripeSubscriptionId: sentinel("planChange-stripeSubscriptionId"),
      stripeSubscriptionItemId: sentinel("planChange-stripeSubscriptionItemId"),
      targetStripePriceId: sentinel("planChange-targetStripePriceId"),
      stripeScheduleId: sentinel("planChange-stripeScheduleId"),
      fingerprint: sentinel("planChange-fingerprint"),
      renewalDecision: sentinel("planChange-renewalDecision"),
    },
  });

  const externalImport = await prisma.externalImport.create({
    data: {
      userId,
      provider: "chatgpt",
      status: "completed",
      digestVersion: 1,
      // How the import was executed, not what it contained.
      parserVersion: sentinel("externalImport-parserVersion"),
      clientFingerprint: sentinel("externalImport-clientFingerprint"),
      importDigest: sentinel("externalImport-importDigest"),
      lastBatchDigest: sentinel("externalImport-lastBatchDigest"),
      finalizeIdempotencyKey: sentinel("externalImport-finalizeIdempotencyKey"),
    },
  });
  const externalConversation = await prisma.externalConversation.create({
    data: {
      userId,
      importId: externalImport.id,
      provider: "chatgpt",
      title: "an imported conversation the user receives",
      messageCount: 1,
      contentBytes: BigInt(64),
      digestVersion: 1,
      // The lock the user set, and reconciliation digests.
      password: sentinel("externalConversation-password"),
      conversationDigest: sentinel("externalConversation-conversationDigest"),
      externalStableId: sentinel("externalConversation-externalStableId"),
    },
  });
  await prisma.externalMessage.create({
    data: {
      userId,
      externalConversationId: externalConversation.id,
      role: "user",
      content: "an imported message the user receives",
      ordinal: 0,
      digestVersion: 1,
      // Truncated on the way in, so the counts the user is owed are populated
      // and the CHECK that ties them together is satisfied.
      truncated: true,
      originalCharacterCount: 100,
      retainedCharacterCount: 36,
      contentDigest: sentinel("externalMessage-contentDigest"),
      originalContentDigest: sentinel("externalMessage-originalContentDigest"),
      externalStableId: sentinel("externalMessage-externalStableId"),
    },
  });

  const memory = await prisma.memoryItem.findFirstOrThrow({ where: { userId } });
  await prisma.memoryEvidence.create({
    data: {
      userId,
      memoryItemId: memory.id,
      sourceType: "manual",
      manualContent: "the note the user wrote themselves",
      evidenceDigest: sentinel("memoryEvidence-evidenceDigest"),
    },
  });

  await prisma.memoryExtractionRun.create({
    data: {
      userId,
      status: "completed",
      extractionModelId: "claude-haiku",
      sourceSelection: [conversation.id],
      chunkTotal: 2,
      chunkCompleted: 2,
      // How Tomverse executed it.
      promptVersion: sentinel("memoryExtractionRun-promptVersion"),
      pricingVersion: sentinel("memoryExtractionRun-pricingVersion"),
      leaseOwner: sentinel("memoryExtractionRun-leaseOwner"),
    },
  });

  return userId;
};

test("the export is wired: every exported domain has a fetcher and every fetcher a declaration", () => {
  assert.deepEqual(exportDomainWiringProblems(), []);
});

// The test the plan asks for by name. Not "does the code look right" but "is
// the secret in the file".
test("no withheld value reaches the serialised export", async () => {
  const userId = await seedUser();
  const serialised = JSON.stringify(
    await buildAccountDataExport(userId),
    (_key, value) => (typeof value === "bigint" ? value.toString() : value)
  );

  assert.ok(sentinels.length > 60, `only ${sentinels.length} sentinels were planted`);

  const leaked = sentinels.filter((value) => serialised.includes(value));
  assert.deepEqual(
    leaked,
    [],
    `the export contains ${leaked.length} withheld value(s): ${leaked.join(", ")}`
  );

  // A blanket check for the prefix as well, in case a serializer transformed a
  // sentinel rather than copying it verbatim.
  assert.equal(
    serialised.includes(SENTINEL_PREFIX),
    false,
    "a withheld value reached the export in a transformed form"
  );
});

// A file that leaks nothing because it contains nothing would pass the test
// above. The user is owed their data, not an empty envelope.
test("the export still contains the data the user is owed", async () => {
  const userId = await seedUser();
  const result = await buildAccountDataExport(userId);
  const serialised = JSON.stringify(result, (_key, value) =>
    typeof value === "bigint" ? value.toString() : value
  );

  assert.ok(serialised.includes("the user's own words, which they do receive"));
  assert.ok(serialised.includes("the report the user wrote"));
  assert.ok(serialised.includes("a memory the user receives"));
  assert.equal(result.data.profile?.length, 1);
  assert.equal(result.data.linked_accounts?.length, 1);
  assert.equal(result.data.active_sessions?.length, 1);
  assert.equal(result.data.payments?.length, 1);
  assert.equal(result.data.chat_credit_usage?.length, 1);
  assert.equal(result.data.data_export_history?.length, 1);
  assert.ok(serialised.includes("a picture the user asked for"));
  assert.ok(serialised.includes("an imported message the user receives"));
  assert.ok(serialised.includes("the note the user wrote themselves"));
  assert.ok(serialised.includes("the reason the user gave"));
  assert.ok(serialised.includes("the review the user read"));
  // The image binaries are not in the file, but their shape is -- so the user
  // can see an image existed rather than finding nothing where one was.
  assert.equal(result.data.image_generations?.length, 1);
  assert.equal((result.data.image_generations as { assets: unknown[] }[])[0].assets.length, 1);
});

// Keys are the stable public names, and every exported domain appears even when
// it holds nothing -- an absent key is indistinguishable from an empty table.
test("the export is keyed by public name and covers every exported domain", async () => {
  const userId = await seedUser();
  const result = await buildAccountDataExport(userId);

  const expected = EXPORT_DOMAIN_DECLARATIONS.filter((d) => isExportedState(d.state)).map(
    (d) => d.publicName
  );
  assert.deepEqual(Object.keys(result.data).sort(), [...expected].sort());

  const internalNames = EXPORT_DOMAIN_DECLARATIONS.map((d) => d.domain);
  for (const key of Object.keys(result.data)) {
    if (key === "feedback") continue; // the one domain whose names coincide
    assert.equal(internalNames.includes(key), false, `${key} is an internal domain name`);
  }
});

// The manifest is what makes a partial export legible: which domains were left
// out, which were projected, and why.
test("the manifest names what is missing and why", async () => {
  const userId = await seedUser();
  const { manifest } = await buildAccountDataExport(userId);

  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.generatedAt, /^\d{4}-\d{2}-\d{2}T/);

  const declaredExcluded = EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state === "excluded");
  assert.equal(manifest.excludedDomains.length, declaredExcluded.length);
  for (const entry of manifest.excludedDomains) {
    assert.notEqual(entry.reason.trim(), "", `${entry.domain} is excluded without a reason`);
  }

  const declaredFiltered = EXPORT_DOMAIN_DECLARATIONS.filter(
    (d) => d.state === "included_filtered"
  );
  assert.equal(manifest.filteredDomains.length, declaredFiltered.length);
  for (const entry of manifest.filteredDomains) {
    assert.notEqual(entry.reason.trim(), "", `${entry.domain} is filtered without a reason`);
  }

  // Undecided domains are named rather than omitted, so the gap is visible in
  // the file the user receives. This list has to reach zero before PRIVACY-02
  // can pass.
  assert.equal(
    manifest.undecidedDomains.length,
    EXPORT_DOMAIN_DECLARATIONS.filter((d) => d.state === "unverified").length
  );
});

// ---------------------------------------------------------------------------
// Imported conversations, and the lock that has to survive the download.
//
// Policy §13.2, as #427 applied it to the memory export: a locked source
// leaves the account as existence metadata and nothing more. The reasoning
// carries here and gets sharper. A snapshot lock is a password the owner set
// on their own conversation; the review screen honours it by refusing the page
// with 423, but an export is a file, and a title inside one outlives the lock
// entirely. Whoever holds the session can ask for an export -- and the lock
// exists precisely because holding the session is not meant to be enough.
// ---------------------------------------------------------------------------

const seedImport = async (userId: string, locked: boolean) => {
  const importRow = await prisma.externalImport.create({
    data: {
      userId,
      provider: "chatgpt",
      status: "completed",
      digestVersion: 1,
      parserVersion: sentinel("externalImport-parserVersion"),
      importDigest: sentinel("externalImport-importDigest"),
      clientFingerprint: sentinel("externalImport-clientFingerprint"),
      finalizeIdempotencyKey: sentinel("externalImport-finalizeIdempotencyKey"),
      lastBatchDigest: sentinel("externalImport-lastBatchDigest"),
      conversationCount: 1,
      messageCount: 1,
    },
  });
  const conversation = await prisma.externalConversation.create({
    data: {
      userId,
      importId: importRow.id,
      provider: "chatgpt",
      externalStableId: randomUUID().replaceAll("-", ""),
      title: locked ? sentinel("externalConversation-lockedTitle") : "An open import",
      conversationDigest: sentinel("externalConversation-conversationDigest"),
      digestVersion: 1,
      messageCount: 1,
      contentBytes: BigInt(64),
      finalized: true,
      // The scrypt hash of the owner's lock password. A copy of it in a
      // downloadable file is an offline attack on the one secret here.
      ...(locked ? { password: sentinel("externalConversation-password") } : {}),
    },
  });
  const content = locked
    ? sentinel("externalMessage-lockedContent")
    : "the words of an unlocked import, which the user does receive";
  await prisma.externalMessage.create({
    data: {
      userId,
      externalConversationId: conversation.id,
      externalStableId: randomUUID().replaceAll("-", ""),
      role: "user",
      content,
      contentDigest: sentinel("externalMessage-contentDigest"),
      digestVersion: 1,
      ordinal: 0,
    },
  });
  return { importId: importRow.id, conversationId: conversation.id };
};

const domainRows = (data: Record<string, unknown>, publicName: string) =>
  (data[publicName] as Array<Record<string, unknown>>) || [];

test("an unlocked import is exported with its title and its messages", async () => {
  const userId = await seedUser();
  await seedImport(userId, false);
  const { data } = await buildAccountDataExport(userId);

  const conversations = domainRows(data, "imported_conversations");
  assert.equal(conversations.length, 1);
  assert.equal(conversations[0].title, "An open import");
  assert.equal(conversations[0].locked, false);

  const messages = domainRows(data, "imported_messages");
  assert.equal(messages.length, 1);
  assert.match(String(messages[0].content), /the words of an unlocked import/);

  // The import event itself is the user's record of what they uploaded.
  const imports = domainRows(data, "imports");
  assert.equal(imports.length, 1);
  assert.equal(imports[0].provider, "chatgpt");
  assert.equal(imports[0].conversationCount, 1);
});

test("a locked import is reduced to existence metadata", async () => {
  const userId = await seedUser();
  await seedImport(userId, true);
  const { data } = await buildAccountDataExport(userId);

  const conversations = domainRows(data, "imported_conversations");
  assert.equal(conversations.length, 1, "the row is still listed");
  assert.equal(conversations[0].locked, true);
  // Existence metadata is the whole of it. A title, a count or a source
  // timestamp each describes the thing the lock is hiding.
  assert.equal(conversations[0].title, undefined);
  assert.equal(conversations[0].messageCount, undefined);
  assert.equal(conversations[0].sourceCreatedAt, undefined);
  assert.ok(conversations[0].importedAt, "when it arrived is not what the lock hides");

  // And none of its content leaves at all.
  assert.deepEqual(domainRows(data, "imported_messages"), []);
});

test("a lock on one conversation does not withhold another", async () => {
  // The filter has to be per conversation. A single locked import silently
  // emptying the whole domain would be a data-loss bug wearing a privacy
  // fix's clothes.
  const userId = await seedUser();
  await seedImport(userId, true);
  await seedImport(userId, false);
  const { data } = await buildAccountDataExport(userId);

  assert.equal(domainRows(data, "imported_conversations").length, 2);
  const messages = domainRows(data, "imported_messages");
  assert.equal(messages.length, 1);
  assert.match(String(messages[0].content), /unlocked import/);
});
