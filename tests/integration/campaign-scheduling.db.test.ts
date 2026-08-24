import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { MODEL_LAUNCH_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { prisma } from "@/lib/prisma";
import {
  approveCampaign,
  campaignScheduleProblems,
  cancelCampaign,
  createCampaignDraft,
  runDueCampaignWaves,
  scheduleCampaignWave,
} from "@/lib/emailCampaignService";
import {
  EMAIL_CAMPAIGNS_FLAG_KEY,
  EMAIL_MARKETING_FLAG_KEY,
} from "@/lib/emailFeatureFlags";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// Scheduled waves, and the two gates between a due time and a send
// (EM-01 slice 4).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §12.2, §13.3.
//
// The rules are pure and tested next door. What needs a database is that the
// wave row exists before it runs -- which is the whole reason scheduling is
// possible -- and that the approval gate still stands between a due time and a
// message going out.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignRecipient", "EmailCampaignWave", "EmailCampaign",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "UserSettings", "User"
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
  // These suites drive `model_launch`, which is classified marketing, so the
  // fan-out needs that flag on too (EM-05). Off is the default everywhere
  // else, which is what makes turning it on here a statement.
  await setEmailFeatureFlag(EMAIL_MARKETING_FLAG_KEY, true);
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

const PAST = new Date("2026-08-01T00:00:00Z");
const FUTURE = new Date("2099-01-01T00:00:00Z");

const accounts = async (count: number) => {
  const ids: string[] = [];
  for (let index = 0; index < count; index += 1) {
    const user = await prisma.user.create({
      data: {
        id: `u-${String(index).padStart(3, "0")}-${randomUUID().slice(0, 8)}`,
        email: `member-${index}-${randomUUID()}@example.test`,
      },
      select: { id: true },
    });
    ids.push(user.id);
  }
  return ids;
};

const campaign = async (input: {
  userIds: string[];
  triggerMode?: string;
  approve?: boolean;
  effectiveAt?: Date;
}) => {
  const draft = await createCampaignDraft({
    category: "model_retirement",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales: ["en"],
    audienceSpec: { userIds: input.userIds },
    createdByEmail: "ops@example.test",
  });
  await prisma.emailCampaign.update({
    where: { id: draft.id },
    data: {
      triggerMode: input.triggerMode ?? "approved_schedule",
      ...(input.effectiveAt
        ? { effectiveAt: input.effectiveAt, timezoneLabel: "Asia/Seoul" }
        : {}),
    },
  });
  if (input.approve !== false) {
    await approveCampaign({
      campaignId: draft.id,
      approvalId: `appr-${randomUUID()}`,
    });
  }
  return draft;
};

test("a scheduled wave exists before it runs, and sends nothing yet", async () => {
  // The whole reason scheduling is possible: a scheduler can only find work
  // somebody wrote down. `pending` with no event was allowed by the wave CHECK
  // from the second slice and had no writer until now.
  const ids = await accounts(2);
  const draft = await campaign({ userIds: ids });

  const wave = await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: FUTURE,
  });

  assert.equal(wave.status, "pending");
  assert.equal(await prisma.emailDelivery.count(), 0);
  const stored = await prisma.emailCampaignWave.findUniqueOrThrow({
    where: { id: wave.id },
    select: { eventId: true, scheduledAt: true },
  });
  assert.equal(stored.eventId, null);
  assert.equal(stored.scheduledAt?.toISOString(), FUTURE.toISOString());
});

test("a due wave is started, and everybody in it gets a row", async () => {
  const ids = await accounts(3);
  const draft = await campaign({ userIds: ids });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: PAST,
  });

  const outcomes = await runDueCampaignWaves();

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].started, true);
  assert.equal(await prisma.emailDelivery.count(), ids.length);
});

test("a wave due later is not touched", async () => {
  const ids = await accounts(1);
  const draft = await campaign({ userIds: ids });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: FUTURE,
  });

  assert.deepEqual(await runDueCampaignWaves(), []);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("a manual campaign is never started by the scheduler", async () => {
  const ids = await accounts(1);
  const draft = await campaign({ userIds: ids, triggerMode: "manual" });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: PAST,
  });

  assert.deepEqual(await runDueCampaignWaves(), []);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("a due wave on an unapproved campaign sends nothing and says why", async () => {
  // The case this pair of gates exists for. The schedule said send; the
  // approval gate said no. Collapsing them into one check would make the
  // second invisible.
  const ids = await accounts(2);
  const draft = await campaign({ userIds: ids, approve: false });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: PAST,
  });

  const outcomes = await runDueCampaignWaves();

  assert.equal(outcomes.length, 1);
  assert.equal(outcomes[0].started, false);
  assert.equal(outcomes[0].refusal, "not_approved");
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("a cancelled campaign's due wave stays unsent", async () => {
  const ids = await accounts(2);
  const draft = await campaign({ userIds: ids });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: PAST,
  });
  await cancelCampaign({ campaignId: draft.id, reason: "The date moved" });

  const outcomes = await runDueCampaignWaves();

  // Cancelling moves the wave off `pending`, so the scheduler does not find it
  // at all -- which is the same outcome by a shorter route.
  assert.deepEqual(outcomes, []);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("running the scheduler twice does not send twice", async () => {
  const ids = await accounts(2);
  const draft = await campaign({ userIds: ids });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: PAST,
  });

  await runDueCampaignWaves();
  const after = await prisma.emailDelivery.count();
  await runDueCampaignWaves();

  assert.equal(await prisma.emailDelivery.count(), after);
});

test("re-scheduling moves the time and nothing else", async () => {
  // A wave being moved is not an opportunity to quietly turn a dry run into a
  // real one, or to widen a cap somebody set deliberately.
  const ids = await accounts(1);
  const draft = await campaign({ userIds: ids });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: FUTURE,
    recipientCap: 5,
    dryRun: true,
  });

  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: PAST,
    recipientCap: 500,
    dryRun: false,
  });

  const stored = await prisma.emailCampaignWave.findFirstOrThrow({
    where: { campaignId: draft.id, kind: "notice" },
    select: { scheduledAt: true, recipientCap: true, dryRun: true },
  });
  assert.equal(stored.scheduledAt?.toISOString(), PAST.toISOString());
  assert.equal(stored.recipientCap, 5);
  assert.equal(stored.dryRun, true);
});

test("clearing the time returns a wave to being started by hand", async () => {
  const ids = await accounts(1);
  const draft = await campaign({ userIds: ids });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: PAST,
  });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: null,
  });

  assert.deepEqual(await runDueCampaignWaves(), []);
});

test("a reminder scheduled before its notice is reported", async () => {
  const ids = await accounts(1);
  const draft = await campaign({
    userIds: ids,
    effectiveAt: new Date("2099-06-01T00:00:00Z"),
  });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: new Date("2099-05-20T00:00:00Z"),
  });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "reminder",
    scheduledAt: new Date("2099-05-10T00:00:00Z"),
  });

  const problems = await campaignScheduleProblems({ campaignId: draft.id });
  assert.ok(problems.some((problem) => problem.code === "out_of_order"));
});

test("a notice after the effective date is reported", async () => {
  const ids = await accounts(1);
  const draft = await campaign({
    userIds: ids,
    effectiveAt: new Date("2099-06-01T00:00:00Z"),
  });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: new Date("2099-06-10T00:00:00Z"),
  });

  const problems = await campaignScheduleProblems({ campaignId: draft.id });
  assert.ok(problems.some((problem) => problem.code === "after_effective_at"));
});

test("a cancelled wave is not part of the schedule any more", async () => {
  const ids = await accounts(1);
  const draft = await campaign({
    userIds: ids,
    effectiveAt: new Date("2099-06-01T00:00:00Z"),
  });
  await scheduleCampaignWave({
    campaignId: draft.id,
    kind: "notice",
    scheduledAt: new Date("2099-06-10T00:00:00Z"),
  });
  await prisma.emailCampaignWave.updateMany({
    where: { campaignId: draft.id },
    data: { status: "cancelled" },
  });

  assert.deepEqual(await campaignScheduleProblems({ campaignId: draft.id }), []);
});

test("an effective date without a timezone is refused by the database", async () => {
  // Both or neither. A UTC instant with no label reads as a different day to
  // the person receiving the notice than to the person who set it.
  const draft = await campaign({ userIds: await accounts(1) });
  await assert.rejects(
    prisma.emailCampaign.update({
      where: { id: draft.id },
      data: { effectiveAt: FUTURE, timezoneLabel: null },
    }),
    /effective_at_has_a_timezone/
  );
});

test("a transition claim has to name both models", async () => {
  const draft = await campaign({ userIds: await accounts(1) });
  await assert.rejects(
    prisma.emailCampaign.update({
      where: { id: draft.id },
      data: { claimsAutomaticTransition: true },
    }),
    /transition_claim_names_models/
  );

  await prisma.emailCampaign.update({
    where: { id: draft.id },
    data: {
      claimsAutomaticTransition: true,
      targetModelId: "gpt-5-4-mini",
      replacementModelId: "gpt-5-6-luna",
    },
  });
  const stored = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: draft.id },
    select: { claimsAutomaticTransition: true },
  });
  assert.equal(stored.claimsAutomaticTransition, true);
});

test("an unknown trigger mode is refused by the database", async () => {
  const draft = await campaign({ userIds: await accounts(1) });
  await assert.rejects(
    prisma.emailCampaign.update({
      where: { id: draft.id },
      data: { triggerMode: "whenever" },
    }),
    /trigger_mode/
  );
});
