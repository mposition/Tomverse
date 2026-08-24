import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { MODEL_LAUNCH_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import {
  approveCampaign,
  createCampaignDraft,
  estimateCampaignAudience,
} from "@/lib/emailCampaignService";
import { AUDIENCE_DEFINITION_VERSION } from "@/lib/modelRetirementAudienceCore";
import { summariseRetirementAudience } from "@/lib/modelRetirementAudience";
import { prisma } from "@/lib/prisma";
import { EMAIL_CAMPAIGNS_FLAG_KEY } from "@/lib/emailFeatureFlags";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// Measuring the audience instead of typing a number (EM-01 slice 8).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11, §12.3.
//
// `estimatedRecipients` and `audienceVersion` have been on the row since the
// fourth slice and nothing wrote either from the audience. What needs a
// database is the whole of it: the count comes from a scan across accounts,
// settings and conversations, and the completeness CHECK is the database's own
// statement that a number, a time and a summary arrive together or not at all.

const TARGET = "gpt-5-4-mini";
const REPLACEMENT = "gpt-5-6-luna";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignRecipient", "EmailCampaignWave", "EmailCampaign",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "SuppressionEntry", "Conversation", "UserSettings", "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
  // Campaigns are off by default (EM-05). This suite is about the campaign
  // machinery, so it turns the switch on the way an operator would.
  await setEmailFeatureFlag(EMAIL_CAMPAIGNS_FLAG_KEY, true);
});

after(async () => {
  await prisma.$disconnect();
});

const draft = async (over: Record<string, unknown> = {}) =>
  createCampaignDraft({
    category: "model_retirement",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales: ["en"],
    audienceSpec: {
      cohort: {
        kind: "model_retirement",
        targetModelId: TARGET,
        replacementModelId: REPLACEMENT,
      },
    },
    createdByEmail: "owner@example.test",
    ...over,
  });

let seq = 0;
/** An account whose default model is the retiring one. */
const affectedUser = async (over: { email?: string | null } = {}) => {
  seq += 1;
  const user = await prisma.user.create({
    data: {
      email: over.email === undefined ? `person-${seq}@example.test` : over.email,
    },
    select: { id: true },
  });
  await prisma.userSettings.create({
    data: { userId: user.id, defaultModel: TARGET },
  });
  return user.id;
};

test("an unmeasured campaign holds no estimate at all, not a zero", async () => {
  const campaign = await draft();
  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: {
      estimatedRecipients: true,
      estimatedAt: true,
      audienceEstimate: true,
    },
  });
  // Three NULLs rather than a zero: "nobody has counted" and "the count is
  // nought" are different facts, and only one of them is a measurement.
  assert.equal(row.estimatedRecipients, null);
  assert.equal(row.estimatedAt, null);
  assert.equal(row.audienceEstimate, null);
});

test("measuring stores the count, the time, the person and the rules version", async () => {
  const campaign = await draft();
  await affectedUser();
  await affectedUser();

  const result = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
  });
  assert.ok(!("refused" in result));
  assert.equal(result.estimatedRecipients, 2);

  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: {
      estimatedRecipients: true,
      estimatedAt: true,
      estimatedByEmail: true,
      audienceVersion: true,
      audienceEstimate: true,
    },
  });
  assert.equal(row.estimatedRecipients, 2);
  assert.equal(row.estimatedByEmail, "ops@example.test");
  assert.equal(row.audienceVersion, AUDIENCE_DEFINITION_VERSION);
  assert.ok(row.estimatedAt instanceof Date);
  assert.ok(row.audienceEstimate);
});

test("the stored headline is the summary's notice audience, not its cohort size", async () => {
  const campaign = await draft();
  await affectedUser();
  // In the cohort and not written to: no address to write to.
  await affectedUser({ email: null });

  const result = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
  });
  assert.ok(!("refused" in result));

  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { estimatedRecipients: true, audienceEstimate: true },
  });
  const summary = row.audienceEstimate as unknown as {
    noticeAudience: number;
    distinctUsers: number;
    excluded: Record<string, number>;
  };

  // A campaign sized on everyone in the cohort would be sized on people it is
  // about to decide not to write to.
  assert.equal(summary.distinctUsers, 2);
  assert.equal(summary.noticeAudience, 1);
  assert.equal(summary.excluded.no_email, 1);
  assert.equal(row.estimatedRecipients, summary.noticeAudience);
});

test("the headline and the summary it came from cannot disagree", async () => {
  const campaign = await draft();
  await affectedUser();
  await affectedUser();
  await affectedUser({ email: null });

  await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
  });

  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { estimatedRecipients: true, audienceEstimate: true },
  });
  const summary = row.audienceEstimate as unknown as { noticeAudience: number };
  // The column is denormalised from the JSON deliberately -- the list view
  // already reads it -- so the one thing worth fixing is that they are written
  // together and cannot drift.
  assert.equal(row.estimatedRecipients, summary.noticeAudience);
});

test("re-measuring replaces the whole estimate rather than half of it", async () => {
  const campaign = await draft();
  await affectedUser();

  const first = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "first@example.test",
    now: new Date("2026-08-01T00:00:00.000Z"),
  });
  assert.ok(!("refused" in first));
  assert.equal(first.estimatedRecipients, 1);

  await affectedUser();
  const second = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "second@example.test",
    now: new Date("2026-08-02T00:00:00.000Z"),
  });
  assert.ok(!("refused" in second));

  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: {
      estimatedRecipients: true,
      estimatedAt: true,
      estimatedByEmail: true,
    },
  });
  assert.equal(row.estimatedRecipients, 2);
  assert.equal(row.estimatedByEmail, "second@example.test");
  assert.equal(row.estimatedAt?.toISOString(), "2026-08-02T00:00:00.000Z");
});

test("a scan that runs out of audience is not truncated", async () => {
  const campaign = await draft();
  await affectedUser();
  await affectedUser();
  await affectedUser();

  const result = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
    maxCandidates: 1,
  });
  assert.ok(!("refused" in result));

  // A cap below the audience size does *not* truncate a scan that has already
  // reached the end: the loop stops on a short page, which means the audience
  // ran out, and reporting that as a floor would understate a complete count.
  assert.equal(result.summary.truncated, false);
  assert.equal(result.estimatedRecipients, 3);
});

test("a scan cut short by the cap reports a floor, and the stored summary says so", async () => {
  const campaign = await draft();
  await affectedUser();
  await affectedUser();
  await affectedUser();

  // Driven through the summariser, which is where the page size lives: the cap
  // is only reachable when whole pages keep coming back, and the estimate above
  // uses the production page size of 200. Exposing `pageSize` on the service
  // just to reach this branch would put a test-only knob on a write path.
  const summary = await summariseRetirementAudience({
    targetModelId: TARGET,
    replacementModelId: REPLACEMENT,
    classification: "service",
    pageSize: 1,
    maxCandidates: 1,
  });
  assert.equal(summary.truncated, true);
  // Not adjusted, extrapolated or rounded -- exactly what was counted, which is
  // what makes "at least N" true rather than a guess at N.
  assert.equal(summary.noticeAudience, 1);
  assert.ok(summary.noticeAudience < 3);

  // And it survives being stored: a screen reads the flag off the row, not off
  // the response of the request that computed it.
  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: {
      estimatedRecipients: summary.noticeAudience,
      estimatedAt: new Date(),
      estimatedByEmail: "ops@example.test",
      audienceEstimate: summary as unknown as object,
    },
  });
  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { audienceEstimate: true },
  });
  assert.equal(
    (row.audienceEstimate as unknown as { truncated: boolean }).truncated,
    true
  );
});

test("a campaign with no cohort is refused rather than measured as zero", async () => {
  const campaign = await draft({ audienceSpec: { userIds: ["a", "b", "c"] } });

  const result = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
  });
  assert.ok("refused" in result);
  assert.equal(result.refused, "no_cohort");

  // Nothing written: reporting "0 recipients" for a campaign that names three
  // people explicitly would be a measurement of the wrong question.
  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { estimatedRecipients: true, estimatedAt: true },
  });
  assert.equal(row.estimatedRecipients, null);
  assert.equal(row.estimatedAt, null);
});

test("an approved campaign is refused, so the approver's number is not replaced", async () => {
  const campaign = await draft();
  await affectedUser();
  await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
  });
  // Approved the way the application approves: the status alone is refused by
  // `EmailCampaign_approval_completeness_check`, which wants the approval that
  // let it out and the copy that approval pinned. Setting the word by hand
  // would be testing against a state the schema forbids.
  await approveCampaign({ campaignId: campaign.id, approvalId: "approval-1" });

  await affectedUser();
  const result = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
  });
  assert.ok("refused" in result);
  assert.equal(result.refused, "already_approved");

  const row = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { estimatedRecipients: true },
  });
  // Still the number the approval was given against.
  assert.equal(row.estimatedRecipients, 1);
});

test("a cancelled campaign is refused", async () => {
  const campaign = await draft();
  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: { status: "cancelled", cancelledAt: new Date(), cancelReason: "no" },
  });

  const result = await estimateCampaignAudience({
    campaignId: campaign.id,
    byEmail: "ops@example.test",
  });
  assert.ok("refused" in result);
  assert.equal(result.refused, "cancelled");
});

test("an unknown campaign is refused, not thrown", async () => {
  const result = await estimateCampaignAudience({
    campaignId: "does-not-exist",
    byEmail: "ops@example.test",
  });
  assert.ok("refused" in result);
  assert.equal(result.refused, "not_found");
});

test("the database refuses half an estimate", async () => {
  const campaign = await draft();

  // The CHECK is the second statement of the same invariant the service keeps
  // by writing all three in one update: a number with no time is exactly the
  // typed guess this slice exists to stop being mistaken for a measurement.
  await assert.rejects(
    () =>
      prisma.emailCampaign.update({
        where: { id: campaign.id },
        data: { estimatedRecipients: 500 },
      }),
    /estimate|check|constraint/i
  );
});
