import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import { ensureJurisdictionPolicyDraft } from "@/lib/emailJurisdictionPolicy";
import { releaseNotesRuleKey } from "@/lib/releaseNotesCountryRuleCore";
import { recordObligationWaiver } from "@/lib/releaseNotesObligationStore";
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

/** The Korean country rule of the most recent policy version. */
const koreanRuleId = async () =>
  (
    await prisma.releaseNotesCountryRule.findFirstOrThrow({
      where: { countryCode: "KR" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    })
  ).id;

const duty = (
  countryRuleId: string,
  overrides: Partial<Prisma.ReleaseNotesRuleObligationUncheckedCreateInput> = {}
): Prisma.ReleaseNotesRuleObligationUncheckedCreateInput => ({
  countryRuleId,
  obligationKey: "consent_result_notice_14_days",
  state: "implemented",
  readinessCheck: "emailBusinessIdentity",
  notes: "test",
  ...overrides,
});

/**
 * An approval, scoped by default to the Korean rule of one policy version.
 *
 * `policyVersionId` is a parameter rather than "the newest version", which a
 * review found mattered: the scope matrix creates a second draft before it runs,
 * so every case took the newest version and six of the seven negative cases were
 * already wrong about the policy version before they touched the field they were
 * about. A case that could fail for two reasons proves neither.
 */
const approval = async (
  overrides: Partial<Prisma.EmailSendApprovalUncheckedCreateInput> = {},
  policyVersionId?: string
) => {
  const policy =
    policyVersionId === undefined
      ? await prisma.emailPolicyVersion.findFirstOrThrow({
          select: { id: true },
          orderBy: { createdAt: "desc" },
        })
      : { id: policyVersionId };
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
    select: {
      obligationKey: true,
      state: true,
      readinessCheck: true,
      dueBy: true,
      countryRule: { select: { countryCode: true, policyVersionId: true } },
    },
    orderBy: [{ countryRuleId: "asc" }, { obligationKey: "asc" }],
  });

  assert.deepEqual(
    stored.map((row) => `${row.countryRule.countryCode}:${row.obligationKey}`).sort(),
    releaseNotesObligationSeed()
      .map((seeded) => `${seeded.countryCode}:${seeded.obligationKey}`)
      .sort()
  );
  // Keyed on this policy version's rules, which is what a waiver's scope names.
  for (const row of stored) {
    assert.equal(row.countryRule.policyVersionId, version.id);
  }
  // No duty is waived: an approval is the only thing that can waive one, and a
  // seed cannot write an approval.
  assert.deepEqual([...new Set(stored.map((row) => row.state))].sort(), [
    "deferred",
    "implemented",
  ]);
  for (const row of stored) {
    if (row.state === "implemented") assert.ok(row.readinessCheck);
    if (row.state === "deferred") assert.ok(row.dueBy);
  }

  // Korea's three unsettled duties have no row, which is what would block the
  // Korean rule once S9 reads these.
  const korean = stored
    .filter((row) => row.countryRule.countryCode === "KR")
    .map((row) => row.obligationKey);
  assert.deepEqual(
    obligationsFor("KR").filter((key) => !korean.includes(key)),
    [
      "bilingual_unsubscribe_notice",
      "consent_result_notice_14_days",
      "advertising_subject_label",
    ]
  );
});

test("a second draft gets its own duty rows, because a waiver names a policy version", async () => {
  // The opposite of the rule versions, which are shared. A duty state belongs to
  // one policy version's rule: that is what an obligation waiver's scope names,
  // and sharing one row between two versions is what made a waiver approved
  // under one of them fail under the other.
  const first = await draft();
  const second = await draft();
  const perDraft = releaseNotesObligationSeed().length;

  assert.equal(await prisma.releaseNotesRuleObligation.count(), perDraft * 2);
  for (const version of [first, second]) {
    assert.equal(
      await prisma.releaseNotesRuleObligation.count({
        where: { countryRule: { policyVersionId: version.id } },
      }),
      perDraft
    );
  }
});

test("each state carries its own evidence and only its own", async () => {
  await draft();
  const ruleId = await koreanRuleId();
  await prisma.releaseNotesRuleObligation.deleteMany({});
  const sealed = await approval({ sealedAt: new Date("2026-09-20T00:00:00.000Z") });
  // Sealed for the duty the fixture is about, so an evidence case fails on its
  // evidence rather than on the waiver's scope -- two different refusals, and a
  // case that could be either proves neither.
  const sealedForFixture = await approval({
    sealedAt: new Date("2026-09-20T00:00:00.000Z"),
    obligationKey: "consent_result_notice_14_days",
  });

  const cases: Array<[Partial<Prisma.ReleaseNotesRuleObligationUncheckedCreateInput>, RegExp]> = [
    // implemented without its check, or with another state's evidence
    [{ readinessCheck: null }, /evidence_check/],
    [{ readinessCheck: "   " }, /evidence_check/],
    [{ dueBy: new Date("2028-01-01T00:00:00.000Z") }, /evidence_check/],
    [
      { waiverApprovalId: sealedForFixture.id, waiverApprovalType: "obligation_waiver" },
      /evidence_check/,
    ],
    // deferred without a date, without a warning window, or with a check
    [{ state: "deferred", readinessCheck: null }, /evidence_check/],
    [
      // A deadline and no window: a duty whose date nobody would be told about.
      { state: "deferred", readinessCheck: null, dueBy: new Date("2028-01-01T00:00:00.000Z") },
      /evidence_check/,
    ],
    [
      { state: "deferred", dueBy: new Date("2028-01-01T00:00:00.000Z") },
      /evidence_check/,
    ],
    // waived without an approval, or with a check
    [{ state: "waived", readinessCheck: null }, /evidence_check/],
    [
      {
        state: "waived",
        waiverApprovalId: sealedForFixture.id,
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
      () => prisma.releaseNotesRuleObligation.create({ data: duty(ruleId, overrides) }),
      pattern
    );
  }

  // The three shapes that are right.
  await prisma.releaseNotesRuleObligation.create({ data: duty(ruleId) });
  await prisma.releaseNotesRuleObligation.create({
    data: duty(ruleId, {
      obligationKey: "biennial_consent_notice",
      state: "deferred",
      readinessCheck: null,
      dueBy: new Date("2028-01-01T00:00:00.000Z"),
      warnDaysBefore: 60,
    }),
  });
  await prisma.releaseNotesRuleObligation.create({
    data: duty(ruleId, {
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
  const ruleId = await koreanRuleId();
  await prisma.releaseNotesRuleObligation.deleteMany({});

  const unsealed = await approval();
  await refuses(
    () =>
      prisma.releaseNotesRuleObligation.create({
        data: duty(ruleId, {
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
        data: duty(ruleId, {
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
        data: duty(ruleId, {
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

test("a waiver has to waive this duty, of this rule, of this policy version", async () => {
  // The foreign key holds the pair (id, approvalType) and nothing more, so an
  // approval waiving Singapore's subject label could be named by Korea's
  // fourteen-day notice. The verdict refuses that at send time, but the stored
  // state and the admin screen would both say a duty was waived that nobody
  // waived -- so the row cannot be written.
  const version = await draft();
  const ruleId = await koreanRuleId();
  await prisma.releaseNotesRuleObligation.deleteMany({});
  const rule = await prisma.releaseNotesCountryRule.findUniqueOrThrow({
    where: { id: ruleId },
    select: { ruleKey: true, ruleVersion: true, policyVersionId: true },
  });

  const other = await ensureJurisdictionPolicyDraft({ version: `test-${randomUUID()}` });
  // Each case differs from the rule's own scope in exactly one member. The
  // default is pinned to that rule's policy version, so the policy case is the
  // only one that moves it.
  const scopes: Array<[Partial<Prisma.EmailSendApprovalUncheckedCreateInput>, string]> = [
    [{ country: "SG" }, "another country"],
    [{ obligationKey: "body_disclosures" }, "another duty"],
    [{ ruleVersion: rule.ruleVersion + 1 }, "another rule version"],
    [{ ruleKey: releaseNotesRuleKey("SG") }, "another rule"],
    [{ policyVersionId: other.version.id }, "another policy version"],
  ];

  for (const [overrides, what] of scopes) {
    const waiver = await approval(
      {
        sealedAt: new Date("2026-09-20T00:00:00.000Z"),
        ruleKey: rule.ruleKey,
        ruleVersion: rule.ruleVersion,
        country: "KR",
        obligationKey: "advertising_subject_label",
        ...overrides,
      },
      rule.policyVersionId
    );
    await refuses(
      () =>
        prisma.releaseNotesRuleObligation.create({
          data: duty(ruleId, {
            obligationKey: "advertising_subject_label",
            state: "waived",
            readinessCheck: null,
            waiverApprovalId: waiver.id,
            waiverApprovalType: "obligation_waiver",
          }),
        }),
      /RNO_SCOPE_MISMATCH/
    );
    assert.equal(
      await prisma.releaseNotesRuleObligation.count(),
      0,
      `a waiver for ${what} was stored`
    );
  }

  // A waiver with no country or no duty key cannot be stored at all, and that is
  // the approval ledger's CHECK rather than this trigger's. It was in the matrix
  // above until a review pointed out that the approval could not be created, so
  // the case ended before it reached the trigger and proved nothing about it.
  // Asserted here, where the refusal belongs.
  for (const overrides of [{ country: null }, { obligationKey: null }]) {
    await refuses(
      () =>
        approval(
          {
            sealedAt: new Date("2026-09-20T00:00:00.000Z"),
            ruleKey: rule.ruleKey,
            ruleVersion: rule.ruleVersion,
            country: "KR",
            obligationKey: "advertising_subject_label",
            ...overrides,
          },
          rule.policyVersionId
        ),
      /scope_check/
    );
  }

  // The one that matches, so the test is about the comparison and not about the
  // trigger refusing everything.
  const exact = await approval({
    sealedAt: new Date("2026-09-20T00:00:00.000Z"),
    policyVersionId: rule.policyVersionId,
    ruleKey: rule.ruleKey,
    ruleVersion: rule.ruleVersion,
    country: "KR",
    obligationKey: "advertising_subject_label",
  });
  await prisma.releaseNotesRuleObligation.create({
    data: duty(ruleId, {
      obligationKey: "advertising_subject_label",
      state: "waived",
      readinessCheck: null,
      waiverApprovalId: exact.id,
      waiverApprovalType: "obligation_waiver",
    }),
  });
  assert.equal(await prisma.releaseNotesRuleObligation.count(), 1);
  assert.ok(version.id);
});

test("the waiver writer records what the database accepts and reports what it refuses", async () => {
  // `waived` is the one state a seed cannot produce, because a waiver is a
  // person's act. This is the writer that can, and what it will not do.
  await draft();
  const ruleId = await koreanRuleId();
  await prisma.releaseNotesRuleObligation.deleteMany({});
  const rule = await prisma.releaseNotesCountryRule.findUniqueOrThrow({
    where: { id: ruleId },
    select: { ruleKey: true, ruleVersion: true, policyVersionId: true },
  });
  const sealedFor = (obligationKey: string | null, overrides = {}) =>
    approval({
      sealedAt: new Date("2026-09-20T00:00:00.000Z"),
      policyVersionId: rule.policyVersionId,
      ruleKey: rule.ruleKey,
      ruleVersion: rule.ruleVersion,
      country: "KR",
      obligationKey,
      ...overrides,
    });

  const exact = await sealedFor("advertising_subject_label");
  const recorded = await recordObligationWaiver({
    countryRuleId: ruleId,
    obligationKey: "advertising_subject_label",
    approvalId: exact.id,
    notes: "The owner decided not to print the advertising label.",
  });
  assert.equal(recorded.ok, true);
  const stored = await prisma.releaseNotesRuleObligation.findUniqueOrThrow({
    where: {
      countryRuleId_obligationKey: {
        countryRuleId: ruleId,
        obligationKey: "advertising_subject_label",
      },
    },
    select: { state: true, waiverApprovalId: true, readinessCheck: true, dueBy: true },
  });
  assert.equal(stored.state, "waived");
  assert.equal(stored.waiverApprovalId, exact.id);
  // A waived duty carries no other state's evidence, which the CHECK holds and
  // the writer therefore does not have to remember.
  assert.equal(stored.readinessCheck, null);
  assert.equal(stored.dueBy, null);

  // Recording the same waiver again is the same row.
  const again = await recordObligationWaiver({
    countryRuleId: ruleId,
    obligationKey: "advertising_subject_label",
    approvalId: exact.id,
    notes: "Same decision, recorded twice.",
  });
  assert.equal(again.ok, true);
  assert.equal(await prisma.releaseNotesRuleObligation.count(), 1);

  // An approval that waives another duty: refused, and named as a scope
  // mismatch rather than as something an operator has to guess at.
  const wrongDuty = await sealedFor("body_disclosures");
  const mismatch = await recordObligationWaiver({
    countryRuleId: ruleId,
    obligationKey: "consent_result_notice_14_days",
    approvalId: wrongDuty.id,
    notes: "x",
  });
  assert.equal(mismatch.ok, false);
  assert.equal(mismatch.ok === false && mismatch.refusal, "approval_scope_mismatch");

  // The refusals it can name without asking the database.
  const unsealed = await sealedFor("consent_result_notice_14_days", { sealedAt: null });
  for (const [input, refusal] of [
    [{ approvalId: unsealed.id }, "approval_not_sealed"],
    [{ approvalId: randomUUID() }, "approval_not_found"],
    [{ obligationKey: "not_a_duty" }, "unknown_obligation"],
    [{ countryRuleId: randomUUID() }, "rule_not_found"],
  ] as const) {
    const result = await recordObligationWaiver({
      countryRuleId: ruleId,
      obligationKey: "consent_result_notice_14_days",
      approvalId: exact.id,
      notes: "x",
      ...input,
    });
    assert.equal(result.ok, false, JSON.stringify(input));
    assert.equal(result.ok === false && result.refusal, refusal);
  }

  // And a database error that is not about the scope is thrown, not relabelled.
  // The first version reported an empty `notes` as a wrong approval, which sends
  // an operator to check an approval that is fine.
  const forNotice = await sealedFor("consent_result_notice_14_days");
  await assert.rejects(
    () =>
      recordObligationWaiver({
        countryRuleId: ruleId,
        obligationKey: "consent_result_notice_14_days",
        approvalId: forNotice.id,
        notes: "   ",
      }),
    (error: unknown) => {
      assert.match(error instanceof Error ? error.message : String(error), /notes_check/);
      return true;
    }
  );
});

test("a rule carrying a waived duty cannot have the scope that waiver names changed", async () => {
  // The other direction of the scope comparison. A draft's rule is editable --
  // that is what a draft is for -- so moving its country or rule version after a
  // waiver is attached would leave a `waived` row whose approval waives something
  // else, and the admin screen would show a decision nobody made.
  await draft();
  const ruleId = await koreanRuleId();
  await prisma.releaseNotesRuleObligation.deleteMany({});
  const rule = await prisma.releaseNotesCountryRule.findUniqueOrThrow({
    where: { id: ruleId },
    select: { ruleKey: true, ruleVersion: true, policyVersionId: true, notes: true },
  });

  // Before the waiver, the scope moves freely.
  await prisma.releaseNotesCountryRule.update({
    where: { id: ruleId },
    data: { ruleVersion: rule.ruleVersion },
  });

  const waiver = await approval({
    sealedAt: new Date("2026-09-20T00:00:00.000Z"),
    policyVersionId: rule.policyVersionId,
    ruleKey: rule.ruleKey,
    ruleVersion: rule.ruleVersion,
    country: "KR",
    obligationKey: "advertising_subject_label",
  });
  await recordObligationWaiver({
    countryRuleId: ruleId,
    obligationKey: "advertising_subject_label",
    approvalId: waiver.id,
    notes: "The owner decided not to print the advertising label.",
  });

  for (const data of [
    { countryCode: "SG" },
    { ruleVersion: rule.ruleVersion + 1 },
    { ruleKey: releaseNotesRuleKey("SG") },
  ]) {
    await refuses(
      () => prisma.releaseNotesCountryRule.update({ where: { id: ruleId }, data }),
      /waived duty state|cannot be changed/
    );
  }

  // The notes are not part of any waiver's scope, so they still move.
  await prisma.releaseNotesCountryRule.update({
    where: { id: ruleId },
    data: { notes: `${rule.notes} (amended)` },
  });
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
