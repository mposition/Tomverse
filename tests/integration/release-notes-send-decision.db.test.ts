import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import type { Prisma } from "@prisma/client";

import { evidenceOf, recordProviderSubmission, recordSendDecision } from "@/lib/releaseNotesSendDecision";
import { skipAndReenqueue } from "@/lib/releaseNotesReenqueue";
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
      purpose: "product_updates",
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
    purpose: "product_updates",
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
      purpose: "product_updates",
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

// The replacement a moved display contract produces.
//
// Two defects an independent review found lived here and no test saw either.
// The replacement carried no `renderDataSnapshot`, so it could never render and
// the drain closed it as a permanent `failed`; and it copied the predecessor's
// pinned profile while carrying the new contract's hash, so the next drain found
// the hashes equal and printed the old country's footer under the new country's
// contract. Both are about what the database row holds, so both are asserted on
// the row.

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

const claimedDelivery = async (emailAddress: string) => {
  const created = await seedDelivery(emailAddress);
  return prisma.emailDelivery.update({
    where: { id: created.id },
    data: {
      displayContractHash: HASH_A,
      renderDataSnapshot: { v: 1, sealed: "opaque-ciphertext" },
    },
    select: {
      id: true,
      eventId: true,
      recipientKey: true,
      userId: true,
      emailAddress: true,
      language: true,
      lane: true,
      generation: true,
      rootDeliveryId: true,
      attempts: true,
      renderDataSnapshot: true,
    },
  });
};

test("a replacement carries the message and the new contract's own profile", async () => {
  const user = await account();
  const predecessor = await claimedDelivery(user.email!);

  const result = await prisma.$transaction((tx) =>
    skipAndReenqueue(tx, {
      delivery: {
        ...predecessor,
        renderDataSnapshot: predecessor.renderDataSnapshot as Prisma.InputJsonValue,
      },
      current: {
        templateVersionId,
        policyVersionId,
        // The recipient moved from Australia to Korea between enqueue and send.
        jurisdictionCountry: "KR",
        jurisdictionProfileKey: "KR",
        displayContractHash: HASH_B,
      },
    })
  );
  assert.equal(result.reenqueued, true);
  if (!result.reenqueued) return;

  const [before, replacement] = await Promise.all([
    prisma.emailDelivery.findUniqueOrThrow({
      where: { id: predecessor.id },
      select: { status: true, skipReason: true },
    }),
    prisma.emailDelivery.findUniqueOrThrow({
      where: { id: result.deliveryId },
      select: {
        generation: true,
        supersedesDeliveryId: true,
        rootDeliveryId: true,
        jurisdictionCountry: true,
        jurisdictionProfileKey: true,
        displayContractHash: true,
        renderDataSnapshot: true,
        status: true,
      },
    }),
  ]);

  assert.deepEqual(before, { status: "skipped", skipReason: "display_contract_changed" });
  assert.equal(replacement.status, "pending");
  assert.equal(replacement.generation, predecessor.generation + 1);
  assert.equal(replacement.supersedesDeliveryId, predecessor.id);
  assert.equal(replacement.rootDeliveryId, predecessor.rootDeliveryId);
  // The pin and the hash describe the same profile: the new one.
  assert.equal(replacement.jurisdictionCountry, "KR");
  assert.equal(replacement.jurisdictionProfileKey, "KR");
  assert.equal(replacement.displayContractHash, HASH_B);
  // And the message is still there to render.
  assert.deepEqual(replacement.renderDataSnapshot, predecessor.renderDataSnapshot);
});

test("a second replacement of one predecessor is refused, not written", async () => {
  const user = await account();
  const predecessor = await claimedDelivery(user.email!);
  const input = {
    delivery: {
      ...predecessor,
      renderDataSnapshot: predecessor.renderDataSnapshot as Prisma.InputJsonValue,
    },
    current: {
      templateVersionId,
      policyVersionId,
      jurisdictionCountry: "AU",
      jurisdictionProfileKey: "AU",
      displayContractHash: HASH_B,
    },
  };

  const first = await prisma.$transaction((tx) => skipAndReenqueue(tx, input));
  const second = await prisma.$transaction((tx) => skipAndReenqueue(tx, input));

  assert.equal(first.reenqueued, true);
  assert.deepEqual(second, { reenqueued: false, reason: "not_pending" });
  assert.equal(
    await prisma.emailDelivery.count({ where: { supersedesDeliveryId: predecessor.id } }),
    1
  );
});

test("a sent message's verdict records the submission, once", async () => {
  // Without this the ledger could not tell a submitted message from one whose
  // verdict committed just before the process died.
  const user = await account();
  const record = await consent(user.id, user.email!);
  const delivery = await seedDelivery(user.email!);
  // Evaluated and checked in the past, so the seal -- taken now -- follows both,
  // which is the order the drain produces and the submission CHECK requires.
  const earlier = new Date(Date.now() - 60_000);
  const verdict = verdictFor([record.id], { now: earlier });
  await prisma.$transaction((tx) =>
    recordSendDecision(tx, {
      deliveryId: delivery.id,
      userId: user.id,
      phase: "send",
      purpose: "product_updates",
      classification: "marketing",
      emailAddress: user.email!,
      addressNormalizationVersion: "v1",
      verdict,
      countryCandidates: verdict.countries,
      suppressionCheckedAt: earlier,
      providerSubmittedAt: null,
      evidence: evidenceOf(verdict),
    })
  );

  assert.equal(await recordProviderSubmission(prisma, { deliveryId: delivery.id }), true);
  // The second call finds nothing to write rather than tripping the ledger's
  // transition trigger.
  assert.equal(await recordProviderSubmission(prisma, { deliveryId: delivery.id }), false);

  // On the database clock and never below the seal -- the CHECK compares them,
  // and an application clock behind the seal used to be refused after the
  // message had already gone.
  const row = await prisma.emailPermissionDecision.findFirstOrThrow({
    where: { deliveryId: delivery.id, phase: "send" },
    select: { providerSubmittedAt: true, sealedAt: true, suppressionCheckedAt: true },
  });
  assert.ok(row.providerSubmittedAt && row.sealedAt && row.suppressionCheckedAt);
  assert.ok(row.providerSubmittedAt.getTime() >= row.sealedAt.getTime());
  assert.ok(row.providerSubmittedAt.getTime() >= row.suppressionCheckedAt.getTime());
});

test("a refused verdict takes no submission", async () => {
  const user = await account();
  const delivery = await seedDelivery(user.email!);
  const earlier = new Date(Date.now() - 60_000);
  const verdict = verdictFor([], {
    now: earlier,
    recipient: { suppressed: true, objected: false, consent: { express: false, evidenceIds: [] } },
  });
  assert.equal(verdict.allowed, false);
  await prisma.$transaction((tx) =>
    recordSendDecision(tx, {
      deliveryId: delivery.id,
      userId: user.id,
      phase: "send",
      purpose: "product_updates",
      classification: "marketing",
      emailAddress: user.email!,
      addressNormalizationVersion: "v1",
      verdict,
      countryCandidates: verdict.countries,
      suppressionCheckedAt: earlier,
      providerSubmittedAt: null,
      evidence: evidenceOf(verdict),
    })
  );
  assert.equal(
    await recordProviderSubmission(prisma, { deliveryId: delivery.id }),
    false
  );
});

test("a sealed decision whose basis moved is replaced, not failed", async () => {
  // The ledger holds one send decision per delivery. When an allowed retry rests
  // on a different basis, the message is still owed, so it is replaced -- and
  // the trigger accepts that reason, not only a moved display contract.
  const user = await account();
  const predecessor = await claimedDelivery(user.email!);
  const result = await prisma.$transaction((tx) =>
    skipAndReenqueue(tx, {
      reason: "verdict_basis_changed",
      delivery: {
        ...predecessor,
        renderDataSnapshot: predecessor.renderDataSnapshot as Prisma.InputJsonValue,
      },
      current: {
        templateVersionId,
        policyVersionId,
        jurisdictionCountry: "AU",
        jurisdictionProfileKey: "AU",
        displayContractHash: HASH_A,
      },
    })
  );
  assert.equal(result.reenqueued, true);
  const before = await prisma.emailDelivery.findUniqueOrThrow({
    where: { id: predecessor.id },
    select: { skipReason: true },
  });
  assert.equal(before.skipReason, "verdict_basis_changed");
});

test("any other skip reason still cannot have a replacement", async () => {
  const user = await account();
  const predecessor = await claimedDelivery(user.email!);
  await prisma.emailDelivery.update({
    where: { id: predecessor.id },
    data: { status: "skipped", skipReason: "permission_revoked" },
  });
  await assert.rejects(
    prisma.emailDelivery.create({
      data: {
        eventId: predecessor.eventId,
        recipientKey: predecessor.recipientKey,
        emailAddress: predecessor.emailAddress,
        language: "en",
        lane: "standard",
        generation: 1,
        supersedesDeliveryId: predecessor.id,
        rootDeliveryId: predecessor.rootDeliveryId,
        templateVersionId,
        policyVersionId,
        jurisdictionCountry: "AU",
        jurisdictionProfileKey: "AU",
        displayContractHash: HASH_B,
        idempotencyKey: randomUUID(),
      },
    }),
    /only a delivery skipped as display_contract_changed or verdict_basis_changed/
  );
});
