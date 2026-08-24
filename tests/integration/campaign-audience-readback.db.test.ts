import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { waveAudienceBreakdown } from "@/lib/adminEmailCampaigns";
import { CAMPAIGN_EXCLUDED_REASONS } from "@/lib/emailCampaignRecipientCore";
import { prisma } from "@/lib/prisma";

// Reading the expansion ledger back (EM-01 slice 7).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.3, §13.1.
//
// The rows are written by the expander and, until this slice, read by nothing
// an operator could open. What needs a database here is the grouping itself:
// the counts come from three `groupBy` reads across a table whose rows this
// process does not hold, and the one distinction that matters -- a dry-run
// wave's written rows are deliveries that were skipped, not sends -- is carried
// on a different row than the counts are.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignRecipient", "EmailCampaignWave", "EmailCampaign",
      "EmailDelivery", "EmailEvent", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
});

after(async () => {
  await prisma.$disconnect();
});

const campaignWithWave = async (input: { dryRun: boolean; kind?: string }) => {
  const campaign = await prisma.emailCampaign.create({
    data: {
      category: "model_retirement",
      templateKey: "model_launch",
      locales: ["en"],
      audienceSpec: {},
      createdByEmail: "owner@example.test",
    },
    select: { id: true },
  });
  const wave = await prisma.emailCampaignWave.create({
    data: {
      campaignId: campaign.id,
      kind: input.kind ?? "launch",
      sequence: 1,
      dryRun: input.dryRun,
    },
    select: { id: true },
  });
  return { campaignId: campaign.id, waveId: wave.id };
};

let userSeq = 0;
const ledgerRow = async (input: {
  campaignId: string;
  waveId: string;
  excludedReason?: string | null;
  /** Explicit `null` is meaningful: it is what `already_changed` records. */
  eligibilityReason?: string | null;
  malformed?: boolean;
}) => {
  userSeq += 1;
  const user = await prisma.user.create({
    data: { email: `person-${userSeq}@example.test` },
    select: { id: true },
  });
  await prisma.emailCampaignRecipient.create({
    data: {
      campaignId: input.campaignId,
      waveId: input.waveId,
      userId: user.id,
      emailAddress: `person-${userSeq}@example.test`,
      excludedReason: input.excludedReason ?? null,
      eligibilityReason:
        "eligibilityReason" in input
          ? input.eligibilityReason
          : "default_model",
      malformed: input.malformed ?? false,
    },
  });
};

test("a campaign with no waves reports nothing rather than an empty wave", async () => {
  const campaign = await prisma.emailCampaign.create({
    data: {
      category: "other",
      templateKey: "model_launch",
      locales: ["en"],
      audienceSpec: {},
      createdByEmail: "owner@example.test",
    },
    select: { id: true },
  });

  assert.deepEqual(await waveAudienceBreakdown(campaign.id), []);
});

test("a wave that has not expanded reports zero considered, not absence", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: false });

  const [wave] = await waveAudienceBreakdown(campaignId);
  assert.equal(wave.waveId, waveId);
  assert.equal(wave.total, 0);
  assert.equal(wave.written, 0);
});

test("every exclusion reason is reported, including the ones that did not fire", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: false });
  await ledgerRow({ campaignId, waveId, excludedReason: "suppressed" });
  await ledgerRow({ campaignId, waveId, excludedReason: "suppressed" });
  await ledgerRow({ campaignId, waveId, excludedReason: "no_consent" });
  await ledgerRow({ campaignId, waveId });

  const [wave] = await waveAudienceBreakdown(campaignId);

  // A breakdown that omitted the zeroes would read as though those reasons
  // were never asked, and "nobody was plan-incompatible" is an answer worth
  // stating rather than inferring from an absence.
  for (const reason of CAMPAIGN_EXCLUDED_REASONS) {
    assert.ok(reason in wave.excluded, `${reason} is missing from the breakdown`);
  }
  assert.equal(wave.excluded.suppressed, 2);
  assert.equal(wave.excluded.no_consent, 1);
  assert.equal(wave.excluded.plan_incompatible, 0);
  assert.equal(wave.written, 1);
  assert.equal(wave.total, 4);
});

test("the columns add up to the total", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: false });
  await ledgerRow({ campaignId, waveId });
  await ledgerRow({ campaignId, waveId, excludedReason: "no_email" });
  await ledgerRow({ campaignId, waveId, excludedReason: "account_inactive" });
  await ledgerRow({ campaignId, waveId, excludedReason: "already_changed" });

  const [wave] = await waveAudienceBreakdown(campaignId);
  const excludedTotal = Object.values(wave.excluded).reduce(
    (sum, count) => sum + count,
    0
  );
  assert.equal(wave.written + excludedTotal, wave.total);
});

test("a reason outside the list cannot be stored, so the columns cannot go short", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: false });

  // The breakdown carries a branch for a reason it does not recognise, so the
  // totals keep adding up if the list ever loses a value while old rows hold
  // it. That branch cannot be reached through the database today, and this is
  // why: the CHECK refuses the row outright. Asserting the branch instead would
  // be asserting a state the schema makes unreachable.
  await assert.rejects(
    () => ledgerRow({ campaignId, waveId, excludedReason: "retired_reason" }),
    /excluded|check|constraint/i
  );

  const [wave] = await waveAudienceBreakdown(campaignId);
  assert.equal(wave.total, 0);
});

test("a dry-run wave is marked as one, so its written rows cannot read as sends", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: true });
  await ledgerRow({ campaignId, waveId });
  await ledgerRow({ campaignId, waveId });

  const [wave] = await waveAudienceBreakdown(campaignId);
  assert.equal(wave.dryRun, true);
  // The count is the same count a real wave would produce -- that is what makes
  // a dry run answer the question it is asked. Only the flag separates them.
  assert.equal(wave.written, 2);
});

test("cohorts are counted separately from exclusions", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: false });
  await ledgerRow({ campaignId, waveId, eligibilityReason: "default_model" });
  await ledgerRow({
    campaignId,
    waveId,
    eligibilityReason: "conversation_selection",
    excludedReason: "suppressed",
  });

  const [wave] = await waveAudienceBreakdown(campaignId);

  // An excluded person was still in the audience: the cohort says why the
  // expander looked at them, the exclusion says why it did not write to them.
  // Counting only the written ones would make the audience look smaller than
  // the query actually matched.
  assert.equal(wave.cohorts.default_model, 1);
  assert.equal(wave.cohorts.conversation_selection, 1);
  assert.equal(wave.cohorts.new_conversation_lead, 0);
});

test("a row whose cohort is null does not become a cohort of its own", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: false });
  // `already_changed` is exactly this: no longer in any cohort.
  await ledgerRow({
    campaignId,
    waveId,
    eligibilityReason: null,
    excludedReason: "already_changed",
  });

  const [wave] = await waveAudienceBreakdown(campaignId);
  assert.equal(wave.excluded.already_changed, 1);
  assert.equal(
    Object.values(wave.cohorts).reduce((sum, count) => sum + count, 0),
    0
  );
});

test("malformed rows are counted and do not disappear into a reason", async () => {
  const { campaignId, waveId } = await campaignWithWave({ dryRun: false });
  await ledgerRow({ campaignId, waveId, malformed: true });
  await ledgerRow({
    campaignId,
    waveId,
    malformed: true,
    excludedReason: "suppressed",
  });
  await ledgerRow({ campaignId, waveId });

  const [wave] = await waveAudienceBreakdown(campaignId);
  // Reported alongside the outcome rather than instead of it: a malformed
  // stored value is a fact about the reading, not a reason somebody was
  // excluded, and one of these two people was written to.
  assert.equal(wave.malformed, 2);
  assert.equal(wave.written, 2);
  assert.equal(wave.excluded.suppressed, 1);
});

test("waves are ordered by what they mean, not by when they were created", async () => {
  const { campaignId } = await campaignWithWave({
    dryRun: false,
    kind: "reminder",
  });
  const campaign = await prisma.emailCampaign.findFirstOrThrow({
    select: { id: true },
  });
  await prisma.emailCampaignWave.create({
    data: {
      campaignId: campaign.id,
      kind: "launch",
      sequence: 1,
      dryRun: false,
    },
  });

  const breakdown = await waveAudienceBreakdown(campaignId);
  // A reminder created before its launch is a mistake the screen has to show
  // as one; creation order would render it as a correct-looking sequence.
  assert.deepEqual(
    breakdown.map((wave) => wave.kind),
    ["launch", "reminder"]
  );
});

test("one campaign's ledger never leaks into another's", async () => {
  const first = await campaignWithWave({ dryRun: false });
  const second = await campaignWithWave({ dryRun: false });
  await ledgerRow({ ...first, excludedReason: "suppressed" });
  await ledgerRow({ ...second });

  const [firstWave] = await waveAudienceBreakdown(first.campaignId);
  const [secondWave] = await waveAudienceBreakdown(second.campaignId);
  assert.equal(firstWave.total, 1);
  assert.equal(firstWave.excluded.suppressed, 1);
  assert.equal(secondWave.total, 1);
  assert.equal(secondWave.written, 1);
});
