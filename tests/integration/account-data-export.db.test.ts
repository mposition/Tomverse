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
      "MemoryExtractionCreditReservation", "User"
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

  assert.ok(sentinels.length > 30, `only ${sentinels.length} sentinels were planted`);

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
