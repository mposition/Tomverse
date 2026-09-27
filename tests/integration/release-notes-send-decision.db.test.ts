import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import { evidenceOf, recordSendDecision } from "@/lib/releaseNotesSendDecision";
import {
  releaseNotesSendVerdict,
  type SendVerdict,
  type SendVerdictInput,
} from "@/lib/releaseNotesSendVerdictCore";

// The verdict, written down and sealed.
//
// Contract: docs/policy/email-product-news-redesign-draft.md section 7.6.
//
// What needs a database: that the evidence a verdict cited is rows the database
// will not let go of, that the seal closes the set in the same transaction, and
// that a second attempt at one phase of one delivery cannot rewrite the first.
// The verdict itself is unit-tested in tests/releaseNotesSendVerdictCore.test.mjs;
// the column-level shape of `EmailPermissionDecision` belongs to
// tests/integration/email-permission-ledger.db.test.ts and is not restated here.

const EPOCH = new Date("2026-09-01T00:00:00.000Z");
const NOW = new Date("2026-10-01T00:00:00.000Z");

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailPermissionDecisionEvidence", "EmailPermissionDecision",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ConsentRecord",
      "JurisdictionCountryMap", "JurisdictionProfile",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

let policyVersionId = "";
let templateVersionId = "";
let eventId = "";

/** A template, a published version and an event, which a delivery needs. */
const seedTemplates = async () => {
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
      publishedAt: EPOCH,
    },
    select: { id: true },
  });
  templateVersionId = version.id;
  const event = await prisma.emailEvent.create({
    data: {
      kind: "product.news",
      templateId: template.id,
      payload: {},
      audienceKind: "single_user",
    },
    select: { id: true },
  });
  eventId = event.id;
};

const seedDelivery = (emailAddress: string) =>
  prisma.emailDelivery.create({
    data: {
      eventId,
      recipientKey: `addr:${emailAddress}`,
      lane: "standard",
      emailAddress,
      language: "en",
      jurisdictionCountry: "AU",
      jurisdictionProfileKey: "AU",
      policyVersionId,
      templateVersionId,
      idempotencyKey: randomUUID(),
    },
    select: { id: true },
  });

const account = () =>
  prisma.user.create({
    data: { email: `s9-${randomUUID().slice(0, 8)}@example.test` },
    select: { id: true, email: true },
  });

const consent = (userId: string, emailAddress: string) =>
  prisma.consentRecord.create({
    data: {
      userId,
      emailAddress,
      purpose: "product_news",
      action: "granted",
      jurisdiction: "AU",
      jurisdictionSource: "self_declared",
      policyVersionId,
      capturedVia: "signup_form",
      occurredAt: EPOCH,
    },
    select: { id: true },
  });

const verdictFor = (evidenceIds: string[], overrides: Partial<SendVerdictInput> = {}) =>
  releaseNotesSendVerdict({
    purpose: "product_news",
    policyVersionId,
    countries: ["AU"],
    rules: [
      {
        countryCode: "AU",
        ruleKey: "release-notes:AU",
        ruleVersion: 1,
        basis: "express_consent",
        status: "open",
      },
    ],
    obligations: {},
    readiness: {},
    waivers: [],
    recipient: { suppressed: false, objected: false, consent: { express: true, evidenceIds } },
    flags: { marketingEnabled: true, releaseNotesEnabled: true },
    display: { pinnedDisplayContractHash: "hash-1", requiredDisplayContractHash: "hash-1" },
    override: null,
    phase: "send",
    now: NOW,
    ...overrides,
  });

const write = (
  verdict: SendVerdict,
  input: {
    deliveryId: string | null;
    userId: string;
    emailAddress: string;
    phase: "enqueue" | "send";
  }
) =>
  prisma.$transaction((tx) =>
    recordSendDecision(tx, {
      deliveryId: input.deliveryId,
      userId: input.userId,
      phase: input.phase,
      purpose: "product_news",
      classification: "marketing",
      emailAddress: input.emailAddress,
      addressNormalizationVersion: "v1",
      verdict,
      countryCandidates: [{ country: "AU", signal: "billing_country" }],
      suppressionCheckedAt: NOW,
      providerSubmittedAt: null,
      evidence: evidenceOf(verdict),
    })
  );

before(async () => {
  await reset();
  ({ version: { id: policyVersionId } } = await ensureJurisdictionPolicyDraft({
    version: `test-${randomUUID()}`,
  }));
  await seedTemplates();
});
beforeEach(() =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE "EmailPermissionDecisionEvidence", "EmailPermissionDecision",
                   "EmailDelivery", "ConsentRecord", "User" CASCADE
  `)
);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a verdict is written with the evidence it cited, and sealed", async () => {
  const user = await account();
  const record = await consent(user.id, user.email!);
  const delivery = await seedDelivery(user.email!);
  const verdict = verdictFor([record.id]);

  const recorded = await write(verdict, {
    deliveryId: delivery.id,
    userId: user.id,
    emailAddress: user.email!,
    phase: "send",
  });
  assert.equal(recorded.recorded, true);

  const stored = await prisma.emailPermissionDecision.findUniqueOrThrow({
    where: { id: recorded.decisionId },
    select: {
      allowed: true,
      legalAllowed: true,
      blockers: true,
      sealedAt: true,
      displayContractSatisfied: true,
      evidence: { select: { authority: true, consentRecordId: true } },
    },
  });
  assert.equal(stored.allowed, true);
  assert.equal(stored.legalAllowed, true);
  assert.deepEqual(stored.blockers, []);
  assert.ok(stored.sealedAt, "an unsealed verdict could acquire support afterwards");
  assert.equal(stored.displayContractSatisfied, true);
  // Both authorities rested on the same consent, and each cites it once. The
  // evidence comes from the verdict rather than from the caller, so it cannot
  // name a row the verdict did not use.
  assert.deepEqual(stored.evidence.map((row) => row.authority).sort(), [
    "au_sender",
    "recipient",
  ]);
  for (const row of stored.evidence) assert.equal(row.consentRecordId, record.id);
});

test("the consent a verdict cited cannot be deleted from under it", async () => {
  // Why the evidence is rows rather than ids in a blob: "what did this rest on"
  // has to stay answerable.
  const user = await account();
  const record = await consent(user.id, user.email!);
  const delivery = await seedDelivery(user.email!);
  const verdict = verdictFor([record.id]);
  await write(verdict, {
    deliveryId: delivery.id,
    userId: user.id,
    emailAddress: user.email!,
    phase: "send",
  });

  await assert.rejects(
    () => prisma.consentRecord.delete({ where: { id: record.id } }),
    (error: unknown) => {
      assert.match(
        error instanceof Error ? error.message : String(error),
        /[Ff]oreign key|constraint/
      );
      return true;
    }
  );
});

test("one phase of one delivery is recorded once, and a differing retry reports it", async () => {
  // Sealed means the first verdict of a phase is the record. A second attempt
  // cannot rewrite it, so it is reported instead -- and a caller that sent
  // anyway would be sending under a verdict nobody wrote down.
  const user = await account();
  const record = await consent(user.id, user.email!);
  const delivery = await seedDelivery(user.email!);
  const at = { deliveryId: delivery.id, userId: user.id, emailAddress: user.email!, phase: "send" as const };

  const first = await write(verdictFor([record.id]), at);
  assert.equal(first.recorded, true);

  // The same verdict again: not recorded, and not a difference either.
  const again = await write(verdictFor([record.id]), at);
  assert.equal(again.recorded, false);
  assert.equal(again.decisionId, first.decisionId);
  assert.equal(again.differs, false);
  assert.equal(again.existingAllowed, true);

  // A suppression that arrived since: the same phase, a different answer.
  const suppressed = await write(
    verdictFor([record.id], {
      recipient: {
        suppressed: true,
        objected: false,
        consent: { express: true, evidenceIds: [record.id] },
      },
    }),
    at
  );
  assert.equal(suppressed.recorded, false);
  assert.equal(suppressed.differs, true);
  assert.equal(suppressed.existingAllowed, true);
  assert.equal(await prisma.emailPermissionDecision.count(), 1);

  // The other phase of the same delivery is its own row: the interesting
  // question afterwards is what changed between them.
  const enqueue = await write(verdictFor([record.id]), { ...at, phase: "enqueue" });
  assert.equal(enqueue.recorded, true);
  assert.equal(await prisma.emailPermissionDecision.count(), 2);
});

test("a preview has no delivery, so two of them are two rows", async () => {
  // Section 7.6 asks the same verdict to answer for an audience estimate, which
  // writes no delivery at all. Nothing to be unique on, and nothing that should
  // be: two estimates are two facts.
  const user = await account();
  const verdict = verdictFor([], {
    recipient: { suppressed: true, objected: false, consent: { express: false, evidenceIds: [] } },
  });
  const at = { deliveryId: null, userId: user.id, emailAddress: user.email!, phase: "enqueue" as const };
  const a = await write(verdict, at);
  const b = await write(verdict, at);
  assert.equal(a.recorded, true);
  assert.equal(b.recorded, true);
  assert.notEqual(a.decisionId, b.decisionId);

  const stored = await prisma.emailPermissionDecision.findUniqueOrThrow({
    where: { id: a.decisionId },
    select: { allowed: true, blockers: true, deliveryId: true, evidence: { select: { id: true } } },
  });
  assert.equal(stored.allowed, false);
  assert.deepEqual(stored.blockers, ["suppressed"]);
  assert.equal(stored.deliveryId, null);
  // A refused verdict with no express consent cites nothing, and citing nothing
  // is not the same as citing something that does not exist.
  assert.deepEqual(stored.evidence, []);
});
