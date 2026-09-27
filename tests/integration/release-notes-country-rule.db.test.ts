import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import type { Prisma } from "@prisma/client";

import { prisma } from "@/lib/prisma";
import {
  activatePolicyVersion,
  ensureJurisdictionPolicyDraft,
} from "@/lib/emailJurisdictionPolicy";
import {
  JURISDICTION_MAPPED_COUNTRY_CODES,
  MARKETING_ALLOWED_COUNTRY_CODES,
} from "@/lib/emailJurisdictionCore";
import {
  releaseNotesAuthorityVerdict,
  releaseNotesCountryRuleSeed,
  releaseNotesRuleKey,
} from "@/lib/releaseNotesCountryRuleCore";
import {
  releaseNotesRuleVersionConflicts,
  releaseNotesRulesForVersion,
} from "@/lib/releaseNotesCountryRules";

// The recipient-authority rules against the tables that hold them.
//
// Contract: docs/policy/email-notifications.md section 5.1.1; draft sections
// 4.1-4.3 and 7.8.
//
// What needs a database is what the tables refuse: a rule version whose content
// changes after anything was approved against it, and a write to a policy
// version that is no longer a draft. An obligation waiver is scoped to
// (ruleKey, ruleVersion), so both are what stop a waiver from applying to a
// rule nobody approved it for.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ReleaseNotesCountryRule", "ReleaseNotesRuleVersion",
      "JurisdictionCountryMap", "JurisdictionProfile",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

const actor = () => ({
  actorId: randomUUID(),
  actorEmail: `ops-${randomUUID().slice(0, 8)}@example.test`,
});

const draft = async (version = `test-${randomUUID()}`) =>
  (await ensureJurisdictionPolicyDraft({ version })).version;

/** A bare draft version with no seeded rows, for rules written by hand. */
const bareDraft = () =>
  prisma.emailPolicyVersion.create({
    data: { version: `bare-${randomUUID()}`, status: "draft", changeSummary: "test" },
  });

const ruleVersion = (
  overrides: Partial<Prisma.ReleaseNotesRuleVersionUncheckedCreateInput> = {}
): Prisma.ReleaseNotesRuleVersionUncheckedCreateInput => ({
  ruleKey: releaseNotesRuleKey("US"),
  ruleVersion: 1,
  countryCode: "US",
  basis: "opt_out",
  status: "open",
  releaseConditions: [],
  activationGates: [],
  ...overrides,
});

const countryRule = (
  policyVersionId: string,
  overrides: Partial<Prisma.ReleaseNotesCountryRuleUncheckedCreateInput> = {}
): Prisma.ReleaseNotesCountryRuleUncheckedCreateInput => ({
  policyVersionId,
  countryCode: "US",
  ruleKey: releaseNotesRuleKey("US"),
  ruleVersion: 1,
  notes: "test",
  ...overrides,
});

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

test("a draft carries one rule per mapped country, and its open set is today's allowlist", async () => {
  const version = await draft();
  const rows = await prisma.releaseNotesCountryRule.findMany({
    where: { policyVersionId: version.id },
    select: { countryCode: true, ruleKey: true, rule: { select: { status: true } } },
  });

  assert.deepEqual(
    rows.map((row) => row.countryCode).sort(),
    [...JURISDICTION_MAPPED_COUNTRY_CODES].sort()
  );
  // The allowlist becomes the rule's status (draft section 4.1). Until S9
  // reads the rows, the constant is still the live gate, and the two must say
  // the same thing.
  assert.deepEqual(
    rows
      .filter((row) => row.rule.status === "open")
      .map((row) => row.countryCode)
      .sort(),
    [...MARKETING_ALLOWED_COUNTRY_CODES].sort()
  );
  for (const row of rows) {
    assert.equal(row.ruleKey, releaseNotesRuleKey(row.countryCode));
  }
});

test("a second draft reuses the rule versions rather than restating them", async () => {
  // One row per (ruleKey, ruleVersion), whatever how many policy versions carry
  // it: that is what makes the pair a waiver can be scoped to.
  const first = await draft();
  const second = await draft();
  const countries = releaseNotesCountryRuleSeed().length;

  assert.equal(await prisma.releaseNotesRuleVersion.count(), countries);
  assert.equal(
    await prisma.releaseNotesCountryRule.count({ where: { policyVersionId: first.id } }),
    countries
  );
  assert.equal(
    await prisma.releaseNotesCountryRule.count({ where: { policyVersionId: second.id } }),
    countries
  );
});

test("a verdict over stored rules needs both authorities", async () => {
  const version = await draft();
  const rules = await releaseNotesRulesForVersion({
    policyVersionId: version.id,
    countries: ["US"],
  });
  assert.equal(rules.length, 1);
  assert.equal(rules[0].basis, "opt_out");

  // US is opt_out on the recipient side, and the Australian sender authority
  // still needs consent: without it nothing is allowed.
  const withoutConsent = releaseNotesAuthorityVerdict({
    countries: ["US"],
    rules,
    consent: { express: false, evidenceIds: [] },
  });
  assert.equal(withoutConsent.legalAllowed, false);
  assert.deepEqual(
    withoutConsent.authorities.map((entry) => [entry.authority, entry.verdict, entry.reason]),
    [
      ["recipient", "allow", null],
      ["au_sender", "deny", "no_au_sender_consent"],
    ]
  );

  const withConsent = releaseNotesAuthorityVerdict({
    countries: ["US"],
    rules,
    consent: { express: true, evidenceIds: ["consent-1"] },
  });
  assert.equal(withConsent.legalAllowed, true);
});

test("a rule version's content cannot change, with or without a second row", async () => {
  // The hole the first version had: the clash check excluded the row being
  // written, so a pair with only one row -- the ordinary case -- could have its
  // basis changed under the same version number and there was nothing to
  // disagree with. Now the content has one row and that row is immutable.
  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });

  for (const change of [
    { basis: "express_consent", activationGates: [] },
    { status: "closed" },
    { releaseConditions: ["something_else"] },
    { countryCode: "KR" },
  ]) {
    await refuses(
      () =>
        prisma.releaseNotesRuleVersion.update({
          where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("US"), ruleVersion: 1 } },
          data: change,
        }),
      /a different content is a new version/
    );
  }

  // A new version number is how the content changes.
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({
      ruleVersion: 2,
      basis: "express_consent",
    }),
  });
  const stored = await prisma.releaseNotesRuleVersion.findMany({
    where: { ruleKey: releaseNotesRuleKey("US") },
    orderBy: { ruleVersion: "asc" },
    select: { ruleVersion: true, basis: true },
  });
  assert.deepEqual(stored, [
    { ruleVersion: 1, basis: "opt_out" },
    { ruleVersion: 2, basis: "express_consent" },
  ]);
});

test("a rule version a policy version applies cannot be deleted", async () => {
  const version = await bareDraft();
  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });
  await prisma.releaseNotesCountryRule.create({ data: countryRule(version.id) });

  await refuses(
    () =>
      prisma.releaseNotesRuleVersion.delete({
        where: { ruleKey_ruleVersion: { ruleKey: releaseNotesRuleKey("US"), ruleVersion: 1 } },
      }),
    /Foreign key|violates foreign key|constraint/i
  );
});

test("an active version's rules cannot be changed, removed or added to", async () => {
  const version = await draft();
  await activatePolicyVersion({ versionId: version.id, ...actor() });
  const existing = await prisma.releaseNotesCountryRule.findFirstOrThrow({
    where: { policyVersionId: version.id, countryCode: "KR" },
  });

  await refuses(
    () =>
      prisma.releaseNotesCountryRule.update({
        where: { id: existing.id },
        data: { notes: "edited after activation" },
      }),
    /cannot be changed/
  );
  await refuses(
    () => prisma.releaseNotesCountryRule.delete({ where: { id: existing.id } }),
    /cannot be changed/
  );
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({ ruleKey: releaseNotesRuleKey("ZW"), countryCode: "ZW" }),
  });
  await refuses(
    () =>
      prisma.releaseNotesCountryRule.create({
        data: countryRule(version.id, {
          countryCode: "ZW",
          ruleKey: releaseNotesRuleKey("ZW"),
        }),
      }),
    /draft policy version/
  );
});

test("a rule cannot be moved onto an active policy version", async () => {
  const active = await draft();
  await activatePolicyVersion({ versionId: active.id, ...actor() });
  const stillDraft = await bareDraft();
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({ ruleKey: releaseNotesRuleKey("ZW"), countryCode: "ZW" }),
  });
  const row = await prisma.releaseNotesCountryRule.create({
    data: countryRule(stillDraft.id, {
      countryCode: "ZW",
      ruleKey: releaseNotesRuleKey("ZW"),
    }),
  });

  await refuses(
    () =>
      prisma.releaseNotesCountryRule.update({
        where: { id: row.id },
        data: { policyVersionId: active.id },
      }),
    /draft policy version/
  );
});

test("a draft's rules can be edited, and deleting the draft takes them with it", async () => {
  const version = await bareDraft();
  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });
  const row = await prisma.releaseNotesCountryRule.create({ data: countryRule(version.id) });
  await prisma.releaseNotesCountryRule.update({
    where: { id: row.id },
    data: { notes: "edited while a draft" },
  });

  await prisma.emailPolicyVersion.delete({ where: { id: version.id } });
  assert.equal(await prisma.releaseNotesCountryRule.count(), 0);
  // The rule version outlives the draft that referenced it: it is what a
  // waiver may have named, and nothing else says what that version meant.
  assert.equal(await prisma.releaseNotesRuleVersion.count(), 1);
});

test("a seed that disagrees with a stored rule version is refused, not silently ignored", async () => {
  // `createMany({ skipDuplicates: true })` would accept an edited seed and leave
  // the stored rule saying the old thing. The draft writer checks instead.
  const seed = releaseNotesCountryRuleSeed();
  await prisma.releaseNotesRuleVersion.create({
    data: ruleVersion({
      ruleKey: releaseNotesRuleKey("KR"),
      countryCode: "KR",
      basis: "opt_out",
      status: "closed",
    }),
  });

  const conflicts = await releaseNotesRuleVersionConflicts(prisma, seed);
  assert.deepEqual(conflicts, ["release_notes.KR v1 (basis, status)"]);
  await assert.rejects(() => ensureJurisdictionPolicyDraft({ version: `x-${randomUUID()}` }), /new rule version/);
});

test("the row's own shape is checked", async () => {
  const cases: Array<[Partial<Prisma.ReleaseNotesRuleVersionUncheckedCreateInput>, RegExp]> = [
    [{ ruleKey: releaseNotesRuleKey("KR") }, /ruleKey_check/],
    [{ countryCode: "ZZ", ruleKey: releaseNotesRuleKey("ZZ") }, /countryCode_check/],
    [{ countryCode: "us", ruleKey: releaseNotesRuleKey("us") }, /countryCode_check/],
    [{ basis: "implied" }, /basis_check/],
    [{ status: "paused" }, /status_check/],
    [{ ruleVersion: 0 }, /ruleVersion_check/],
    [{ releaseConditions: { a: 1 } }, /shape_check/],
    // A gate only belongs to the basis a gate holds back, and that basis must
    // have one: a rule held back for a reason no code reads, or acted on
    // although approval C says not yet, are the two mistakes this refuses.
    [{ activationGates: ["something"] }, /gates_check/],
    [{ basis: "inferred_consent", activationGates: [] }, /gates_check/],
  ];
  for (const [overrides, pattern] of cases) {
    await refuses(
      () => prisma.releaseNotesRuleVersion.create({ data: ruleVersion(overrides) }),
      pattern
    );
  }

  await prisma.releaseNotesRuleVersion.create({ data: ruleVersion() });
  const version = await bareDraft();
  await refuses(
    () => prisma.releaseNotesCountryRule.create({ data: countryRule(version.id, { notes: "  " }) }),
    /notes_check/
  );
  await refuses(
    () =>
      prisma.releaseNotesCountryRule.create({
        data: countryRule(version.id, { countryCode: "KR" }),
      }),
    /ReleaseNotesCountryRule_ruleKey_check/
  );
});
