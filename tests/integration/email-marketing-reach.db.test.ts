import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { marketingReachReport } from "@/lib/marketingReach";

// What a marketing campaign would actually reach, read from the live tables.
//
// Contract: docs/policy/email-notifications.md §5.1 C1, §5.6 C8, §11.2.
// Decision this feeds: docs/ops/q2-marketing-reach-decision.md.
//
// The classification is unit-tested against invented counts
// (tests/marketingReachCore.test.mjs). What only a database can answer is
// whether the three queries produce those counts, and two of them are the
// reason this file exists:
//
//  - `ConsentRecord` is append-only, so somebody who granted and then withdrew
//    has two rows. Counting grants would count them as consenting; the query
//    has to take the newest row per person and purpose and only then ask what
//    it says. A unit test cannot see that, because it is handed the answer.
//  - suppression is matched on the address rather than on a foreign key, and
//    addresses arrive in whatever case the provider reports. A comparison that
//    is not case-insensitive silently reports somebody as reachable who is
//    suppressed.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ConsentRecord", "EmailPreference", "SuppressionEntry", "EmailPolicyVersion",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const someone = (email: string) =>
  prisma.user.create({ data: { email, name: "Someone" } });

const policyVersion = () =>
  prisma.emailPolicyVersion.create({
    data: { version: `test-${randomUUID()}`, changeSummary: "fixture" },
  });

const preference = (userId: string, enabled: boolean, source: string) =>
  prisma.emailPreference.create({
    data: { userId, purpose: "newsletter", enabled, source },
  });

const consent = (
  userId: string,
  emailAddress: string,
  policyVersionId: string,
  action: string,
  occurredAt: Date
) =>
  prisma.consentRecord.create({
    data: {
      userId,
      emailAddress,
      purpose: "newsletter",
      action,
      occurredAt,
      jurisdiction: "AU",
      jurisdictionSource: "self_reported",
      policyVersionId,
      capturedVia: "signup_form",
    },
  });

const newsletter = (report: Awaited<ReturnType<typeof marketingReachReport>>) => {
  const row = report.rows.find((candidate) => candidate.purpose === "newsletter");
  assert.ok(row, "no newsletter row");
  return row;
};

test("an empty database reports zero reach rather than nothing", async () => {
  const report = await marketingReachReport();
  // Every marketing purpose gets a row. A purpose that vanished from the table
  // would read as "not applicable" rather than as zero, and those are
  // different answers to Q2.
  assert.deepEqual(
    report.rows.map((row) => row.purpose),
    ["product_updates", "newsletter", "promotions"]
  );
  assert.equal(newsletter(report).enabled, 0);
  assert.ok(
    report.findings.some((finding) => finding.code === "NO_MARKETING_CONSENT_YET")
  );
});

test("a grant that was later withdrawn is not provable consent", async () => {
  const version = await policyVersion();
  const kept = await someone("kept@example.com");
  const withdrawn = await someone("withdrawn@example.com");

  await preference(kept.id, true, "signup");
  await preference(withdrawn.id, true, "preference_center");

  await consent(kept.id, kept.email!, version.id, "granted", new Date("2026-01-01"));
  // Two rows for one person, newest last. Counting grants would count this
  // person; reading the newest action does not.
  await consent(withdrawn.id, withdrawn.email!, version.id, "granted", new Date("2026-01-01"));
  await consent(withdrawn.id, withdrawn.email!, version.id, "withdrawn", new Date("2026-02-01"));

  const row = newsletter(await marketingReachReport());
  assert.equal(row.enabled, 2);
  assert.equal(row.provable, 1);
  assert.equal(row.unprovable, 1);
});

test("a later reconfirmation restores provable consent", async () => {
  const version = await policyVersion();
  const person = await someone("returned@example.com");
  await preference(person.id, true, "preference_center");

  await consent(person.id, person.email!, version.id, "granted", new Date("2026-01-01"));
  await consent(person.id, person.email!, version.id, "withdrawn", new Date("2026-02-01"));
  await consent(person.id, person.email!, version.id, "reconfirmed", new Date("2026-03-01"));

  assert.equal(newsletter(await marketingReachReport()).provable, 1);
});

test("suppression matches the address whatever case it arrived in", async () => {
  const person = await someone("mixed@example.com");
  await preference(person.id, true, "signup");
  await prisma.suppressionEntry.create({
    data: {
      emailAddress: "MiXeD@Example.COM",
      scope: "global",
      purposeKey: "*",
      reason: "complaint",
      source: "provider_webhook",
    },
  });

  const row = newsletter(await marketingReachReport());
  assert.equal(row.enabled, 1);
  assert.equal(row.suppressed, 1);
  assert.equal(row.sendable, 0);
});

test("a suppression scoped to another purpose does not count", async () => {
  const person = await someone("scoped@example.com");
  await preference(person.id, true, "signup");
  await prisma.suppressionEntry.create({
    data: {
      emailAddress: person.email!,
      scope: "purpose",
      purposeKey: "promotions",
      reason: "unsubscribe",
      source: "unsubscribe_link",
    },
  });

  const row = newsletter(await marketingReachReport());
  assert.equal(row.suppressed, 0);
  assert.equal(row.sendable, 1);
});

test("an account with no preference row counts as no row, not as disabled", async () => {
  await someone("never-opened@example.com");
  const row = newsletter(await marketingReachReport());
  assert.equal(row.accounts, 1);
  assert.equal(row.noRow, 1);
  assert.equal(row.disabled, 0);
  assert.equal(row.enabled, 0);
});

test("no query behind the report returns an address, a name or an id", async () => {
  // The response is meant to be safe to paste into a decision record. That has
  // to be a property of the queries rather than of a filter applied to their
  // output, so the whole serialised report is searched for the fixture's own
  // identifiers.
  const version = await policyVersion();
  const person = await someone("findable@example.com");
  await preference(person.id, true, "signup");
  await consent(person.id, person.email!, version.id, "granted", new Date("2026-01-01"));
  await prisma.suppressionEntry.create({
    data: {
      emailAddress: person.email!,
      scope: "global",
      purposeKey: "*",
      reason: "hard_bounce",
      source: "provider_webhook",
    },
  });

  const serialised = JSON.stringify(await marketingReachReport());
  assert.equal(serialised.includes("findable@example.com"), false);
  assert.equal(serialised.includes(person.id), false);
  assert.equal(serialised.includes("Someone"), false);
});
