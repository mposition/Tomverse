import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { decisionAllowed } from "@/lib/emailPermissionLedgerCore";

/**
 * The permission ledger's constraints and triggers.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.6, 6,
 * 7.6 and 7.8.
 *
 * What is under test is the **database**, so every case writes straight to it.
 * An append-only ledger enforced only in the service is one a migration, an
 * admin script or next year's code path can rewrite, and the row it rewrites
 * is the evidence that a send was permitted. Routing these through a service
 * would prove the service agrees with itself and nothing about the ledger.
 */

const resetData = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "EmailPermissionDecisionEvidence", "EmailPermissionDecision",
       "EmailSendApprovalRevocation", "EmailSendApprovalMember",
       "EmailSendApproval", "EmailPermissionEvent" RESTART IDENTITY CASCADE`
  );

const createUser = () =>
  prisma.user.create({
    data: { email: `permission-ledger-${randomUUID()}@example.test` },
  });

const seedEvent = (data: Record<string, unknown> = {}) =>
  prisma.emailPermissionEvent.create({
    data: {
      emailAddress: `evt-${randomUUID()}@example.test`,
      kind: "notice_shown",
      scopeKey: "product_updates",
      occurredAt: new Date(),
      capturedVia: "in_product_notice",
      sourceEventKey: `notice:${randomUUID()}`,
      ...data,
    },
  });

const seedApproval = (data: Record<string, unknown> = {}) =>
  prisma.emailSendApproval.create({
    data: {
      approvalType: "risk_accepted",
      approvedById: "owner",
      approvedByEmail: "owner@example.test",
      approvedAt: new Date(),
      reason: "78 accounts, all reached through personal contact",
      reviewCondition: "any organic signup, unsubscribe or complaint",
      purposeKey: "*",
      ...data,
    },
  });

const seedDecision = (data: Record<string, unknown> = {}) =>
  prisma.emailPermissionDecision.create({
    data: {
      deliveryId: `d-${randomUUID()}`,
      phase: "enqueue",
      purpose: "product_updates",
      classification: "marketing",
      emailAddress: `dec-${randomUUID()}@example.test`,
      authorities: [],
      legalAllowed: true,
      blockers: [],
      allowed: true,
      evaluatedAt: new Date(),
      ...data,
    },
  });

beforeEach(resetData);
after(async () => {
  await resetData();
  await prisma.$disconnect();
});

test("a permission event cannot be updated or deleted", async () => {
  const event = await seedEvent();

  await assert.rejects(
    prisma.emailPermissionEvent.update({
      where: { id: event.id },
      data: { kind: "objected" },
    }),
    /append-only/
  );
  await assert.rejects(
    prisma.emailPermissionEvent.delete({ where: { id: event.id } }),
    /append-only/
  );

  const still = await prisma.emailPermissionEvent.findUnique({
    where: { id: event.id },
  });
  assert.equal(still?.kind, "notice_shown");
});

test("a retried writer adds nothing", async () => {
  const key = `notice:${randomUUID()}`;
  await seedEvent({ sourceEventKey: key });
  await assert.rejects(seedEvent({ sourceEventKey: key }), /Unique constraint/);

  // The same key under a different kind is a different fact, not a retry.
  await seedEvent({ sourceEventKey: key, kind: "objected" });
  assert.equal(
    await prisma.emailPermissionEvent.count({ where: { sourceEventKey: key } }),
    2
  );
});

test("the event's closed lists are closed", async () => {
  await assert.rejects(seedEvent({ kind: "consent_granted" }), /kind_check/);
  await assert.rejects(seedEvent({ capturedVia: "somewhere" }), /capturedVia_check/);
  await assert.rejects(seedEvent({ scopeKey: "" }), /scopeKey_not_empty_check/);
});

test("each approval type needs its own scope and no other", async () => {
  // A waiver without the obligation it waives.
  await assert.rejects(
    seedApproval({ approvalType: "obligation_waiver", purposeKey: null }),
    /scope_check/
  );
  // A waiver carrying an override's scope.
  await assert.rejects(
    seedApproval({
      approvalType: "obligation_waiver",
      ruleKey: "kr",
      ruleVersion: 3,
      country: "KR",
      obligationKey: "subject_prefix",
      purposeKey: "product_updates",
    }),
    /scope_check/
  );
  // An override carrying a waiver's scope.
  await assert.rejects(
    seedApproval({ country: "KR" }),
    /scope_check/
  );
  // Both, correctly.
  await seedApproval();
  await seedApproval({
    approvalType: "obligation_waiver",
    ruleKey: "kr",
    ruleVersion: 3,
    country: "KR",
    obligationKey: "subject_prefix",
    purposeKey: null,
  });
});

test("sealing closes the approval and its whole membership", async () => {
  const user = await createUser();
  const approval = await seedApproval();
  await prisma.emailSendApprovalMember.create({
    data: {
      approvalId: approval.id,
      userId: user.id,
      addressDigest: "a".repeat(64),
      noticeAnchorAt: new Date(),
      noticeAnchorSource: "signup",
    },
  });

  const sealedAt = new Date();
  await prisma.emailSendApproval.update({
    where: { id: approval.id },
    data: { sealedAt },
  });

  await assert.rejects(
    prisma.emailSendApproval.update({
      where: { id: approval.id },
      data: { reason: "a better reason" },
    }),
    /sealed/
  );
  await assert.rejects(
    prisma.emailSendApproval.delete({ where: { id: approval.id } }),
    /sealed/
  );

  const second = await createUser();
  await assert.rejects(
    prisma.emailSendApprovalMember.create({
      data: {
        approvalId: approval.id,
        userId: second.id,
        addressDigest: "b".repeat(64),
        noticeAnchorAt: new Date(),
        noticeAnchorSource: "signup",
      },
    }),
    /sealed/
  );
  await assert.rejects(
    prisma.emailSendApprovalMember.updateMany({
      where: { approvalId: approval.id },
      data: { addressDigest: "c".repeat(64) },
    }),
    /sealed/
  );
  await assert.rejects(
    prisma.emailSendApprovalMember.deleteMany({ where: { approvalId: approval.id } }),
    /sealed/
  );
});

test("the update that seals may not also edit", async () => {
  const approval = await seedApproval();
  await assert.rejects(
    prisma.emailSendApproval.update({
      where: { id: approval.id },
      data: { sealedAt: new Date(), reason: "edited while sealing" },
    }),
    /may not change while being sealed/
  );
  // And an ordinary update before sealing is still refused, because the row is
  // assembled inside one transaction rather than edited over time.
  await assert.rejects(
    prisma.emailSendApproval.update({
      where: { id: approval.id },
      data: { reason: "edited before sealing" },
    }),
    /may only be updated to seal it/
  );
});

test("withdrawal is a new row, never an edit", async () => {
  const approval = await seedApproval();
  await prisma.emailSendApproval.update({
    where: { id: approval.id },
    data: { sealedAt: new Date() },
  });

  const revocation = await prisma.emailSendApprovalRevocation.create({
    data: {
      approvalId: approval.id,
      revokedById: "owner",
      revokedByEmail: "owner@example.test",
      revokedAt: new Date(),
      reason: "first organic signup arrived",
    },
  });

  await assert.rejects(
    prisma.emailSendApprovalRevocation.update({
      where: { id: revocation.id },
      data: { reason: "never mind" },
    }),
    /append-only/
  );
  await assert.rejects(
    prisma.emailSendApprovalRevocation.delete({ where: { id: revocation.id } }),
    /append-only/
  );

  const still = await prisma.emailSendApproval.findUnique({
    where: { id: approval.id },
  });
  assert.equal(still?.reason, "78 accounts, all reached through personal contact");
});

test("a verdict that used an override keeps the refusal", async () => {
  const approval = await seedApproval();
  await prisma.emailSendApproval.update({
    where: { id: approval.id },
    data: { sealedAt: new Date() },
  });

  await assert.rejects(
    seedDecision({
      legalAllowed: true,
      overrideApprovalId: approval.id,
      overrideType: "risk_accepted",
      allowed: true,
    }),
    /override_keeps_refusal_check/
  );

  const kept = await seedDecision({
    legalAllowed: false,
    overrideApprovalId: approval.id,
    overrideType: "risk_accepted",
    allowed: true,
  });
  assert.equal(kept.legalAllowed, false);
  assert.equal(kept.allowed, true);
});

test("half an override is refused", async () => {
  const approval = await seedApproval();
  await assert.rejects(
    seedDecision({ legalAllowed: false, overrideApprovalId: approval.id, allowed: true }),
    /override_pair_check/
  );
  await assert.rejects(
    seedDecision({ legalAllowed: false, overrideType: "risk_accepted", allowed: false }),
    /override_pair_check/
  );
  await assert.rejects(
    seedDecision({
      legalAllowed: false,
      overrideApprovalId: approval.id,
      overrideType: "obligation_waiver",
      allowed: true,
    }),
    /overrideType_check/
  );
});

test("allowed has to follow from the rest of the row", async () => {
  const cases = [
    { legalAllowed: true, blockers: [], allowed: false },
    { legalAllowed: false, blockers: [], allowed: true },
    { legalAllowed: true, blockers: ["objected"], allowed: true },
  ];
  for (const row of cases) {
    await assert.rejects(seedDecision(row), /allowed_derivation_check/);
    assert.equal(
      decisionAllowed({
        legalAllowed: row.legalAllowed,
        overrideApplied: false,
        blockers: row.blockers,
      }),
      !row.allowed,
      "the application and the constraint must disagree with the same row"
    );
  }

  // A blocker refuses even with a basis, which is the rule the whole design
  // rests on.
  await seedDecision({ legalAllowed: true, blockers: ["objected"], allowed: false });
});

test("blockers and authorities must be arrays", async () => {
  await assert.rejects(
    seedDecision({ blockers: { objected: true }, allowed: true }),
    /json_shape_check/
  );
  await assert.rejects(
    seedDecision({ authorities: { au: "ok" } }),
    /json_shape_check/
  );
});

test("one delivery has at most one verdict per phase", async () => {
  const deliveryId = `d-${randomUUID()}`;
  await seedDecision({ deliveryId, phase: "enqueue" });
  await seedDecision({ deliveryId, phase: "send" });
  await assert.rejects(
    seedDecision({ deliveryId, phase: "send" }),
    /Unique constraint/
  );
  await assert.rejects(seedDecision({ deliveryId, phase: "sending" }), /phase_check/);
});

test("a verdict may record its provider submission once, and nothing else", async () => {
  const decision = await seedDecision();

  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { allowed: false },
    }),
    /may only be updated to record provider submission/
  );
  await assert.rejects(
    prisma.emailPermissionDecision.delete({ where: { id: decision.id } }),
    /cannot be deleted/
  );

  // The one permitted update, and an attempt to smuggle another column in with
  // it: the trigger restores every other column from the old row.
  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { providerSubmittedAt: new Date(), purpose: "promotions" },
  });
  const after = await prisma.emailPermissionDecision.findUnique({
    where: { id: decision.id },
  });
  assert.equal(after?.purpose, "product_updates");
  assert.notEqual(after?.providerSubmittedAt, null);

  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { providerSubmittedAt: new Date() },
    }),
    /complete and cannot be changed/
  );
});

test("the event a verdict cited cannot be removed from under it", async () => {
  const event = await seedEvent();
  const decision = await seedDecision();
  await prisma.emailPermissionDecisionEvidence.create({
    data: { decisionId: decision.id, eventId: event.id, authority: "au_sender" },
  });

  await assert.rejects(
    prisma.emailPermissionEvent.delete({ where: { id: event.id } }),
    /append-only/
  );
  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.updateMany({
      where: { decisionId: decision.id },
      data: { authority: "recipient" },
    }),
    /append-only/
  );
  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.deleteMany({
      where: { decisionId: decision.id },
    }),
    /append-only/
  );

  // The same event may back two authorities; the primary key is the triple.
  await prisma.emailPermissionDecisionEvidence.create({
    data: { decisionId: decision.id, eventId: event.id, authority: "recipient" },
  });
  assert.equal(
    await prisma.emailPermissionDecisionEvidence.count({
      where: { decisionId: decision.id },
    }),
    2
  );
});

test("the classification list is closed", async () => {
  await assert.rejects(
    seedDecision({ classification: "release_notes" }),
    /classification_check/
  );
});
