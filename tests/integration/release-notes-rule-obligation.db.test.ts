import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import { releaseNotesRuleKey } from "@/lib/releaseNotesCountryRuleCore";
import {
  obligationsFor,
  releaseNotesObligationSeed,
} from "@/lib/releaseNotesObligationCore";

// The duty states against the table that holds them.
//
// Contract: docs/policy/email-product-news-redesign-draft.md sections 7.7, 7.8.
//
// What needs a database is what the table refuses: a state carrying another
// state's evidence, a waiver naming an approval of the wrong kind, and a waiver
// naming one that is not sealed. The verdict over these rows is unit-tested in
// tests/releaseNotesObligationCore.test.mjs.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ReleaseNotesRuleObligation", "ReleaseNotesCountryRule", "ReleaseNotesRuleVersion",
      "EmailSendApprovalMember", "EmailSendApprovalRevocation", "EmailSendApproval",
      "JurisdictionCountryMap", "JurisdictionProfile",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

const draft = async () =>
  (await ensureJurisdictionPolicyDraft({ version: `test-${randomUUID()}` })).version;

const duty = (
  overrides: Partial<Prisma.ReleaseNotesRuleObligationUncheckedCreateInput> = {}
): Prisma.ReleaseNotesRuleObligationUncheckedCreateInput => ({
  ruleKey: releaseNotesRuleKey("KR"),
  ruleVersion: 1,
  obligationKey: "consent_result_notice_14_days",
  state: "implemented",
  readinessCheck: "emailBusinessIdentity",
  notes: "test",
  ...overrides,
});

const approval = async (
  overrides: Partial<Prisma.EmailSendApprovalUncheckedCreateInput> = {}
) => {
  const policy = await prisma.emailPolicyVersion.findFirstOrThrow({
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return prisma.emailSendApproval.create({
    data: {
      approvalType: "obligation_waiver",
      approvedById: randomUUID(),
      approvedByEmail: `ops-${randomUUID().slice(0, 8)}@example.test`,
      approvedAt: new Date("2026-09-20T00:00:00.000Z"),
      reason: "The owner decided not to print the advertising label.",
      reviewCondition: "Revisit on the first Korean complaint.",
      policyVersionId: policy.id,
      ruleKey: releaseNotesRuleKey("KR"),
      ruleVersion: 1,
      country: "KR",
      obligationKey: "advertising_subject_label",
      ...overrides,
    },
  });
};

const refuses = async (write: () => Promise<unknown>, pattern: RegExp) => {
  await assert.rejects(write, (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    assert.match(message, pattern);
    return true;
  });
};

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("a draft carries the duty states that are settled without a decision", async () => {
  const version = await draft();
  const stored = await prisma.releaseNotesRuleObligation.findMany({
    select: { ruleKey: true, obligationKey: true, state: true, readinessCheck: true },
    orderBy: [{ ruleKey: "asc" }, { obligationKey: "asc" }],
  });

  assert.deepEqual(
    stored.map((row) => `${row.ruleKey}:${row.obligationKey}`).sort(),
    releaseNotesObligationSeed()
      .map((seeded) => `${releaseNotesRuleKey(seeded.countryCode)}:${seeded.obligationKey}`)
      .sort()
  );
  // Every one of them is implemented, because an approval is the only thing that
  // can waive a duty and a seed cannot write one.
  assert.deepEqual([...new Set(stored.map((row) => row.state))], ["implemented"]);
  for (const row of stored) assert.ok(row.readinessCheck);

  // And Korea's remaining three duties have no row, which is what blocks the
  // Korean rule until somebody settles them.
  const korean = stored
    .filter((row) => row.ruleKey === releaseNotesRuleKey("KR"))
    .map((row) => row.obligationKey);
  assert.deepEqual(
    obligationsFor("KR").filter((key) => !korean.includes(key)),
    ["consent_result_notice_14_days", "biennial_consent_notice", "advertising_subject_label"]
  );
  assert.ok(version.id);
});

test("a second draft reuses the duty rows rather than restating them", async () => {
  await draft();
  await draft();
  assert.equal(
    await prisma.releaseNotesRuleObligation.count(),
    releaseNotesObligationSeed().length
  );
});

test("each state carries its own evidence and only its own", async () => {
  await draft();
  await prisma.releaseNotesRuleObligation.deleteMany({});
  const sealed = await approval({ sealedAt: new Date("2026-09-20T00:00:00.000Z") });

  const cases: Array<[Partial<Prisma.ReleaseNotesRuleObligationUncheckedCreateInput>, RegExp]> = [
    // implemented without its check, or with another state's evidence
    [{ readinessCheck: null }, /evidence_check/],
    [{ readinessCheck: "   " }, /evidence_check/],
    [{ dueBy: new Date("2028-01-01T00:00:00.000Z") }, /evidence_check/],
    [
      { waiverApprovalId: sealed.id, waiverApprovalType: "obligation_waiver" },
      /evidence_check/,
    ],
    // deferred without a date, or with a check
    [{ state: "deferred", readinessCheck: null }, /evidence_check/],
    [
      { state: "deferred", dueBy: new Date("2028-01-01T00:00:00.000Z") },
      /evidence_check/,
    ],
    // waived without an approval, or with a check
    [{ state: "waived", readinessCheck: null }, /evidence_check/],
    [
      {
        state: "waived",
        waiverApprovalId: sealed.id,
        waiverApprovalType: "obligation_waiver",
      },
      /evidence_check/,
    ],
    // an unknown state, and a warning window that is not a window
    [{ state: "decided_later" }, /state_check/],
    [
      { state: "deferred", readinessCheck: null, dueBy: new Date("2028-01-01T00:00:00.000Z"), warnDaysBefore: 0 },
      /warnDaysBefore_check/,
    ],
    [{ notes: "  " }, /notes_check/],
  ];
  for (const [overrides, pattern] of cases) {
    await refuses(
      () => prisma.releaseNotesRuleObligation.create({ data: duty(overrides) }),
      pattern
    );
  }

  // The three shapes that are right.
  await prisma.releaseNotesRuleObligation.create({ data: duty() });
  await prisma.releaseNotesRuleObligation.create({
    data: duty({
      obligationKey: "biennial_consent_notice",
      state: "deferred",
      readinessCheck: null,
      dueBy: new Date("2028-01-01T00:00:00.000Z"),
      warnDaysBefore: 60,
    }),
  });
  await prisma.releaseNotesRuleObligation.create({
    data: duty({
      obligationKey: "advertising_subject_label",
      state: "waived",
      readinessCheck: null,
      waiverApprovalId: sealed.id,
      waiverApprovalType: "obligation_waiver",
    }),
  });
  assert.equal(await prisma.releaseNotesRuleObligation.count(), 3);
});

test("a waiver must be an approval of the right kind, and sealed", async () => {
  await draft();
  await prisma.releaseNotesRuleObligation.deleteMany({});

  const unsealed = await approval();
  await refuses(
    () =>
      prisma.releaseNotesRuleObligation.create({
        data: duty({
          obligationKey: "advertising_subject_label",
          state: "waived",
          readinessCheck: null,
          waiverApprovalId: unsealed.id,
          waiverApprovalType: "obligation_waiver",
        }),
      }),
    /is not sealed/
  );

  // An override is not a waiver of anything, and the type travels with the id
  // so the foreign key refuses the pair rather than trusting the link.
  const override = await approval({
    approvalType: "risk_accepted",
    purposeKey: "*",
    ruleKey: null,
    ruleVersion: null,
    country: null,
    obligationKey: null,
    sealedAt: new Date("2026-09-20T00:00:00.000Z"),
  });
  await refuses(
    () =>
      prisma.releaseNotesRuleObligation.create({
        data: duty({
          obligationKey: "advertising_subject_label",
          state: "waived",
          readinessCheck: null,
          waiverApprovalId: override.id,
          waiverApprovalType: "risk_accepted",
        }),
      }),
    /waiverApprovalType_check/
  );
  await refuses(
    () =>
      prisma.releaseNotesRuleObligation.create({
        data: duty({
          obligationKey: "advertising_subject_label",
          state: "waived",
          readinessCheck: null,
          waiverApprovalId: override.id,
          waiverApprovalType: "obligation_waiver",
        }),
      }),
    /[Ff]oreign key/
  );
});

test("a rule version a duty hangs off cannot be deleted", async () => {
  await draft();
  await refuses(
    () =>
      prisma.releaseNotesRuleVersion.delete({
        where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("KR"), ruleVersion: 1 } },
      }),
    /cannot be deleted|[Ff]oreign key/
  );
});
