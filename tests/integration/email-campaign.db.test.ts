import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { MODEL_LAUNCH_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { observeOperationalIncidents } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import {
  approveCampaign,
  campaignSendRefusal,
  cancelCampaign,
  createCampaignDraft,
  runCampaignWave,
} from "@/lib/emailCampaignService";

// Campaigns: the layer above the fan-out (EM-01 slice 2, EM-06).
//
// Contract: docs/policy/email-notifications.md §12.3,
// .github/audits/model-lifecycle-email-2026-08-22.md §12.2, EM-06.
//
// EM-06's acceptance criterion is the third test: change the copy after
// approval and the campaign refuses to send. A copy edit mints a new
// TemplateVersion automatically, so without the pin an approval quietly comes
// to cover words nobody approved.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignWave", "EmailCampaign", "EmailDelivery", "EmailEvent",
      "TemplateVersion", "EmailTemplate", "EmailPolicyVersion", "UserSettings",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(async () => {
  await reset();
  process.env.EMAIL_AUDIT_HASH_KEY = "test-audit-key";
  process.env.EMAIL_SNAPSHOT_KEYS = "v1:test-snapshot-key";
  process.env.EMAIL_SNAPSHOT_KEY_VERSION = "v1";
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

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
  return ids.sort();
};

const draft = async (userIds: string[], locales = ["en"]) =>
  createCampaignDraft({
    category: "model_launch",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales,
    audienceSpec: { userIds },
    createdByEmail: "ops@example.test",
  });

/** What a copy edit does: the stored version's text stops matching its hash. */
const editApprovedCopy = async (campaignId: string) => {
  const campaign = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    select: { templateVersionIds: true },
  });
  const pinned = campaign.templateVersionIds as Record<
    string,
    { templateVersionId: string; contentHash: string }
  >;
  // The pin keeps the hash it was approved with while the template's current
  // rendering moves on, which is exactly the shape a code copy change leaves.
  await prisma.emailCampaign.update({
    where: { id: campaignId },
    data: {
      templateVersionIds: Object.fromEntries(
        Object.entries(pinned).map(([language, entry]) => [
          language,
          { ...entry, contentHash: `${entry.contentHash}-as-approved` },
        ])
      ),
    },
  });
};

test("a draft cannot send", async () => {
  const ids = await accounts(2);
  const campaign = await draft(ids);

  const refusal = await campaignSendRefusal(campaign.id);
  assert.equal(refusal?.refusal, "not_approved");

  const run = await runCampaignWave({ campaignId: campaign.id, kind: "launch" });
  assert.ok("refused" in run);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("an approved campaign pins its copy and then sends", async () => {
  const ids = await accounts(3);
  const campaign = await draft(ids);

  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });

  const stored = await prisma.emailCampaign.findUniqueOrThrow({
    where: { id: campaign.id },
    select: { status: true, approvalId: true, templateVersionIds: true },
  });
  assert.equal(stored.status, "approved");
  assert.equal(stored.approvalId, "appr_1");
  assert.ok(stored.templateVersionIds, "approval without a pin is EM-06's bug");

  const run = await runCampaignWave({ campaignId: campaign.id, kind: "launch" });
  assert.ok(!("refused" in run), JSON.stringify(run));
  assert.equal(await prisma.emailDelivery.count(), 3);

  const wave = await prisma.emailCampaignWave.findFirstOrThrow({
    select: { status: true, expandedCount: true, eventId: true },
  });
  assert.equal(wave.status, "expanded");
  assert.equal(wave.expandedCount, 3);
  assert.ok(wave.eventId);
});

test("changing the copy after approval refuses the send", async () => {
  // EM-06's acceptance criterion.
  const ids = await accounts(2);
  const campaign = await draft(ids);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });
  await editApprovedCopy(campaign.id);

  const incidents: string[] = [];
  const stop = observeOperationalIncidents((incident) => incidents.push(incident.code));
  let run;
  try {
    run = await runCampaignWave({ campaignId: campaign.id, kind: "launch" });
  } finally {
    stop();
  }

  assert.ok("refused" in run);
  assert.equal(run.refused.refusal, "content_changed");
  assert.equal(await prisma.emailDelivery.count(), 0, "nobody may be written to");
  assert.ok(
    incidents.includes("EMAIL_CAMPAIGN_CONTENT_CHANGED"),
    "somebody approved one thing and the deployment holds another"
  );
});

test("a locale added after approval is refused rather than sent unapproved", async () => {
  const ids = await accounts(2);
  const campaign = await draft(ids, ["en"]);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });

  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: { locales: ["en", "ko"] },
  });

  const refusal = await campaignSendRefusal(campaign.id);
  assert.equal(refusal?.refusal, "locale_not_pinned");
  assert.deepEqual(refusal.languages, ["ko"]);
});

test("running the same wave twice does not send twice", async () => {
  // The wave's unique index makes a second "launch 1" impossible; this makes
  // asking for one harmless, which is what a retried operator action is.
  const ids = await accounts(4);
  const campaign = await draft(ids);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });

  await runCampaignWave({ campaignId: campaign.id, kind: "launch" });
  const after = await prisma.emailDelivery.count();
  await runCampaignWave({ campaignId: campaign.id, kind: "launch" });

  assert.equal(await prisma.emailDelivery.count(), after);
  assert.equal(await prisma.emailCampaignWave.count(), 1, "and no second wave row");
});

test("two kinds of wave are two sends", async () => {
  const ids = await accounts(2);
  const campaign = await draft(ids);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });

  await runCampaignWave({ campaignId: campaign.id, kind: "launch" });
  await runCampaignWave({ campaignId: campaign.id, kind: "reminder" });

  assert.equal(await prisma.emailCampaignWave.count(), 2);
  // Each wave has its own event, so each is resumable and capped on its own.
  const waves = await prisma.emailCampaignWave.findMany({ select: { eventId: true } });
  assert.equal(new Set(waves.map((wave) => wave.eventId)).size, 2);
  assert.equal(await prisma.emailDelivery.count(), 4);
});

test("a cap on a wave is honoured", async () => {
  const ids = await accounts(5);
  const campaign = await draft(ids);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });

  await runCampaignWave({
    campaignId: campaign.id,
    kind: "launch",
    recipientCap: 2,
  });

  assert.equal(await prisma.emailDelivery.count(), 2);
});

test("a dry run writes rows nothing will send", async () => {
  const ids = await accounts(3);
  const campaign = await draft(ids);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });

  await runCampaignWave({ campaignId: campaign.id, kind: "launch", dryRun: true });

  const rows = await prisma.emailDelivery.findMany({
    select: { status: true, skipReason: true },
  });
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.status, "skipped");
    assert.equal(row.skipReason, "dry_run");
  }
});

test("cancelling stops the campaign and its unfinished waves", async () => {
  const ids = await accounts(2);
  const campaign = await draft(ids);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });
  await runCampaignWave({ campaignId: campaign.id, kind: "launch" });

  const result = await cancelCampaign({
    campaignId: campaign.id,
    reason: "The launch date moved",
  });
  assert.equal(result.campaign.status, "cancelled");
  assert.equal(result.wavesCancelled, 1);

  // And nothing more may be started.
  const run = await runCampaignWave({ campaignId: campaign.id, kind: "reminder" });
  assert.ok("refused" in run);
  assert.equal(run.refused.refusal, "cancelled");

  // Rows already written are left alone: a cancellation decides what happens
  // next, and rewriting them would lose what had already been done.
  assert.equal(await prisma.emailDelivery.count(), 2);
});

test("a campaign with no locales is refused at draft", async () => {
  await assert.rejects(
    () =>
      createCampaignDraft({
        category: "model_launch",
        templateKey: MODEL_LAUNCH_TEMPLATE,
        locales: [],
        audienceSpec: {},
        createdByEmail: "ops@example.test",
      }),
    /would send nothing/
  );
});

test("a draft naming an unknown template is refused at draft", async () => {
  // Rejected here rather than at send: a draft naming a template that does not
  // exist cannot be approved into anything.
  await assert.rejects(
    () =>
      createCampaignDraft({
        category: "other",
        templateKey: "no_such_template",
        locales: ["en"],
        audienceSpec: {},
        createdByEmail: "ops@example.test",
      }),
    /Unknown email template/
  );
});

test("only a draft can be approved", async () => {
  const ids = await accounts(1);
  const campaign = await draft(ids);
  await approveCampaign({ campaignId: campaign.id, approvalId: "appr_1" });

  await assert.rejects(
    () => approveCampaign({ campaignId: campaign.id, approvalId: "appr_2" }),
    /Only a draft can be approved/
  );
});
