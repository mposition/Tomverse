import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { isChatAccessError } from "@/lib/chatSecurity";
import { requestImageGeneration } from "@/lib/imageGenerationService";
import { createMemoryExtractionRun } from "@/lib/memoryExtractionService";

// Whether "cannot use AI services" means every AI service.
//
// An administrator has three ways to put an account out of bounds -- suspend
// it, restrict its AI usage specifically, or schedule it for deletion -- and
// `enforceUserOperationalSecurity` turns each into a 403 with its own code. It
// was called from `lib/chatSecurity.ts` and nowhere else, so it covered chat
// and model comparison. Image generation and memory extraction, which also call
// providers and also charge credits, never asked: a suspended account could
// keep generating images and keep paying for them.
//
// The gate had no test at all in either direction, which is why these assert
// both halves: that a restricted account is refused, and that an account whose
// fixed-term penalty has expired is let through -- a gate that refuses everyone
// would pass a one-sided test.
//
// Read against the real database because the refusal and the auto-expiry are
// both writes-and-reads of User state, and because the empty-work invariant
// (no rows, no credits for a rejected request) is only observable here.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ImageGenerationTarget", "ImageGeneration", "ImageGenerationGroup",
      "ImageCreditReservation", "MemoryExtractionRun",
      "MemoryExtractionCreditReservation", "AppSetting", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  // The feature flag is checked before the account gate, and it is off by
  // default. Without this every image assertion below would pass on
  // IMAGE_GENERATION_DISABLED and prove nothing about the gate.
  await prisma.appSetting.create({
    data: { key: "feature.imageGenerationEnabled", value: "true" },
  });
});
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seedUser = async (data: Record<string, unknown> = {}) => {
  const user = await prisma.user.create({
    data: {
      email: `${randomUUID()}@example.test`,
      plan: "Pro",
      ...data,
    },
  });
  return user.id;
};

const hour = 60 * 60 * 1000;
const past = () => new Date(Date.now() - hour);
const future = () => new Date(Date.now() + hour);

/** The refusal, or `null` if the call was allowed to proceed past the gate. */
const refusalOf = async (run: () => Promise<unknown>) => {
  try {
    await run();
    return null;
  } catch (error) {
    // Only an account-level refusal counts. Anything else -- a plan check, a
    // missing model, a pricing failure -- means the call got past the gate,
    // which is what the "let through" tests below are asserting.
    return isChatAccessError(error) &&
      ["ACCOUNT_SUSPENDED", "ACCOUNT_PENDING_DELETION", "AI_USAGE_RESTRICTED"].includes(
        error.code
      )
      ? error
      : null;
  }
};

const generateImage = (userId: string) =>
  requestImageGeneration({
    userId,
    prompt: "a lighthouse at dusk",
    size: "1024x1024",
    quality: "medium",
    conversationId: null,
    idempotencyKey: randomUUID(),
    modelIds: ["gpt-image-1"],
  });

const extractMemory = (userId: string) =>
  createMemoryExtractionRun({
    userId,
    extractionModelId: "gpt-5-6-luna",
    promptVersion: "mem-extract-v1",
    plan: "Pro",
    selectedConversationIds: [randomUUID()],
    confirmedCredits: 1,
  });

const RESTRICTIONS = [
  {
    label: "a suspended account",
    code: "ACCOUNT_SUSPENDED",
    data: { accountStatus: "suspended", accountSuspendedUntil: future() },
  },
  {
    label: "an account scheduled for deletion",
    code: "ACCOUNT_PENDING_DELETION",
    data: {
      accountStatus: "pending_deletion",
      accountDeletionScheduledFor: future(),
    },
  },
  {
    label: "an account restricted from AI usage",
    code: "AI_USAGE_RESTRICTED",
    data: { aiUsageRestricted: true, aiUsageRestrictedUntil: future() },
  },
] as const;

for (const restriction of RESTRICTIONS) {
  test(`${restriction.label} cannot generate an image`, async () => {
    const userId = await seedUser(restriction.data);

    const refusal = await refusalOf(() => generateImage(userId));
    assert.ok(refusal, "the image request was not refused");
    assert.equal(refusal.code, restriction.code);
    assert.equal(refusal.status, 403);

    // The empty-work invariant: a refused request leaves no row and no charge.
    assert.equal(await prisma.imageGenerationGroup.count(), 0);
    assert.equal(await prisma.imageGeneration.count(), 0);
    assert.equal(await prisma.imageCreditReservation.count(), 0);
  });

  test(`${restriction.label} cannot start a memory extraction`, async () => {
    const userId = await seedUser(restriction.data);

    const refusal = await refusalOf(() => extractMemory(userId));
    assert.ok(refusal, "the extraction request was not refused");
    assert.equal(refusal.code, restriction.code);
    assert.equal(refusal.status, 403);

    assert.equal(await prisma.memoryExtractionRun.count(), 0);
    assert.equal(await prisma.memoryExtractionCreditReservation.count(), 0);
  });
}

// The other direction. A gate that refused every account would satisfy every
// test above, so these establish that an unrestricted account -- and one whose
// penalty has run out -- reaches the checks behind the gate.
const ALLOWED = [
  { label: "an ordinary account", data: {} },
  {
    label: "an account whose suspension has expired",
    data: { accountStatus: "suspended", accountSuspendedUntil: past() },
  },
  {
    label: "an account whose AI restriction has expired",
    data: { aiUsageRestricted: true, aiUsageRestrictedUntil: past() },
  },
] as const;

for (const allowed of ALLOWED) {
  test(`${allowed.label} is not refused by the account gate`, async () => {
    const userId = await seedUser(allowed.data);

    assert.equal(await refusalOf(() => generateImage(userId)), null);
    assert.equal(await refusalOf(() => extractMemory(userId)), null);
  });
}

// An expiry that is read but never written would let a fixed-term penalty run
// forever from the account owner's point of view while the row still says
// "suspended". The clear is the same code path the refusal skipped.
test("an expired suspension is cleared, not merely ignored", async () => {
  const userId = await seedUser({
    accountStatus: "suspended",
    accountSuspendedUntil: past(),
    accountSuspensionReason: "a reason that should not outlive the suspension",
  });

  await refusalOf(() => generateImage(userId));

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(user.accountStatus, "active");
  assert.equal(user.accountSuspendedUntil, null);
  assert.equal(user.accountSuspensionReason, null);
});

test("an expired AI restriction is cleared, not merely ignored", async () => {
  const userId = await seedUser({
    aiUsageRestricted: true,
    aiUsageRestrictedUntil: past(),
    aiUsageRestrictionReason: "a reason that should not outlive the restriction",
  });

  await refusalOf(() => extractMemory(userId));

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(user.aiUsageRestricted, false);
  assert.equal(user.aiUsageRestrictedUntil, null);
  assert.equal(user.aiUsageRestrictionReason, null);
});

// A suspension with no end date is indefinite and must not expire on its own.
test("an open-ended suspension does not expire", async () => {
  const userId = await seedUser({
    accountStatus: "suspended",
    accountSuspendedUntil: null,
  });

  const refusal = await refusalOf(() => generateImage(userId));
  assert.ok(refusal, "an open-ended suspension was not enforced");
  assert.equal(refusal.code, "ACCOUNT_SUSPENDED");

  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  assert.equal(user.accountStatus, "suspended");
});
