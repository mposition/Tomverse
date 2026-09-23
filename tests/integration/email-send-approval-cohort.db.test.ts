import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  approvalAddressDigest,
  cohortStanding,
  riskAcceptedApprovalSummary,
  sealRiskAcceptedApproval,
} from "@/lib/emailSendApprovalCohort";
import {
  recordNoticeObjection,
  recordNoticeShown,
} from "@/lib/inProductConsentNotice";

/**
 * The ledger's first real writers, against the real database.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.4,
 * 5.6 and 6.
 *
 * The unit tests decide; these show that what the writers produce survives the
 * constraints and triggers S3 installed. Two things in particular cannot be
 * shown any other way: that a sealed approval is genuinely immutable, and that
 * recording a notice twice adds one row rather than raising the append-only
 * trigger. The second is why this file exists at all -- the writer was an
 * upsert first, and an upsert's second branch is an UPDATE the trigger
 * refuses.
 */

const createUser = (signupAt?: Date) =>
  prisma.user.create({
    data: {
      email: `cohort-${randomUUID()}@example.test`,
      ...(signupAt ? { createdAt: signupAt } : {}),
    },
  });

const policyVersionId = async () => {
  const existing = await prisma.emailPolicyVersion.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.id;
  const created = await prisma.emailPolicyVersion.create({
    data: {
      version: `cohort-test-${randomUUID()}`,
      changeSummary: "Created by the send approval cohort integration test.",
    },
  });
  return created.id;
};

const approvedAt = new Date("2026-09-16T00:00:00.000Z");

const sealFor = async (users: { id: string; email: string | null }[]) =>
  sealRiskAcceptedApproval({
    approvedById: users[0]!.id,
    approvedByEmail: users[0]!.email!,
    approvedAt,
    reason:
      "Owner decision 2026-09-16: send to the existing accounts with no basis.",
    reviewCondition:
      "Re-decide on the first organic signup, unsubscribe or complaint.",
    policyVersionId: await policyVersionId(),
    purposeKey: "*",
    candidates: users.map((user) => ({
      userId: user.id,
      emailAddress: user.email!,
      signupAt: approvedAt,
    })),
  });

test("the seal is the row's own instant, not a date the caller picked", async () => {
  // `sealedAt >= createdAt` where createdAt is the transaction's start on the
  // database's clock. Every value a caller could reasonably pass -- the day
  // the owner decided, or a `new Date()` read just before the transaction
  // opened -- is earlier than that, so the caller does not pass one at all.
  const users = [await createUser()];
  const approval = await sealFor(users);

  assert.deepEqual(approval.sealedAt, approval.createdAt);
  assert.ok(approval.sealedAt! >= approval.approvedAt);
});

test("an approval dated in the future is refused by name", async () => {
  const users = [await createUser()];
  await assert.rejects(
    sealRiskAcceptedApproval({
      approvedById: users[0]!.id,
      approvedByEmail: users[0]!.email!,
      approvedAt: new Date(Date.now() + 86_400_000),
      reason: "Dated tomorrow.",
      reviewCondition: "Never.",
      policyVersionId: await policyVersionId(),
      purposeKey: "*",
      candidates: [
        {
          userId: users[0]!.id,
          emailAddress: users[0]!.email!,
          signupAt: approvedAt,
        },
      ],
    }),
    /seals_before_approval/
  );
  // Refused by name rather than by a raw CHECK violation, and nothing landed.
  assert.equal(
    await prisma.emailSendApprovalMember.count({
      where: { userId: users[0]!.id },
    }),
    0
  );
});

test("a sealed approval carries its exact membership", async () => {
  const users = [await createUser(), await createUser()];
  const approval = await sealFor(users);

  assert.ok(approval.sealedAt);
  const summary = await riskAcceptedApprovalSummary({
    approvalId: approval.id,
  });
  assert.equal(summary?.memberCount, 2);
  assert.equal(summary?.revoked, false);
  // Rule 3: the reason and the review condition are on the screen, not only
  // the count. A screen that showed the count alone reads as consent.
  assert.match(summary!.reason, /no basis/);
  assert.ok(summary!.reviewCondition.length > 0);
});

test("a sealed approval cannot be changed afterwards", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  await assert.rejects(
    prisma.emailSendApproval.update({
      where: { id: approval.id },
      data: { reason: "Something else entirely." },
    }),
    /sealed and cannot be changed/
  );
});

test("the address is stored as a digest, never as the address", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  const member = await prisma.emailSendApprovalMember.findFirstOrThrow({
    where: { approvalId: approval.id },
  });
  assert.equal(member.addressDigest, approvalAddressDigest(users[0]!.email!));
  assert.ok(!member.addressDigest.includes("@"));
  assert.equal(member.noticeAnchorSource, "signup_date_deemed");
});

test("the same mailbox in a different case is the same member", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  const standing = await cohortStanding({
    approvalId: approval.id,
    userId: users[0]!.id,
    deliveryEmailAddress: users[0]!.email!.toUpperCase(),
  });
  assert.deepEqual(standing, { inCohort: true, approvalId: approval.id });
});

test("changing the address after the seal takes the delivery out", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);

  await prisma.user.update({
    where: { id: users[0]!.id },
    data: { email: `moved-${randomUUID()}@example.test` },
  });

  const standing = await cohortStanding({
    approvalId: approval.id,
    userId: users[0]!.id,
    // The delivery still carries the approved address. That is the case the
    // three-digest rule exists for: the approval was about a mailbox this
    // person has since left.
    deliveryEmailAddress: users[0]!.email!,
  });
  assert.deepEqual(standing, {
    inCohort: false,
    reason: "current_address_changed",
  });
});

test("a withdrawn approval covers nobody, including its own members", async () => {
  // Section 5.6 rule 6. Reading membership alone would keep sending to the
  // same addresses after the decision had been reversed, with the admin
  // screen's "revoked" sitting next to a send that ignored it.
  const users = [await createUser()];
  const approval = await sealFor(users);

  const before = await cohortStanding({
    approvalId: approval.id,
    userId: users[0]!.id,
    deliveryEmailAddress: users[0]!.email!,
  });
  assert.equal(before.inCohort, true);

  await prisma.emailSendApprovalRevocation.create({
    data: {
      approvalId: approval.id,
      revokedById: users[0]!.id,
      revokedByEmail: users[0]!.email!,
      revokedAt: new Date(),
      reason: "An organic signup arrived, which is the review condition.",
    },
  });

  assert.deepEqual(
    await cohortStanding({
      approvalId: approval.id,
      userId: users[0]!.id,
      deliveryEmailAddress: users[0]!.email!,
    }),
    { inCohort: false, reason: "revoked" }
  );
});

test("an approval that does not exist is not a missing account", async () => {
  assert.deepEqual(
    await cohortStanding({
      approvalId: "no-such-approval",
      userId: null,
      deliveryEmailAddress: null,
    }),
    { inCohort: false, reason: "no_approval" }
  );
});

test("an account that joined after the seal is in no cohort", async () => {
  const users = [await createUser()];
  const approval = await sealFor(users);
  const latecomer = await createUser();

  const standing = await cohortStanding({
    approvalId: approval.id,
    userId: latecomer.id,
    deliveryEmailAddress: latecomer.email!,
  });
  assert.deepEqual(standing, { inCohort: false, reason: "not_a_member" });
});

// --- the in-product notice ------------------------------------------------

const noticeInput = (user: { id: string; email: string | null }) => ({
  userId: user.id,
  emailAddress: user.email!,
  surface: "in-product-consent-notice",
  copyHash: "sha256:placeholder-until-S2-approves-the-wording",
});

test("recording the same render twice leaves one row", async () => {
  const user = await createUser();
  const first = await recordNoticeShown(noticeInput(user));
  const second = await recordNoticeShown(noticeInput(user));

  assert.equal(first.id, second.id);
  assert.equal(
    await prisma.emailPermissionEvent.count({
      where: { userId: user.id, kind: "notice_shown" },
    }),
    1
  );
});

test("a dismissal records that we asked and nothing about refusing", async () => {
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));

  assert.equal(
    await prisma.emailPermissionEvent.count({
      where: { userId: user.id, kind: "objected" },
    }),
    0
  );
  const shown = await prisma.emailPermissionEvent.findFirstOrThrow({
    where: { userId: user.id, kind: "notice_shown" },
  });
  assert.equal(shown.capturedVia, "in_product_notice");
  assert.equal(shown.scopeKey, "marketing");
});

test("a refusal and a render are two separate facts", async () => {
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));
  await recordNoticeObjection(noticeInput(user));

  const kinds = await prisma.emailPermissionEvent.findMany({
    where: { userId: user.id },
    select: { kind: true },
    orderBy: { kind: "asc" },
  });
  assert.deepEqual(
    kinds.map((row) => row.kind),
    ["notice_shown", "objected"]
  );
});

test("a notice event cannot say which words were on the screen later", async () => {
  const user = await createUser();
  const event = await recordNoticeShown(noticeInput(user));

  // The copy hash is evidence, so the row refuses to be corrected after the
  // fact -- including by the writer that made it.
  await assert.rejects(
    prisma.emailPermissionEvent.update({
      where: { id: event.id },
      data: { evidence: { surface: "elsewhere", copyHash: "different" } },
    }),
    /append-only|accepts no change/
  );
});

test("refusing again at a new address records a refusal for that address", async () => {
  // The key was the account alone, and this was the silent failure: the second
  // write collided with the first, returned it, and reported success, leaving
  // the new address with no refusal on it at all.
  const user = await createUser();
  await recordNoticeObjection(noticeInput(user));

  const movedTo = `moved-${randomUUID()}@example.test`;
  await prisma.user.update({ where: { id: user.id }, data: { email: movedTo } });
  await recordNoticeObjection({ ...noticeInput(user), emailAddress: movedTo });

  const objections = await prisma.emailPermissionEvent.findMany({
    where: { userId: user.id, kind: "objected" },
    select: { emailAddress: true },
  });
  assert.equal(objections.length, 2);
  assert.ok(objections.some((row) => row.emailAddress === movedTo));
});

test("a render is still recorded once however the address moves", async () => {
  // The opposite scoping, and on purpose: the notice happened to a person.
  const user = await createUser();
  await recordNoticeShown(noticeInput(user));

  const movedTo = `moved-${randomUUID()}@example.test`;
  await prisma.user.update({ where: { id: user.id }, data: { email: movedTo } });
  await recordNoticeShown({ ...noticeInput(user), emailAddress: movedTo });

  assert.equal(
    await prisma.emailPermissionEvent.count({
      where: { userId: user.id, kind: "notice_shown" },
    }),
    1
  );
});

test("a notice event without a copy hash is refused before it is written", async () => {
  const user = await createUser();
  await assert.rejects(
    recordNoticeShown({ ...noticeInput(user), copyHash: "  " }),
    /hash of the words/
  );
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { userId: user.id } }),
    0
  );
});
