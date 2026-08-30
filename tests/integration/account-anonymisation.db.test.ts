import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { ANONYMISED_SUBJECT } from "@/lib/accountDataAnonymisation";

// The counterpart to the export's sentinel test, on the deletion side.
//
// A sentinel is planted in every column the registry says is anonymised, the
// account is deleted for real, and nothing may survive. Reading the code cannot
// establish this: the rows relate to User with onDelete: SetNull, so the
// database itself clears userId and a source scan would see an anonymisation
// that Postgres, not the application, is half-performing -- while subjectKey,
// traceId and the provider request identifiers stay exactly where they were.

const SENTINEL_PREFIX = "TVC-IDENTIFIER-SENTINEL";
const sentinels: string[] = [];

const sentinel = (label: string) => {
  const value = `${SENTINEL_PREFIX}-${label}-${randomUUID()}`;
  sentinels.push(value);
  return value;
};

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ChatLimitDecisionEvent", "ComparisonReviewRun", "ChatCreditReservation", "ImageCreditReservation",
      "MemoryExtractionCreditReservation", "Feedback", "RefundRequest",
      "AdminNote", "ModelOverride", "User"
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

const seedUser = async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@example.test`, plan: "Pro" },
  });
  const userId = user.id;

  await prisma.chatLimitDecisionEvent.create({
    data: {
      userId,
      subjectKey: sentinel("limitDecision-subjectKey"),
      traceId: sentinel("limitDecision-traceId"),
      plan: "Pro",
      phase: "pre",
      decision: "allow",
      models: {},
    },
  });

  // The AI Review operational record. Same shape of risk as the limit
  // decisions above: no relation to User, so nothing clears it on its own, and
  // the row is meant to survive the deletion without naming anybody.
  await prisma.comparisonReviewRun.create({
    data: {
      userId,
      subjectKey: sentinel("comparisonReviewRun-subjectKey"),
      traceId: sentinel("comparisonReviewRun-traceId"),
      conversationId: sentinel("comparisonReviewRun-conversationId"),
      subjectKind: "account",
      reviewMode: "balanced",
      language: "ko",
      responseCount: 2,
      promptVersion: "comparison-review-v3",
      outcome: "completed_dual",
      startedAt: new Date(),
      completedAt: new Date(),
      durationMs: 1_000,
      primaryStatus: "completed",
      secondaryStatus: "completed",
    },
  });

  await prisma.chatCreditReservation.create({
    data: {
      id: `chat-res-${randomUUID()}`,
      userId,
      subjectKey: sentinel("chatReservation-subjectKey"),
      traceId: sentinel("chatReservation-traceId"),
      source: "chat",
      provider: "openai",
      modelId: "gpt-5",
      idempotencyKey: `idem-${randomUUID()}`,
      providerRequestId: sentinel("chatReservation-providerRequestId"),
      providerResponseId: sentinel("chatReservation-providerResponseId"),
      reservationPayload: { lot: sentinel("chatReservation-reservationPayload") },
      providerUsageSnapshot: { usage: sentinel("chatReservation-providerUsageSnapshot") },
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
      costSource: "catalogue",
      pricingSnapshot: {},
      reservationPayload: { lot: sentinel("imageReservation-reservationPayload") },
      providerRequestId: sentinel("imageReservation-providerRequestId"),
    },
  });

  await prisma.memoryExtractionCreditReservation.create({
    data: {
      id: `memory-res-${randomUUID()}`,
      userId,
      runId: sentinel("memoryReservation-runId"),
      provider: "anthropic",
      extractionModelId: "claude-haiku",
      promptVersion: "v1",
      chunkTotal: 5,
      chunksCharged: 2,
      reservedCredits: 5,
      planReservedCredits: 5,
      addOnReservedCredits: 0,
      reservedCostMicroUsd: BigInt(500),
      pricingVersion: "v1",
      costSource: "catalogue",
      pricingSnapshot: {},
      reservationPayload: { lot: sentinel("memoryReservation-reservationPayload") },
    },
  });

  // The two anonymised inline in lib/accountDeletion.ts, covered here too so
  // the deletion path is tested as one thing rather than by module.
  await prisma.feedback.create({
    data: {
      userId,
      type: "bug",
      message: sentinel("feedback-message"),
      email: sentinel("feedback-email"),
      traceId: sentinel("feedback-traceId"),
      userAgent: sentinel("feedback-userAgent"),
    },
  });

  await prisma.refundRequest.create({
    data: {
      userId,
      email: sentinel("refundRequest-email"),
      stripeCustomerId: sentinel("refundRequest-stripeCustomerId"),
      stripeSubscriptionId: sentinel("refundRequest-stripeSubscriptionId"),
      reason: sentinel("refundRequest-reason"),
    },
  });

  // The two tables where the linked user is the operator. Both relations are
  // onDelete: SetNull, which cleared the id and left the address beside it.
  await prisma.adminNote.create({
    data: {
      targetType: "Feedback",
      targetId: "some-other-record",
      body: "a note this operator wrote about something else",
      createdById: userId,
      createdByEmail: sentinel("adminNote-createdByEmail"),
    },
  });
  await prisma.modelOverride.create({
    data: {
      modelId: `model-${randomUUID()}`,
      status: "disabled",
      updatedById: userId,
      updatedByEmail: sentinel("modelOverride-updatedByEmail"),
    },
  });

  // A note written *about* this user, reached only through the untyped
  // targetType/targetId pair. No foreign key connects it to anything.
  await prisma.adminNote.create({
    data: {
      targetType: "User",
      targetId: userId,
      body: sentinel("adminNote-subjectBody"),
      createdById: null,
      createdByEmail: sentinel("adminNote-subjectAuthorEmail"),
    },
  });

  return userId;
};

/** Everything that survived the deletion, as one string. */
const survivingRows = async () => {
  const [limitDecisions, reviewRuns, chat, image, memory, feedback, refunds] = await Promise.all([
    prisma.chatLimitDecisionEvent.findMany(),
    prisma.comparisonReviewRun.findMany(),
    prisma.chatCreditReservation.findMany(),
    prisma.imageCreditReservation.findMany(),
    prisma.memoryExtractionCreditReservation.findMany(),
    prisma.feedback.findMany(),
    prisma.refundRequest.findMany(),
  ]);
  const [adminNotes, modelOverrides] = await Promise.all([
    prisma.adminNote.findMany(),
    prisma.modelOverride.findMany(),
  ]);
  return {
    limitDecisions,
    reviewRuns,
    chat,
    image,
    memory,
    feedback,
    refunds,
    adminNotes,
    modelOverrides,
  };
};

const serialise = (value: unknown) =>
  JSON.stringify(value, (_key, item) => (typeof item === "bigint" ? item.toString() : item));

test("deleting the account leaves no planted identifier behind", async () => {
  const userId = await seedUser();
  assert.ok(sentinels.length >= 19, `only ${sentinels.length} sentinels were planted`);

  const result = await deleteTomverseAccount(userId, { cancelSubscription: false });
  assert.equal(result.deleted, true);

  const remaining = serialise(await survivingRows());
  const leaked = sentinels.filter((value) => remaining.includes(value));
  assert.deepEqual(leaked, [], `${leaked.length} identifier(s) survived: ${leaked.join(", ")}`);
  assert.equal(
    remaining.includes(SENTINEL_PREFIX),
    false,
    "an identifier survived in a transformed form"
  );
});

// The rows are meant to survive -- that is what distinguishes anonymise from
// delete. A test that only checks for absence would pass if deletion had
// silently become a cascade.
test("the anonymised rows survive, without their identifiers", async () => {
  const userId = await seedUser();
  await deleteTomverseAccount(userId, { cancelSubscription: false });
  const remaining = await survivingRows();

  assert.equal(remaining.limitDecisions.length, 1);
  assert.equal(remaining.reviewRuns.length, 1);
  assert.equal(remaining.reviewRuns[0].userId, null);
  assert.equal(remaining.reviewRuns[0].conversationId, null);
  // What the row exists for is untouched: the reliability history stays
  // computable after the person is gone.
  assert.equal(remaining.reviewRuns[0].outcome, "completed_dual");
  assert.equal(remaining.reviewRuns[0].durationMs, 1_000);
  assert.equal(remaining.chat.length, 1);
  assert.equal(remaining.image.length, 1);
  assert.equal(remaining.memory.length, 1);

  assert.equal(remaining.limitDecisions[0].userId, null);
  assert.equal(remaining.limitDecisions[0].subjectKey, ANONYMISED_SUBJECT);
  assert.equal(remaining.limitDecisions[0].traceId, ANONYMISED_SUBJECT);

  assert.equal(remaining.chat[0].userId, null);
  assert.equal(remaining.chat[0].providerRequestId, null);
  assert.deepEqual(remaining.chat[0].reservationPayload, {});
  assert.equal(remaining.chat[0].providerUsageSnapshot, null);

  // The financial shape is what the row is for, and it is untouched.
  assert.equal(remaining.chat[0].reservedCredits, 10);
  assert.equal(remaining.chat[0].modelId, "gpt-5");
  assert.equal(remaining.image[0].preset, "standard");
  assert.equal(remaining.memory[0].chunksCharged, 2);
});

// A shared placeholder in a UNIQUE column would make the second deletion fail
// with a constraint violation -- which, inside the deletion transaction, means
// the account cannot be deleted at all.
test("two accounts can both be deleted despite the unique anonymised columns", async () => {
  const first = await seedUser();
  const second = await seedUser();

  assert.equal((await deleteTomverseAccount(first, { cancelSubscription: false })).deleted, true);
  assert.equal((await deleteTomverseAccount(second, { cancelSubscription: false })).deleted, true);

  const image = await prisma.imageCreditReservation.findMany();
  const memory = await prisma.memoryExtractionCreditReservation.findMany();
  assert.equal(image.length, 2);
  assert.equal(memory.length, 2);
  assert.notEqual(image[0].generationId, image[1].generationId);
  assert.notEqual(memory[0].runId, memory[1].runId);
  for (const row of image) assert.match(row.generationId, /^anonymised:/);
  for (const row of memory) assert.match(row.runId, /^anonymised:/);
});

// The anonymisation is scoped to one account, and a second account's rows sit
// in the same tables.
test("deleting one account leaves another account's rows untouched", async () => {
  const doomed = await seedUser();
  const kept = await seedUser();
  const keptRowsBefore = serialise(
    await prisma.chatCreditReservation.findMany({ where: { userId: kept } })
  );

  await deleteTomverseAccount(doomed, { cancelSubscription: false });

  const keptRowsAfter = serialise(
    await prisma.chatCreditReservation.findMany({ where: { userId: kept } })
  );
  assert.equal(keptRowsAfter, keptRowsBefore);
  assert.equal((await prisma.chatCreditReservation.findMany({ where: { userId: kept } })).length, 1);
});

// The linkage no derivation over the schema can find.
//
// AdminNote.targetId points at a user by convention with no foreign key, so no
// cascade could reach it and none did: free-text notes written by staff about a
// customer outlived that customer's account entirely. Nothing in
// prisma/schema.prisma expresses the connection, which is why the registry has
// to declare it and why this has to be tested against a real deletion.
test("notes written about the user are deleted with the account", async () => {
  const userId = await seedUser();
  assert.equal(
    await prisma.adminNote.count({ where: { targetType: "User", targetId: userId } }),
    1
  );

  await deleteTomverseAccount(userId, { cancelSubscription: false });

  assert.equal(
    await prisma.adminNote.count({ where: { targetType: "User", targetId: userId } }),
    0
  );
});

// The other half of the same tables: the operator's own address, which the
// SetNull relation left sitting beside the id it cleared.
test("an operator's address does not survive their own account deletion", async () => {
  const userId = await seedUser();
  await deleteTomverseAccount(userId, { cancelSubscription: false });

  const notes = await prisma.adminNote.findMany();
  const overrides = await prisma.modelOverride.findMany();

  // The note about something else survives -- it is a record about that thing,
  // not about its author -- but carries neither the author's id nor address.
  assert.equal(notes.length, 1);
  assert.equal(notes[0].createdById, null);
  assert.equal(notes[0].createdByEmail, null);
  assert.match(notes[0].body, /about something else/);

  // The override is global configuration and stays; only the operator stamp goes.
  assert.equal(overrides.length, 1);
  assert.equal(overrides[0].updatedById, null);
  assert.equal(overrides[0].updatedByEmail, null);
  assert.equal(overrides[0].status, "disabled");
});
