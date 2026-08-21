import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  JurisdictionPolicyError,
  activatePolicyVersion,
  ensureJurisdictionPolicyDraft,
  listPolicyVersions,
  readActivePolicyVersion,
  readPolicyVersion,
} from "@/lib/emailJurisdictionPolicy";
import {
  JURISDICTION_POLICY_SEED_VERSION,
  JURISDICTION_PROFILE_SEED,
  jurisdictionCountryMapSeed,
} from "@/lib/emailJurisdictionSeed";

// Seeding, reading and activating a jurisdiction policy version.
//
// Contract: docs/policy/email-notifications.md §12.5.
//
// The thing under test is mostly a *refusal*: this module has to be unable to
// activate anything on its own, and the "exactly one active version" rule has
// to hold under concurrency rather than by the code being careful. Both are
// database facts, so both are exercised here rather than in a pure test.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "ConsentRecord", "EmailPreference", "SuppressionEntry",
      "ProviderWebhookEvent", "JurisdictionCountryMap", "JurisdictionProfile",
      "EmailPolicyVersion", "User"
    RESTART IDENTITY CASCADE
  `);

const actor = () => ({
  actorId: randomUUID(),
  actorEmail: `ops-${randomUUID().slice(0, 8)}@example.test`,
});

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("seeding produces a draft, and nothing more", async () => {
  const result = await ensureJurisdictionPolicyDraft();

  assert.equal(result.created, true);
  // The whole point of the seed being separate from activation: an operator
  // who runs it has changed nothing about what is sent.
  assert.equal(result.version.status, "draft");
  assert.equal(result.version.activatedAt, null);
  assert.equal(result.version.approvedAt, null);
  assert.equal(result.version.approvedByEmail, null);
  assert.equal(await readActivePolicyVersion(), null);
});

test("the seeded version carries every profile and country", async () => {
  const { version } = await ensureJurisdictionPolicyDraft();

  assert.equal(version.profileCount, JURISDICTION_PROFILE_SEED.length);
  assert.equal(version.countryCount, jurisdictionCountryMapSeed().length);

  const detail = await readPolicyVersion(version.id);
  assert.deepEqual(
    detail!.profiles.map((profile) => profile.profileKey).sort(),
    JURISDICTION_PROFILE_SEED.map((profile) => profile.profileKey).sort()
  );

  const korea = detail!.profiles.find((profile) => profile.profileKey === "KR")!;
  assert.equal(korea.subjectPrefix, "(광고)");
  assert.equal(korea.consentNoticeIntervalMonths, 24);
  assert.deepEqual(korea.quietHours, {
    start: "21:00",
    end: "08:00",
    tz: "Asia/Seoul",
  });
  // §12.5: the sources have to reach the edit screen, which means they have to
  // reach the row.
  assert.ok(korea.notes.includes("제50조"));

  // Every country that resolves to a profile is attached to it, and the
  // fallback is reached by absence rather than by a row.
  const fallback = detail!.profiles.find((profile) => profile.profileKey === "ZZ")!;
  assert.deepEqual(fallback.countries, []);
  assert.ok(korea.countries.includes("KR"));
  const eu = detail!.profiles.find((profile) => profile.profileKey === "EU")!;
  assert.ok(eu.countries.includes("DE"));
  assert.ok(eu.countries.includes("CH"));
});

test("seeding twice produces one version", async () => {
  const first = await ensureJurisdictionPolicyDraft();
  const second = await ensureJurisdictionPolicyDraft();

  assert.equal(second.created, false);
  assert.equal(second.version.id, first.version.id);
  assert.equal((await listPolicyVersions()).length, 1);
  // And no duplicated children: a second createMany against the same version
  // would have doubled both counts.
  assert.equal(second.version.profileCount, first.version.profileCount);
  assert.equal(second.version.countryCount, first.version.countryCount);
});

test("seeding after activation does not fork the active version", async () => {
  const { version } = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({ versionId: version.id, ...actor() });

  const again = await ensureJurisdictionPolicyDraft();
  assert.equal(again.created, false);
  assert.equal(again.version.id, version.id);
  assert.equal(again.version.status, "active");
  // An active version is what some delivery was rendered under. Re-seeding it
  // in place would rewrite what was true at send time.
  assert.equal((await listPolicyVersions()).length, 1);
});

test("activation records who approved it and when", async () => {
  const { version } = await ensureJurisdictionPolicyDraft();
  const who = actor();

  const result = await activatePolicyVersion({ versionId: version.id, ...who });

  assert.equal(result.version.status, "active");
  assert.equal(result.supersededVersion, null);
  assert.equal(result.version.approvedByEmail, who.actorEmail);
  assert.ok(result.version.approvedAt);
  assert.ok(result.version.activatedAt);
  // The row says who, not only the audit log: an audit log with a retention
  // window cannot answer "who approved the policy that was in force" forever,
  // and the policy version outlives it.
  const active = await readActivePolicyVersion();
  assert.equal(active!.id, version.id);
});

test("activating a second version supersedes the first, atomically", async () => {
  const first = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({ versionId: first.version.id, ...actor() });

  const second = await ensureJurisdictionPolicyDraft({
    version: `${JURISDICTION_POLICY_SEED_VERSION}.2`,
    changeSummary: "Second version for the supersede test.",
  });
  const result = await activatePolicyVersion({
    versionId: second.version.id,
    ...actor(),
  });

  assert.equal(result.supersededVersion, first.version.version);

  const versions = await listPolicyVersions();
  assert.equal(versions.filter((version) => version.status === "active").length, 1);
  const previous = versions.find((version) => version.id === first.version.id)!;
  assert.equal(previous.status, "superseded");
  assert.ok(previous.supersededAt);
});

test("two activations racing leave exactly one active version", async () => {
  // The partial unique index is what makes this true; the transaction only
  // makes it orderly. Without the index, both would read "no active version",
  // both would write one, and the table would then have two rows each claiming
  // to describe the same period.
  const a = await ensureJurisdictionPolicyDraft();
  const b = await ensureJurisdictionPolicyDraft({
    version: `${JURISDICTION_POLICY_SEED_VERSION}.race`,
    changeSummary: "Racing draft.",
  });

  const results = await Promise.allSettled([
    activatePolicyVersion({ versionId: a.version.id, ...actor() }),
    activatePolicyVersion({ versionId: b.version.id, ...actor() }),
  ]);

  const versions = await listPolicyVersions();
  assert.equal(versions.filter((version) => version.status === "active").length, 1);
  assert.ok(results.some((result) => result.status === "fulfilled"));
});

test("a version that is already active cannot be activated again", async () => {
  const { version } = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({ versionId: version.id, ...actor() });

  await assert.rejects(
    () => activatePolicyVersion({ versionId: version.id, ...actor() }),
    (error: unknown) =>
      error instanceof JurisdictionPolicyError &&
      error.code === "POLICY_VERSION_ALREADY_ACTIVE"
  );
});

test("a superseded version cannot be brought back", async () => {
  const first = await ensureJurisdictionPolicyDraft();
  await activatePolicyVersion({ versionId: first.version.id, ...actor() });
  const second = await ensureJurisdictionPolicyDraft({
    version: `${JURISDICTION_POLICY_SEED_VERSION}.2`,
    changeSummary: "Second.",
  });
  await activatePolicyVersion({ versionId: second.version.id, ...actor() });

  // Reactivating would leave two rows describing the same period, and "what
  // was active on the 14th" would stop having one answer.
  await assert.rejects(
    () => activatePolicyVersion({ versionId: first.version.id, ...actor() }),
    (error: unknown) =>
      error instanceof JurisdictionPolicyError &&
      error.code === "POLICY_VERSION_NOT_DRAFT"
  );
});

test("an empty version cannot be activated", async () => {
  const empty = await prisma.emailPolicyVersion.create({
    data: {
      version: "empty-version",
      status: "draft",
      changeSummary: "No profiles.",
    },
  });

  // Activating it would leave every send with no profile to render under,
  // which fails per message rather than once, at send time rather than here.
  await assert.rejects(
    () => activatePolicyVersion({ versionId: empty.id, ...actor() }),
    (error: unknown) =>
      error instanceof JurisdictionPolicyError &&
      error.code === "POLICY_VERSION_EMPTY"
  );
});

test("activating something that does not exist is a 404, not a crash", async () => {
  await assert.rejects(
    () => activatePolicyVersion({ versionId: randomUUID(), ...actor() }),
    (error: unknown) =>
      error instanceof JurisdictionPolicyError &&
      error.code === "POLICY_VERSION_NOT_FOUND" &&
      error.status === 404
  );
});

test("a draft's profiles are removed with it", async () => {
  const { version } = await ensureJurisdictionPolicyDraft();
  await prisma.emailPolicyVersion.delete({ where: { id: version.id } });

  assert.equal(await prisma.jurisdictionProfile.count(), 0);
  assert.equal(await prisma.jurisdictionCountryMap.count(), 0);
});
