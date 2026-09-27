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
  releaseNotesRuleKey,
} from "@/lib/releaseNotesCountryRuleCore";
import { releaseNotesRulesForVersion } from "@/lib/releaseNotesCountryRules";

// The recipient-authority rules against the table that holds them.
//
// Contract: docs/policy/email-notifications.md section 5.1.1; draft sections
// 4.1-4.3 and 7.8.
//
// What needs a database is what the table refuses: a write to a version that
// is no longer a draft, and one (ruleKey, ruleVersion) naming two contents.
// An obligation waiver is scoped to that pair, so both are what stop a waiver
// from applying to a rule nobody approved it for.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ReleaseNotesCountryRule", "JurisdictionCountryMap", "JurisdictionProfile",
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

const rule = (
  policyVersionId: string,
  overrides: Partial<Prisma.ReleaseNotesCountryRuleUncheckedCreateInput> = {}
): Prisma.ReleaseNotesCountryRuleUncheckedCreateInput => ({
  policyVersionId,
  countryCode: "US",
  ruleKey: releaseNotesRuleKey("US"),
  ruleVersion: 1,
  basis: "opt_out",
  status: "open",
  conditions: [],
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
  });

  assert.deepEqual(
    rows.map((row) => row.countryCode).sort(),
    [...JURISDICTION_MAPPED_COUNTRY_CODES].sort()
  );
  // The allowlist becomes the rule's status (draft section 4.1). Until S9
  // reads the rows, the constant is still the live gate, and the two must say
  // the same thing.
  assert.deepEqual(
    rows.filter((row) => row.status === "open").map((row) => row.countryCode).sort(),
    [...MARKETING_ALLOWED_COUNTRY_CODES].sort()
  );
  for (const row of rows) {
    assert.equal(row.ruleKey, releaseNotesRuleKey(row.countryCode));
  }
});

test("a verdict over stored rules needs both authorities", async () => {
  const version = await draft();
  const rules = await releaseNotesRulesForVersion({
    policyVersionId: version.id,
    countries: ["US"],
  });
  assert.equal(rules.length, 1);

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
  await refuses(
    () =>
      prisma.releaseNotesCountryRule.create({
        data: rule(version.id, { countryCode: "ZW", ruleKey: releaseNotesRuleKey("ZW") }),
      }),
    /draft policy version/
  );
});

test("a draft's rules can be edited, and deleting the draft takes them with it", async () => {
  const version = await bareDraft();
  const row = await prisma.releaseNotesCountryRule.create({ data: rule(version.id) });
  await prisma.releaseNotesCountryRule.update({
    where: { id: row.id },
    data: { notes: "edited while a draft" },
  });

  await prisma.emailPolicyVersion.delete({ where: { id: version.id } });
  assert.equal(await prisma.releaseNotesCountryRule.count(), 0);
});

test("one rule version names one content in every policy version", async () => {
  const first = await bareDraft();
  const second = await bareDraft();
  await prisma.releaseNotesCountryRule.create({ data: rule(first.id) });

  // Same content under the same version number: allowed, and the notes are
  // prose, so they may differ.
  await prisma.releaseNotesCountryRule.create({
    data: rule(second.id, { notes: "worded differently" }),
  });

  const third = await bareDraft();
  for (const change of [
    { basis: "express_consent" },
    { status: "closed" },
    { conditions: ["something_else"] },
  ]) {
    await refuses(
      () => prisma.releaseNotesCountryRule.create({ data: rule(third.id, change) }),
      /already names a different rule/
    );
  }

  // A new version number is how the content changes.
  await prisma.releaseNotesCountryRule.create({
    data: rule(third.id, { ruleVersion: 2, basis: "express_consent" }),
  });

  // And an update may not make an existing row disagree with its twin.
  const twin = await prisma.releaseNotesCountryRule.findFirstOrThrow({
    where: { policyVersionId: second.id },
  });
  await refuses(
    () =>
      prisma.releaseNotesCountryRule.update({
        where: { id: twin.id },
        data: { status: "closed" },
      }),
    /already names a different rule/
  );
});

test("the row's own shape is checked", async () => {
  const version = await bareDraft();
  const cases: Array<[Partial<Prisma.ReleaseNotesCountryRuleUncheckedCreateInput>, RegExp]> = [
    [{ ruleKey: releaseNotesRuleKey("KR") }, /ruleKey_check/],
    [{ countryCode: "ZZ", ruleKey: releaseNotesRuleKey("ZZ") }, /countryCode_check/],
    [{ countryCode: "us", ruleKey: releaseNotesRuleKey("us") }, /countryCode_check/],
    [{ basis: "implied" }, /basis_check/],
    [{ status: "paused" }, /status_check/],
    [{ ruleVersion: 0 }, /ruleVersion_check/],
    [{ conditions: { a: 1 } }, /shape_check/],
    [{ notes: "   " }, /shape_check/],
  ];
  for (const [overrides, pattern] of cases) {
    await refuses(
      () => prisma.releaseNotesCountryRule.create({ data: rule(version.id, overrides) }),
      pattern
    );
  }
});
