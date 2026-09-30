import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { decisionAllowed } from "@/lib/emailPermissionLedgerCore";
import {
  EMAIL_CLASSIFICATIONS,
  EMAIL_PURPOSES,
  EMAIL_PURPOSE_CLASSIFICATION,
} from "@/lib/emailPreferenceCore";

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

/**
 * Clears what this suite builds around the ledger, and nothing of the ledger.
 *
 * The ledger rows stay, and every assertion in this file is scoped by a
 * `where` that names the row it made: a `count` over an approval id, a source
 * event key, a decision id. Leftovers from an earlier case are invisible to
 * all of them, and the run has a database of its own
 * (scripts/run-db-integration-tests.mjs), so nothing outside this file sees
 * them either.
 *
 * Truncating them would work -- there is no TRUNCATE trigger, for the reason
 * the migration records -- and it is left undone deliberately: a suite that
 * relies on an append-only table being empty is a suite that would pass on a
 * database where the append-only claim had quietly stopped holding.
 */
const resetData = () =>
  prisma.$executeRawUnsafe(
    `TRUNCATE TABLE "EmailDelivery", "EmailEvent", "TemplateVersion",
       "EmailTemplate" RESTART IDENTITY CASCADE`
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
      occurredAt: FIXTURE_EPOCH,
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
      createdAt: at(APPROVED_AT),
      approvedAt: at(APPROVED_AT),
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
    data: { sealedAt: at(SEALED_AT) },
  });

/**
 * A verdict. Every one needs its own delivery -- a verdict is taken for a
 * message, the INSERT trigger says so, and `(deliveryId, phase)` is unique --
 * so the helper makes one unless the caller supplies it.
 *
 * `createdAt` is written rather than defaulted. The constraints order
 * `sealedAt`, `suppressionCheckedAt` and `providerSubmittedAt` at or after
 * it, and a fixture that reads the clock before three queries and then adds a
 * second is one that fails on a slow database for a reason unrelated to what
 * it tests. Writing it makes every ordering in this file exact.
 */
const FIXTURE_EPOCH = new Date("2026-09-21T00:00:00.000Z");
const at = (ms: number) => new Date(FIXTURE_EPOCH.getTime() + ms);

// An approval is given and sealed **before** the epoch, because a verdict may
// only override one that was already closed when the verdict was taken, and
// the verdicts here are evaluated at the epoch itself. The first real run of
// this suite refused three cases on exactly that ordering -- the approval was
// sealed a second after the verdict it was supposed to authorise.
const APPROVED_AT = -2_000;
const SEALED_AT = -1_000;

// Every value a constraint compares comes from `at`, including the ones
// inside raw SQL -- `now()` there would reintroduce the wall clock into an
// ordering the fixture claims is exact. `new Date()` survives only on
// columns nothing orders against -- and after this round there are none left
// in this file, so a future one is a decision rather than an oversight.

const seedDecision = async (data: Record<string, unknown> = {}) =>
  prisma.emailPermissionDecision.create({
    data: {
      deliveryId: "deliveryId" in data ? undefined : (await seedDelivery()).id,
      createdAt: FIXTURE_EPOCH,
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
      evaluatedAt: FIXTURE_EPOCH,
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
      publishedAt: FIXTURE_EPOCH,
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

test("a cohort belongs to an override, never to a waiver", async () => {
  // risk_accepted is scoped by who; obligation_waiver by which rule, country
  // and obligation. A waiver with members would be a second way to scope one
  // that nothing reads -- a list that looks like it narrows a decision and
  // does not.
  const user = await createUser();
  const waiver = await seedApproval({
    approvalType: "obligation_waiver",
    ruleKey: "kr",
    ruleVersion: 3,
    country: "KR",
    obligationKey: "subject_prefix",
    purposeKey: null,
  });

  await assert.rejects(
    prisma.emailSendApprovalMember.create({
      data: {
        approvalId: waiver.id,
        userId: user.id,
        addressDigest: "a".repeat(64),
        addressNormalizationVersion: "v1",
        noticeAnchorAt: FIXTURE_EPOCH,
        noticeAnchorSource: "signup_date_deemed",
      },
    }),
    /scoped by rule rather than by cohort/
  );

  const override = await seedApproval();
  await prisma.emailSendApprovalMember.create({
    data: {
      approvalId: override.id,
      userId: user.id,
      addressDigest: "a".repeat(64),
      addressNormalizationVersion: "v1",
      noticeAnchorAt: FIXTURE_EPOCH,
      noticeAnchorSource: "signup_date_deemed",
    },
  });
  assert.equal(
    await prisma.emailSendApprovalMember.count({ where: { approvalId: override.id } }),
    1
  );
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
      noticeAnchorAt: FIXTURE_EPOCH,
      noticeAnchorSource: "signup_date_deemed",
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
        noticeAnchorAt: FIXTURE_EPOCH,
        noticeAnchorSource: "signup_date_deemed",
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
         UPDATE "EmailSendApproval" SET "sealedAt" = $5::timestamp
           WHERE "id" = $1 RETURNING "id"
       )
       INSERT INTO "EmailSendApprovalMember"
         ("id", "approvalId", "userId", "addressDigest",
          "addressNormalizationVersion", "noticeAnchorAt", "noticeAnchorSource")
       SELECT $2, s."id", $3, $4, 'v1', $5::timestamp, 'signup_date_deemed' FROM s`,
      approval.id,
      `m-${randomUUID()}`,
      user.id,
      "d".repeat(64),
      at(1000).toISOString()
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
      data: { sealedAt: at(1000), reason: "edited while sealing" },
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
      revokedAt: at(2000),
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

test("a verdict's delivery has to exist, and it has to have one", async () => {
  await assert.rejects(
    seedDecision({ deliveryId: `missing-${randomUUID()}` }),
    /foreign key|Foreign key/
  );
  await assert.rejects(seedDecision({ phase: "sending" }), /phase_check/);

  // Nullable is for the purge. At INSERT it would be a verdict about no
  // particular message, and `(deliveryId, phase)` would stop constraining --
  // Postgres does not compare nulls, so every such row would be distinct.
  await assert.rejects(
    seedDecision({ deliveryId: null }),
    /must name one/
  );
});

test("a verdict takes exactly one transition, each once", async () => {
  // A complete send verdict, because the submission transition at the end of
  // this case has to satisfy the submission constraint -- an enqueue verdict
  // with no suppression read could never record one.
  const delivery = await seedDelivery();
  const decision = await seedDecision({
    deliveryId: delivery.id,
    phase: "send",
    suppressionCheckedAt: at(1000),
  });

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
      data: { sealedAt: at(2000), providerSubmittedAt: at(3000) },
    }),
    /exactly one of/
  );

  // Smuggling another column in with a permitted transition raises rather than
  // being restored: a write that silently does nothing looks like it worked.
  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { sealedAt: at(2000), purpose: "promotions" },
    }),
    /may not change any other column/
  );

  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { sealedAt: at(2000) },
  });
  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { sealedAt: at(2500) },
    }),
    /exactly one of/
  );

  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { providerSubmittedAt: at(3000) },
  });
  const after = await prisma.emailPermissionDecision.findUnique({
    where: { id: decision.id },
  });
  assert.equal(after?.purpose, "product_updates");
  assert.notEqual(after?.providerSubmittedAt, null);

  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { providerSubmittedAt: at(4000) },
    }),
    /exactly one of/
  );
});

test("a sent verdict still detaches when its message is purged", async () => {
  // The condition that was briefly in the persisted CHECK. Holding
  // "deliveryId is not null" there would make a sent verdict refuse to
  // detach, so the purge would fail on exactly the rows that had been sent,
  // and the retention job would stop.
  const delivery = await seedDelivery();
  const decision = await seedDecision({
    deliveryId: delivery.id,
    phase: "send",
    suppressionCheckedAt: at(1000),
  });
  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { sealedAt: at(2000) },
  });
  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { providerSubmittedAt: at(3000) },
  });

  await prisma.emailDelivery.delete({ where: { id: delivery.id } });

  const kept = await prisma.emailPermissionDecision.findUnique({
    where: { id: decision.id },
  });
  assert.equal(kept?.deliveryId, null);
  assert.notEqual(kept?.providerSubmittedAt, null);
});

test("a purged verdict cannot then record a submission", async () => {
  // Having had a delivery at the moment of submission is a fact about that
  // moment. Once the message is gone there is nothing to hand over.
  const delivery = await seedDelivery();
  const decision = await seedDecision({
    deliveryId: delivery.id,
    phase: "send",
    suppressionCheckedAt: at(1000),
  });
  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { sealedAt: at(2000) },
  });

  await prisma.emailDelivery.delete({ where: { id: delivery.id } });

  await assert.rejects(
    prisma.emailPermissionDecision.update({
      where: { id: decision.id },
      data: { providerSubmittedAt: at(3000) },
    }),
    /no delivery to submit/
  );
});

test("a provider submission has to describe a send that could have happened", async () => {
  // Handing a message over happens once, at send, only when the verdict
  // allowed it, only for a real delivery, and only after suppression was read.
  // A row saying otherwise is a record of a send that did not occur, sitting
  // in the ledger a regulator reads.
  const delivery = await seedDelivery();
  const later = at;

  const complete = {
    deliveryId: delivery.id,
    phase: "send",
    allowed: true,
    legalAllowed: true,
    blockers: [],
    createdAt: FIXTURE_EPOCH,
    evaluatedAt: FIXTURE_EPOCH,
    suppressionCheckedAt: later(1000),
    sealedAt: later(2000),
    providerSubmittedAt: later(3000),
  };

  // Each thing the constraint requires, missing one at a time.
  // Each row breaks exactly one of the constraint's conditions, so a failure
  // names the condition rather than whichever guard happened to fire first.
  // `deliveryId: null` is not here: the insert trigger refuses that before
  // this constraint is reached, and it has its own case.
  const broken = [
    { ...complete, phase: "enqueue" },
    { ...complete, allowed: false, legalAllowed: false, blockers: ["objected"] },
    { ...complete, sealedAt: null },
    { ...complete, suppressionCheckedAt: null },
    // Read after the handover, which makes 7.4's gap unmeasurable.
    { ...complete, suppressionCheckedAt: later(3500) },
    // Sealed after the handover. Still at or after createdAt, so this breaks
    // the submission ordering and not sealedAt_order_check.
    { ...complete, sealedAt: later(3500) },
    // Handed over before the evidence closed.
    { ...complete, providerSubmittedAt: later(1500) },
    // Handed over before suppression was read, and after the seal -- so this
    // breaks the suppression ordering alone. Separate from the one above:
    // two orderings are two requirements, and one row breaking both passes
    // while only one of them is enforced.
    {
      ...complete,
      sealedAt: later(1000),
      providerSubmittedAt: later(2000),
      suppressionCheckedAt: later(2500),
    },
  ];
  for (const [index, row] of broken.entries()) {
    await assert.rejects(
      seedDecision(row),
      /submission_check/,
      `case ${index} must be refused by the submission constraint, not another one`
    );
  }

  const written = await seedDecision(complete);
  assert.notEqual(written.providerSubmittedAt, null);
});

test("a withdrawal cannot precede the approval it withdraws", async () => {
  // An approval is not given until it is sealed -- before that it is a draft
  // being assembled. "Was this approval live when that message went out" is
  // answered by comparing the send against revokedAt, and a timestamp before
  // the seal makes every such comparison wrong in the same direction.
  const approval = await seedApproval();

  await assert.rejects(
    prisma.emailSendApprovalRevocation.create({
      data: {
        approvalId: approval.id,
        revokedById: "owner",
        revokedByEmail: "owner@example.test",
        revokedAt: at(2000),
        reason: "withdrawn before it was given",
      },
    }),
    /not sealed/
  );

  const sealedAt = at(1000);
  await prisma.emailSendApproval.update({
    where: { id: approval.id },
    data: { sealedAt },
  });

  await assert.rejects(
    prisma.emailSendApprovalRevocation.create({
      data: {
        approvalId: approval.id,
        revokedById: "owner",
        revokedByEmail: "owner@example.test",
        revokedAt: new Date(sealedAt.getTime() - 1000),
        reason: "backdated",
      },
    }),
    /cannot precede the seal/
  );

  await prisma.emailSendApprovalRevocation.create({
    data: {
      approvalId: approval.id,
      revokedById: "owner",
      revokedByEmail: "owner@example.test",
      revokedAt: sealedAt,
      reason: "first organic signup arrived",
    },
  });
  assert.equal(
    await prisma.emailSendApprovalRevocation.count({ where: { approvalId: approval.id } }),
    1
  );
});

/**
 * A decision, an event and a consent that are all about one person.
 *
 * Evidence now has to be about the subject the verdict is about, so a fixture
 * that seeds three different addresses no longer proves anything about
 * evidence -- it proves the trigger works, which is a different case. This
 * builds the matching set once.
 */
const seedSubject = async (authorities = ["au_sender", "recipient"]) => {
  const user = await createUser();
  const emailAddress = `subject-${randomUUID()}@example.test`;
  const delivery = await seedDelivery();

  const decision = await seedDecision({
    deliveryId: delivery.id,
    userId: user.id,
    emailAddress,
    authorities: authorities.map((authority) => ({
      authority,
      verdict: "allowed",
    })),
  });
  const event = await seedEvent({ userId: user.id, emailAddress });
  const consent = await prisma.consentRecord.create({
    data: {
      userId: user.id,
      emailAddress,
      purpose: "product_updates",
      action: "granted",
      occurredAt: FIXTURE_EPOCH,
      jurisdiction: "AU",
      jurisdictionSource: "self_reported",
      policyVersionId: policyId,
      capturedVia: "preference_center",
    },
  });

  return { user, emailAddress, decision, event, consent };
};

test("evidence cites exactly one ledger, and closes with the verdict", async () => {
  const { decision, event, consent } = await seedSubject();

  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: { decisionId: decision.id, authority: "au_sender" },
    }),
    /one_source_check/
  );

  // Both sources at once. Seeded rather than looked up: an earlier version of
  // this case read `consentRecord.findFirst()` and skipped the assertion when
  // there was none, which on a clean database was always.
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

  await prisma.emailPermissionDecisionEvidence.create({
    data: { decisionId: decision.id, eventId: event.id, authority: "au_sender" },
  });
  // A consent record backs the receiver's authority, from the ledger that owns
  // consent. This is the path that had no way to be cited at all until the
  // second source was added.
  await prisma.emailPermissionDecisionEvidence.create({
    data: {
      decisionId: decision.id,
      consentRecordId: consent.id,
      authority: "recipient",
    },
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
    3
  );

  await prisma.emailPermissionDecision.update({
    where: { id: decision.id },
    data: { sealedAt: at(1000) },
  });

  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: { decisionId: decision.id, consentRecordId: consent.id, authority: "au_sender" },
    }),
    /sealed/
  );
});

test("evidence has to be about the person the verdict is about", async () => {
  // Until 2026-09-22 a verdict for one account could cite another account's
  // notice or consent and then be sealed: permanent, unreadable false
  // evidence, in the one table whose whole value is that it is neither.
  const mine = await seedSubject();
  const theirs = await seedSubject();

  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: {
        decisionId: mine.decision.id,
        eventId: theirs.event.id,
        authority: "au_sender",
      },
    }),
    /different address|different account/
  );
  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: {
        decisionId: mine.decision.id,
        consentRecordId: theirs.consent.id,
        authority: "recipient",
      },
    }),
    /different address|different account/
  );

  // An authority the verdict never applied is a basis nothing weighed.
  const oneAuthority = await seedSubject(["au_sender"]);
  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: {
        decisionId: oneAuthority.decision.id,
        eventId: oneAuthority.event.id,
        authority: "recipient",
      },
    }),
    /did not apply authority/
  );

  // And an authority nobody defines cannot be named at all.
  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: {
        decisionId: mine.decision.id,
        eventId: mine.event.id,
        authority: "third",
      },
    }),
    /authority_check/
  );

  // A fact scoped to something the verdict did not decide is not evidence for
  // it either.
  const other = await seedEvent({
    userId: mine.user.id,
    emailAddress: mine.emailAddress,
    scopeKey: "promotions",
    sourceEventKey: `notice:${randomUUID()}`,
  });
  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: {
        decisionId: mine.decision.id,
        eventId: other.id,
        authority: "au_sender",
      },
    }),
    /scoped to/
  );
});


test("sealing a verdict and adding evidence in one statement is refused", async () => {
  // A matching subject, because the consistency trigger fires first now and a
  // mismatched one would refuse this for the wrong reason.
  const { decision, event } = await seedSubject();

  await assert.rejects(
    prisma.$executeRawUnsafe(
      `WITH s AS (
         UPDATE "EmailPermissionDecision" SET "sealedAt" = $4::timestamp
           WHERE "id" = $1 RETURNING "id"
       )
       INSERT INTO "EmailPermissionDecisionEvidence"
         ("id", "decisionId", "eventId", "authority")
       SELECT $2, s."id", $3, 'au_sender' FROM s`,
      decision.id,
      `ev-${randomUUID()}`,
      event.id,
      at(1000).toISOString()
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

test("a fact's scope and an override's purpose are closed sets", async () => {
  // Both tables are immutable, so a typo is stored once and readable by
  // nothing afterwards.
  await assert.rejects(seedEvent({ scopeKey: "product_udpates" }), /scopeKey_check/);
  await assert.rejects(seedEvent({ scopeKey: "" }), /scopeKey_check/);
  await assert.rejects(seedEvent({ scopeKey: "anything" }), /scopeKey_check/);
  await seedEvent({ scopeKey: "*" });
  await seedEvent({ scopeKey: "marketing" });
  await seedEvent({ scopeKey: "promotions" });

  // purposeKey_check, not scope_check: these rows are the right shape for a
  // risk_accepted approval -- the purpose is non-null and no waiver column is
  // set -- and what they break is the list of purposes an override may cover.
  await assert.rejects(
    seedApproval({ purposeKey: "prmotions" }),
    /purposeKey_check/
  );
  await assert.rejects(seedApproval({ purposeKey: "" }), /purposeKey_check/);
  await assert.rejects(
    seedApproval({ purposeKey: "marketing" }),
    /purposeKey_check/
  );
  await seedApproval({ purposeKey: "*" });
  await seedApproval({ purposeKey: "newsletter" });
});

test("the purpose list is closed too", async () => {
  // A verdict names the purpose it decided. A purpose this product does not
  // send would be a permanent record about mail that does not exist.
  await assert.rejects(
    seedDecision({ purpose: "release_notes" }),
    /purpose_check/
  );
  await assert.rejects(seedDecision({ purpose: "" }), /purpose_check/);
});

test("every purpose/classification pair, and only the six", async () => {
  // Eighteen combinations, six right. Enumerated rather than listed, because a
  // hand-written list of wrong pairs is a list somebody has to keep complete --
  // the first version of this test named eight of the twelve and read as
  // though it had covered them.
  //
  // The pair that matters most is product news written down as service: that
  // is the S0 defect one verdict at a time, a row saying the marketing
  // switches did not apply to marketing mail.
  const right = new Map(
    EMAIL_PURPOSE_CLASSIFICATION.map((entry) => [entry.purpose, entry.classification])
  );
  assert.equal(right.size, EMAIL_PURPOSES.length);

  let accepted = 0;
  let refused = 0;

  for (const purpose of EMAIL_PURPOSES) {
    for (const classification of EMAIL_CLASSIFICATIONS) {
      if (right.get(purpose) === classification) {
        await seedDecision({ purpose, classification });
        accepted += 1;
      } else {
        await assert.rejects(
          seedDecision({ purpose, classification }),
          /purpose_classification_check/,
          purpose + " must not be " + classification
        );
        refused += 1;
      }
    }
  }

  assert.equal(accepted, EMAIL_PURPOSES.length);
  assert.equal(
    refused,
    EMAIL_PURPOSES.length * EMAIL_CLASSIFICATIONS.length - EMAIL_PURPOSES.length
  );
});

test("evidence cannot cite a fact from after the verdict", async () => {
  // A verdict rests on what was known when it was taken. A later notice is a
  // reason to take another verdict, not a basis for one already sealed.
  const { decision, emailAddress, user } = await seedSubject();
  const afterwards = await seedEvent({
    userId: user.id,
    emailAddress,
    occurredAt: at(60_000),
    sourceEventKey: `notice:${randomUUID()}`,
  });

  await assert.rejects(
    prisma.emailPermissionDecisionEvidence.create({
      data: {
        decisionId: decision.id,
        eventId: afterwards.id,
        authority: "au_sender",
      },
    }),
    /happened after the verdict/
  );
});

test("the consent ledger a sealed verdict cites cannot be rewritten", async () => {
  // ConsentRecord has claimed to be append-only since it was created and
  // nothing enforced it. That was survivable while it only described itself;
  // it stopped being so when a sealed verdict began citing it, because an
  // update to a cited row's address or purpose changes what that verdict
  // rested on after it was closed against exactly that.
  const { consent, user } = await seedSubject();

  await assert.rejects(
    prisma.consentRecord.update({
      where: { id: consent.id },
      data: { purpose: "promotions" },
    }),
    /append-only/
  );
  await assert.rejects(
    prisma.consentRecord.delete({ where: { id: consent.id } }),
    /append-only/
  );

  // The one update it accepts is the account going, which is the registry's
  // anonymisation for this table.
  await prisma.user.delete({ where: { id: user.id } });
  const kept = await prisma.consentRecord.findUnique({ where: { id: consent.id } });
  assert.equal(kept?.userId, null);
  assert.equal(kept?.purpose, "product_updates");
});

test("an override names an approval that was actually given", async () => {
  // Revocation, scope and cohort belong to the verdict path S9 builds, under
  // the locks it holds. Whether the approval was ever closed does not: an
  // unsealed one is a draft being assembled, and a verdict overriding it
  // recorded a decision nobody had finished making.
  const draft = await seedApproval();
  const delivery = await seedDelivery();

  await assert.rejects(
    seedDecision({
      deliveryId: delivery.id,
      legalAllowed: false,
      overrideApprovalId: draft.id,
      overrideType: "risk_accepted",
      allowed: true,
    }),
    /is not sealed and cannot override/
  );

  // And one sealed after the send was not in force when it went out.
  await prisma.emailSendApproval.update({
    where: { id: draft.id },
    data: { sealedAt: at(60_000) },
  });
  await assert.rejects(
    seedDecision({
      deliveryId: await seedDelivery().then((d) => d.id),
      legalAllowed: false,
      overrideApprovalId: draft.id,
      overrideType: "risk_accepted",
      allowed: true,
      evaluatedAt: at(1000),
    }),
    /sealed after this verdict/
  );
});

test("authorities is a list of authorities, not of strings", async () => {
  // "is an array" let a verdict seal with ["au_sender"], and the evidence
  // trigger's lookup for a->>'authority' finds nothing in a string -- so no
  // evidence could ever be attached to a verdict shaped that way, and nothing
  // would have said why.
  for (const authorities of [
    ["au_sender"],
    [{ verdict: "allowed" }],
    [{ authority: "third", verdict: "allowed" }],
    [{ authority: null }],
  ]) {
    await assert.rejects(
      seedDecision({ authorities }),
      /json_shape_check/,
      JSON.stringify(authorities)
    );
  }

  await seedDecision({
    authorities: [
      { authority: "recipient", verdict: "allowed" },
      { authority: "au_sender", verdict: "allowed" },
    ],
  });
});
