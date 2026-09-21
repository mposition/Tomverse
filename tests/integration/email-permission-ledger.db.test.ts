import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { decisionAllowed } from "@/lib/emailPermissionLedgerCore";

/**
 * The permission ledger's constraints and triggers.
 *
 * Contract: docs/policy/email-product-news-redesign-draft.md, sections 5.6, 6,
 * 7.6 and 7.8. Data model: docs/policy/email-notifications.md section 10.2.1.
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
       "EmailSendApproval", "EmailPermissionEvent", "EmailDelivery", "EmailEvent",
       "TemplateVersion", "EmailTemplate" RESTART IDENTITY CASCADE`
  );

const createUser = () =>
  prisma.user.create({
    data: { email: `permission-ledger-${randomUUID()}@example.test` },
  });

/** The active policy version, or one made for the test if none exists. */
const policyVersionId = async () => {
  const existing = await prisma.emailPolicyVersion.findFirst({
    orderBy: { createdAt: "asc" },
  });
  if (existing) return existing.id;
  const created = await prisma.emailPolicyVersion.create({
    data: {
      version: `ledger-test-${randomUUID()}`,
      changeSummary: "Created by the permission ledger integration test.",
    },
  });
  return created.id;
};

let policyId = "";
let eventId = "";
let templateVersionId = "";

/**
 * A delivery, built the way the schema needs one: a template, a published
 * version, an event and a policy version. Present because two cases are about
 * the verdict's relationship to a real delivery row -- the unique index and
 * what happens when the delivery is purged -- and neither can be shown with an
 * invented id.
 */
const seedDelivery = () =>
  prisma.emailDelivery.create({
    data: {
      eventId,
      recipientKey: `addr:${randomUUID()}@example.test`,
      lane: "standard",
      emailAddress: `to-${randomUUID()}@example.test`,
      language: "en",
      jurisdictionCountry: "AU",
      jurisdictionProfileKey: "AU",
      policyVersionId: policyId,
      templateVersionId,
      idempotencyKey: randomUUID(),
    },
  });

const seedEvent = (data: Record<string, unknown> = {}) =>
  prisma.emailPermissionEvent.create({
    data: {
      emailAddress: `evt-${randomUUID()}@example.test`,
      addressNormalizationVersion: "v1",
      kind: "notice_shown",
      scopeKey: "product_updates",
      occurredAt: new Date(),
      capturedVia: "in_product_notice",
      sourceEventKey: `notice:${randomUUID()}`,
      policyVersionId: policyId,
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
      policyVersionId: policyId,
      purposeKey: "*",
      ...data,
    },
  });

const seal = (id: string) =>
  prisma.emailSendApproval.update({
    where: { id },
    data: { sealedAt: new Date() },
  });

const seedDecision = (data: Record<string, unknown> = {}) =>
  prisma.emailPermissionDecision.create({
    data: {
      phase: "enqueue",
      purpose: "product_updates",
      classification: "marketing",
      emailAddress: `dec-${randomUUID()}@example.test`,
      addressNormalizationVersion: "v1",
      authorities: [],
      legalAllowed: true,
      blockers: [],
      allowed: true,
      policyVersionId: policyId,
      evaluatedAt: new Date(),
      ...data,
    },
  });

beforeEach(async () => {
  await resetData();
  policyId = await policyVersionId();

  const template = await prisma.emailTemplate.create({
    data: {
      key: `product_news_${randomUUID()}`,
      classification: "marketing",
      purpose: "product_updates",
      requiresUnsubscribe: true,
    },
  });
  const version = await prisma.templateVersion.create({
    data: {
      templateId: template.id,
      version: 1,
      language: "en",
      subject: "s",
      bodyHtml: "<p>s</p>",
      bodyText: "s",
      contentHash: "hash",
      classification: "marketing",
      purpose: "product_updates",
      requiresUnsubscribe: true,
      status: "published",
      publishedAt: new Date(),
    },
  });
  templateVersionId = version.id;
  const event = await prisma.emailEvent.create({
    data: {
      kind: "product.news",
      templateId: template.id,
      payload: {},
      audienceKind: "single_user",
    },
  });
  eventId = event.id;
});
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

test("deleting an account leaves the ledger and detaches it", async () => {
  // The foreign key's SET NULL is performed as an UPDATE of the referencing
  // row, so a blanket append-only trigger would make deleting an account fail
  // as soon as it had one ledger row. That transition is the anonymisation
  // docs/policy/tomverse-chat-data-domain-registry.yaml records, and it is the
  // only update these two tables accept.
  const user = await createUser();
  const event = await seedEvent({ userId: user.id });
  const decision = await seedDecision({ userId: user.id });

  await prisma.user.delete({ where: { id: user.id } });

  const keptEvent = await prisma.emailPermissionEvent.findUnique({
    where: { id: event.id },
  });
  const keptDecision = await prisma.emailPermissionDecision.findUnique({
    where: { id: decision.id },
  });
  assert.equal(keptEvent?.userId, null);
  assert.equal(keptEvent?.kind, "notice_shown");
  assert.equal(keptDecision?.userId, null);
  assert.equal(keptDecision?.allowed, true);

  // Detaching is the only account change allowed: reattaching is not.
  const other = await createUser();
  await assert.rejects(
    prisma.emailPermissionEvent.update({
      where: { id: event.id },
      data: { userId: other.id },
    }),
    /append-only/
  );
  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { userId: other.id },
    }),
    /exactly one of/
  );
});

test("each approval type needs its own scope and no other", async () => {
  await assert.rejects(
    seedApproval({ approvalType: "obligation_waiver", purposeKey: null }),
    /scope_check/
  );
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
  await assert.rejects(seedApproval({ country: "KR" }), /scope_check/);

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

test("an approval cannot be closed before it was given", async () => {
  const approval = await seedApproval();
  await assert.rejects(
    prisma.emailSendApproval.update({
      where: { id: approval.id },
      data: { sealedAt: new Date("2020-01-01T00:00:00.000Z") },
    }),
    /sealedAt_order_check/
  );
});

test("sealing closes the approval and its whole membership", async () => {
  const user = await createUser();
  const approval = await seedApproval();
  await prisma.emailSendApprovalMember.create({
    data: {
      approvalId: approval.id,
      userId: user.id,
      addressDigest: "a".repeat(64),
      addressNormalizationVersion: "v1",
      noticeAnchorAt: new Date(),
      noticeAnchorSource: "signup",
    },
  });

  await seal(approval.id);

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
        addressNormalizationVersion: "v1",
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

test("sealing and adding a member in one statement is still refused", async () => {
  // A data-modifying CTE runs its sub-statement and the main query against the
  // same snapshot, so the row-level BEFORE trigger reads the approval as still
  // unsealed. The constraint trigger fires at the end of the statement, when
  // the parent's final state is visible.
  const user = await createUser();
  const approval = await seedApproval();

  await assert.rejects(
    prisma.$executeRawUnsafe(
      `WITH s AS (
         UPDATE "EmailSendApproval" SET "sealedAt" = now()
           WHERE "id" = $1 RETURNING "id"
       )
       INSERT INTO "EmailSendApprovalMember"
         ("id", "approvalId", "userId", "addressDigest",
          "addressNormalizationVersion", "noticeAnchorAt", "noticeAnchorSource")
       SELECT $2, s."id", $3, $4, 'v1', now(), 'signup' FROM s`,
      approval.id,
      `m-${randomUUID()}`,
      user.id,
      "d".repeat(64)
    ),
    /sealed/
  );

  assert.equal(
    await prisma.emailSendApprovalMember.count({ where: { approvalId: approval.id } }),
    0
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
  await seal(approval.id);

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

test("an override must point at an approval of the type it claims", async () => {
  const waiver = await seedApproval({
    approvalType: "obligation_waiver",
    ruleKey: "kr",
    ruleVersion: 3,
    country: "KR",
    obligationKey: "subject_prefix",
    purposeKey: null,
  });
  await seal(waiver.id);

  // The composite foreign key is (overrideApprovalId, overrideType) ->
  // (id, approvalType). Naming the id alone would let a verdict claim a
  // risk_accepted override while pointing at a waiver.
  await assert.rejects(
    seedDecision({
      legalAllowed: false,
      overrideApprovalId: waiver.id,
      overrideType: "risk_accepted",
      allowed: true,
    }),
    /foreign key|Foreign key/
  );
});

test("a verdict that used an override keeps the refusal", async () => {
  const approval = await seedApproval();
  await seal(approval.id);

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
  await seal(approval.id);
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

  await seedDecision({ legalAllowed: true, blockers: ["objected"], allowed: false });
});

test("blockers and authorities must be arrays", async () => {
  await assert.rejects(
    seedDecision({ blockers: { objected: true }, allowed: true }),
    /json_shape_check/
  );
  await assert.rejects(seedDecision({ authorities: { au: "ok" } }), /json_shape_check/);
});

test("one delivery has at most one verdict per phase", async () => {
  const delivery = await seedDelivery();

  await seedDecision({ deliveryId: delivery.id, phase: "enqueue" });
  await seedDecision({ deliveryId: delivery.id, phase: "send" });
  await assert.rejects(
    seedDecision({ deliveryId: delivery.id, phase: "send" }),
    /Unique constraint/
  );
});

test("purging a delivery leaves the verdict that permitted it", async () => {
  // The verdict is what outlives the message. Losing the delivery must not
  // take the reason it was allowed with it, so the foreign key detaches
  // rather than cascading -- and the trigger accepts that one transition.
  const delivery = await seedDelivery();
  const decision = await seedDecision({ deliveryId: delivery.id });

  await prisma.emailDelivery.delete({ where: { id: delivery.id } });

  const kept = await prisma.emailPermissionDecision.findUnique({
    where: { id: decision.id },
  });
  assert.equal(kept?.deliveryId, null);
  assert.equal(kept?.allowed, true);
});

test("a verdict's delivery has to exist", async () => {
  await assert.rejects(
    seedDecision({ deliveryId: `missing-${randomUUID()}` }),
    /foreign key|Foreign key/
  );
  await assert.rejects(seedDecision({ phase: "sending" }), /phase_check/);
});

test("a verdict takes exactly one transition, each once", async () => {
  const decision = await seedDecision();

  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { allowed: false },
    }),
    /exactly one of/
  );
  await assert.rejects(
    prisma.emailPermissionDecision.delete({ where: { id: decision.id } }),
    /cannot be deleted/
  );

  // Two transitions in one update is refused rather than silently applied.
  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { sealedAt: new Date(), providerSubmittedAt: new Date() },
    }),
    /exactly one of/
  );

  // Smuggling another column in with a permitted transition raises rather than
  // being restored: a write that silently does nothing looks like it worked.
  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { sealedAt: new Date(), purpose: "promotions" },
    }),
    /may not change any other column/
  );

  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { sealedAt: new Date() },
  });
  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { sealedAt: new Date() },
    }),
    /exactly one of/
  );

  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { providerSubmittedAt: new Date() },
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
    /exactly one of/
  );
});

test("a verdict cannot reach the provider before its evidence closes", async () => {
  const decision = await seedDecision();
  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { providerSubmittedAt: new Date() },
    }),
    /submitted_after_sealed_check/
  );
});

test("evidence cites exactly one ledger, and closes with the verdict", async () => {
  const event = await seedEvent();
  const decision = await seedDecision();

  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: { decisionId: decision.id, authority: "au_sender" },
    }),
    /one_source_check/
  );

  const consent = await prisma.consentRecord.findFirst();
  if (consent) {
    await assert.rejects(
      prisma.emailPermissionDecisionEvidence.create({
        data: {
          decisionId: decision.id,
          eventId: event.id,
          consentRecordId: consent.id,
          authority: "au_sender",
        },
      }),
      /one_source_check/
    );
  }

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

  // The same event may back two authorities.
  await prisma.emailPermissionDecisionEvidence.create({
    data: { decisionId: decision.id, eventId: event.id, authority: "recipient" },
  });
  assert.equal(
    await prisma.emailPermissionDecisionEvidence.count({
      where: { decisionId: decision.id },
    }),
    2
  );

  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { sealedAt: new Date() },
  });

  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: { decisionId: decision.id, eventId: event.id, authority: "third" },
    }),
    /sealed/
  );
});

test("sealing a verdict and adding evidence in one statement is refused", async () => {
  const event = await seedEvent();
  const decision = await seedDecision();

  await assert.rejects(
    prisma.$executeRawUnsafe(
      `WITH s AS (
         UPDATE "EmailPermissionDecision" SET "sealedAt" = now()
           WHERE "id" = $1 RETURNING "id"
       )
       INSERT INTO "EmailPermissionDecisionEvidence"
         ("id", "decisionId", "eventId", "authority")
       SELECT $2, s."id", $3, 'au_sender' FROM s`,
      decision.id,
      `ev-${randomUUID()}`,
      event.id
    ),
    /sealed/
  );

  assert.equal(
    await prisma.emailPermissionDecisionEvidence.count({
      where: { decisionId: decision.id },
    }),
    0
  );
});

test("the classification list is closed", async () => {
  await assert.rejects(
    seedDecision({ classification: "release_notes" }),
    /classification_check/
  );
});
