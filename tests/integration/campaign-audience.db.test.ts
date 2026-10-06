import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import {
  MODEL_LAUNCH_TEMPLATE,
  POLICY_CHANGE_NOTICE_TEMPLATE,
  PRODUCT_ANNOUNCEMENT_TEMPLATE,
} from "@/lib/emailTemplateDefinitions";
import { ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT } from "@/lib/productAnnouncementEmail";
import { prisma } from "@/lib/prisma";
import { POLICY_NOTICE_CAMPAIGN_WAVES } from "@/lib/emailAudienceExpansionCore";
import { waveAudienceBreakdown } from "@/lib/adminEmailCampaigns";
import { expandEmailEvent } from "@/lib/emailAudienceExpansion";
import {
  ensureBootstrapPolicyVersion,
  ensureTemplateVersion,
} from "@/lib/emailTemplateRegistry";
import { setEmailPolicyPublishedForTests } from "@/lib/emailPolicyPublication";
import {
  approveCampaign,
  campaignScheduleProblems,
  createCampaignDraft,
  estimateCampaignAudience,
  runCampaignWave,
} from "@/lib/emailCampaignService";
import {
  audienceCandidatePage,
  audienceCandidatesByIds,
  summariseRetirementAudience,
} from "@/lib/modelRetirementAudience";
import {
  EMAIL_CAMPAIGNS_FLAG_KEY,
  EMAIL_MARKETING_FLAG_KEY,
  EMAIL_RELEASE_NOTES_FLAG_KEY,
} from "@/lib/emailFeatureFlags";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// Who a retirement reaches, and the record of who it did not (EM-01 slice 3).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §11, §12.2, §13.
//
// The audience calculator and the ledger rules are pure and tested elsewhere.
// What needs a database is the part that decides *membership*: three cohorts
// read from three different shapes of stored value, one of which is a JSON
// array inside a String column that only a substring match can be indexed on.

const RETIRING = "gpt-5-4-mini";
const REPLACEMENT = "gpt-5-6-luna";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignRecipient", "EmailCampaignWave", "EmailCampaign",
      "EmailDelivery", "EmailEvent", "TemplateVersion", "EmailTemplate",
      "EmailPolicyVersion", "Conversation", "UserSettings", "User"
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
  // product_updates is the release-notes product now, behind its own switch
  // (lib/emailFeatureFlags.ts); these suites exercise campaigns of that purpose.
  await setEmailFeatureFlag(EMAIL_RELEASE_NOTES_FLAG_KEY, true);
  // And published: the amendment S10 waits for is not in the repository yet.
  setEmailPolicyPublishedForTests(true);
});

after(async () => {
  await reset();
  await prisma.$disconnect();
});

let seq = 0;

const account = async (input: {
  defaultModel?: string;
  newConversationModelIds?: unknown;
  email?: string | null;
  plan?: string;
  accountStatus?: string;
  selectedModels?: string[];
}) => {
  seq += 1;
  const id = `u-${String(seq).padStart(3, "0")}-${randomUUID().slice(0, 8)}`;
  const user = await prisma.user.create({
    data: {
      id,
      email:
        input.email === null
          ? null
          : (input.email ?? `member-${seq}-${randomUUID()}@example.test`),
      ...(input.plan ? { plan: input.plan } : {}),
      ...(input.accountStatus ? { accountStatus: input.accountStatus } : {}),
      settings: {
        create: {
          defaultModel: input.defaultModel ?? REPLACEMENT,
          ...(input.newConversationModelIds === undefined
            ? {}
            : {
                newConversationModelIds:
                  input.newConversationModelIds as never,
              }),
        },
      },
    },
    select: { id: true },
  });

  if (input.selectedModels) {
    await prisma.conversation.create({
      data: {
        userId: user.id,
        title: "t",
        selectedModels: JSON.stringify(input.selectedModels),
      },
    });
  }
  return user.id;
};

const cohortsOf = async (userId: string) => {
  const [candidate] = await audienceCandidatesByIds({
    targetModelId: RETIRING,
    userIds: [userId],
  });
  return candidate?.cohorts ?? [];
};

test("the default model is a cohort", async () => {
  const id = await account({ defaultModel: RETIRING });
  assert.deepEqual(await cohortsOf(id), ["default_model"]);
});

test("a stored new-conversation combination is a cohort", async () => {
  const id = await account({
    newConversationModelIds: [REPLACEMENT, RETIRING],
  });
  assert.deepEqual(await cohortsOf(id), ["new_conversation_lead"]);
});

test("a conversation that selected it is a cohort", async () => {
  const id = await account({ selectedModels: [RETIRING] });
  assert.deepEqual(await cohortsOf(id), ["conversation_selection"]);
});

test("a person in all three is one person with three cohorts", async () => {
  // §11's whole point: the audit's own worked example had 10,963 rows for
  // 3,012 people, and a notice sized from the rows is three times too
  // confident about its reach.
  await account({
    defaultModel: RETIRING,
    newConversationModelIds: [RETIRING],
    selectedModels: [RETIRING],
  });
  const page = await audienceCandidatePage({
    targetModelId: RETIRING,
    after: null,
    take: 50,
  });
  assert.equal(page.length, 1);
  assert.deepEqual(page[0].cohorts, [
    "default_model",
    "new_conversation_lead",
    "conversation_selection",
  ]);
});

test("a model whose id merely contains the retiring one is not a match", async () => {
  // The database can only offer a substring match on selectedModels, which is
  // a JSON array in a String column. Searching for `gpt-5` matches every row
  // that selected `gpt-5-4-mini`, so the array is parsed and compared element
  // by element. Without that, a retirement notice reaches people whose model
  // is not going anywhere.
  const id = await account({ selectedModels: [`${RETIRING}-preview`] });

  const [candidate] = await audienceCandidatesByIds({
    targetModelId: RETIRING,
    userIds: [id],
  });
  assert.deepEqual(candidate.cohorts, []);

  // The page still returns them -- the substring condition is the only one the
  // database can offer, and dropping the near-misses here would let a page of
  // nothing but near-misses look like the end of the audience, so everybody
  // after it would never be read. Membership is `cohorts.length > 0`.
  const page = await audienceCandidatePage({
    targetModelId: RETIRING,
    after: null,
    take: 50,
  });
  assert.deepEqual(
    page.map((row) => row.userId),
    [id]
  );
  assert.deepEqual(page[0].cohorts, []);

  // And they are in none of the numbers.
  const summary = await summariseRetirementAudience({
    targetModelId: RETIRING,
    replacementModelId: REPLACEMENT,
    classification: "service",
  });
  assert.equal(summary.distinctUsers, 0);
  assert.equal(summary.noticeAudience, 0);
  assert.equal(summary.cohortRows.conversation_selection, 0);
});

test("a near-miss is written nowhere, because they are not in the campaign", async () => {
  // Recording them as `already_changed` would be a false record: they never
  // changed anything, and a reader counting `already_changed` would conclude
  // the first notice worked on people it never reached.
  await account({ selectedModels: [`${RETIRING}-preview`] });
  const campaign = await cohortCampaign();

  await runCampaignWave({ campaignId: campaign.id, kind: "notice" });

  assert.equal(await prisma.emailCampaignRecipient.count(), 0);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("an unreadable combination is reported, not guessed at", async () => {
  const id = await account({
    defaultModel: RETIRING,
    newConversationModelIds: ["", 7],
  });
  const [candidate] = await audienceCandidatesByIds({
    targetModelId: RETIRING,
    userIds: [id],
  });
  assert.equal(candidate.malformed, true);
  // Still in the audience through the cohort that could be read, and still
  // told: malformed means "cannot be migrated automatically", not "leave them
  // uninformed".
  assert.deepEqual(candidate.cohorts, ["default_model"]);
});

test("an account with no link to the model is never read", async () => {
  await account({ defaultModel: REPLACEMENT });
  await account({ defaultModel: RETIRING });

  const page = await audienceCandidatePage({
    targetModelId: RETIRING,
    after: null,
    take: 50,
  });
  assert.equal(page.length, 1);
});

test("the summary separates rows from people", async () => {
  await account({
    defaultModel: RETIRING,
    selectedModels: [RETIRING],
  });
  await account({ selectedModels: [RETIRING] });
  await account({ defaultModel: REPLACEMENT });

  const summary = await summariseRetirementAudience({
    targetModelId: RETIRING,
    replacementModelId: REPLACEMENT,
    classification: "service",
  });

  assert.equal(summary.distinctUsers, 2);
  assert.equal(summary.cohortRows.default_model, 1);
  assert.equal(summary.cohortRows.conversation_selection, 2);
  assert.equal(summary.cohortUsers.conversation_selection, 2);
  assert.equal(summary.noticeAudience, 2);
});

test("somebody with no address is excluded and counted", async () => {
  await account({ defaultModel: RETIRING, email: null });

  const summary = await summariseRetirementAudience({
    targetModelId: RETIRING,
    replacementModelId: REPLACEMENT,
    classification: "service",
  });
  assert.equal(summary.excluded.no_email, 1);
  assert.equal(summary.noticeAudience, 0);
});

const cohortCampaign = async () => {
  const campaign = await createCampaignDraft({
    category: "model_retirement",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales: ["en"],
    audienceSpec: {
      cohort: {
        kind: "model_retirement",
        targetModelId: RETIRING,
        replacementModelId: REPLACEMENT,
      },
    },
    createdByEmail: "ops@example.test",
  });
  await approveCampaign({
    campaignId: campaign.id,
    approvalId: `appr-${randomUUID()}`,
  });
  return campaign;
};

const ledger = (campaignId: string) =>
  prisma.emailCampaignRecipient.findMany({
    where: { campaignId },
    orderBy: { userId: "asc" },
    select: {
      userId: true,
      eligibilityReason: true,
      excludedReason: true,
      malformed: true,
      deliveryId: true,
    },
  });

test("a cohort wave writes a ledger entry for everybody it looked at", async () => {
  const reached = await account({ defaultModel: RETIRING });
  const noAddress = await account({ defaultModel: RETIRING, email: null });

  const campaign = await cohortCampaign();
  const run = await runCampaignWave({ campaignId: campaign.id, kind: "notice" });
  assert.ok(!("refused" in run), JSON.stringify(run));

  const rows = await ledger(campaign.id);
  assert.equal(rows.length, 2);

  const sent = rows.find((row) => row.userId === reached);
  assert.equal(sent?.excludedReason, null);
  assert.equal(sent?.eligibilityReason, "default_model");
  assert.ok(sent?.deliveryId, "an included person is linked to their delivery");

  const skipped = rows.find((row) => row.userId === noAddress);
  assert.equal(skipped?.excludedReason, "no_email");
  assert.equal(skipped?.deliveryId, null);
});

test("the ledger answers what EmailDelivery cannot", async () => {
  // A person with no address produces no delivery row at all, so the outbox has
  // nothing to record a reason on. That silence is the gap this table exists
  // for: without it, "who did this reach and why not the rest" has no answer.
  await account({ defaultModel: RETIRING, email: null });
  const campaign = await cohortCampaign();
  await runCampaignWave({ campaignId: campaign.id, kind: "notice" });

  assert.equal(await prisma.emailDelivery.count(), 0);
  assert.equal(
    (await ledger(campaign.id))[0].excludedReason,
    "no_email"
  );
});

test("the product update cohort reaches only active accounts with recorded consent", async () => {
  const createSubscriber = async (input: {
    enabled: boolean;
    grantedAt: Date | null;
    /** Defaults to grantedAt: an ordinary subscriber confirmed when they agreed. */
    confirmedAt?: Date | null;
    accountStatus?: string;
    email?: string | null;
  }) => {
    seq += 1;
    return prisma.user.create({
      data: {
        id: `subscriber-${String(seq).padStart(3, "0")}-${randomUUID().slice(0, 8)}`,
        email:
          input.email === null
            ? null
            : (input.email ?? `subscriber-${seq}@example.test`),
        accountStatus: input.accountStatus ?? "active",
        settings: { create: { language: "ko" } },
        emailPreferences: {
          create: {
            purpose: "product_updates",
            enabled: input.enabled,
            source: "preference_center",
            grantedAt: input.grantedAt,
            confirmedAt:
              input.confirmedAt === undefined ? input.grantedAt : input.confirmedAt,
          },
        },
      },
      select: { id: true },
    });
  };

  const included = await createSubscriber({ enabled: true, grantedAt: new Date() });
  const noAddress = await createSubscriber({
    enabled: true,
    grantedAt: new Date(),
    email: null,
  });
  await createSubscriber({ enabled: false, grantedAt: null });
  await createSubscriber({ enabled: true, grantedAt: null });
  // Switched on, never confirmed (docs/policy/email-double-opt-in.md §6): not
  // in the cohort and not in the ledger.
  await createSubscriber({ enabled: true, grantedAt: new Date(), confirmedAt: null });
  await createSubscriber({
    enabled: true,
    grantedAt: new Date(),
    accountStatus: "suspended",
  });

  const campaign = await createCampaignDraft({
    category: "other",
    templateKey: PRODUCT_ANNOUNCEMENT_TEMPLATE,
    locales: ["ko", "en"],
    contentByLocale: ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT,
    audienceSpec: {
      cohort: { kind: "marketing_consent", purpose: "product_updates" },
    },
    createdByEmail: "ops@example.test",
  });
  await approveCampaign({
    campaignId: campaign.id,
    approvalId: `appr-${randomUUID()}`,
  });
  const run = await runCampaignWave({ campaignId: campaign.id, kind: "launch" });
  assert.ok(!("refused" in run), JSON.stringify(run));

  assert.deepEqual(
    await prisma.emailDelivery.findMany({
      select: { userId: true, language: true },
    }),
    [{ userId: included.id, language: "ko" }]
  );
  const rows = await ledger(campaign.id);
  assert.equal(rows.length, 2);
  assert.equal(
    rows.find((row) => row.userId === included.id)?.eligibilityReason,
    "marketing_consent"
  );
  assert.equal(
    rows.find((row) => row.userId === noAddress.id)?.excludedReason,
    "no_email"
  );
});

test("running the same wave again does not duplicate the ledger", async () => {
  await account({ defaultModel: RETIRING });
  const campaign = await cohortCampaign();

  await runCampaignWave({ campaignId: campaign.id, kind: "notice" });
  const first = await ledger(campaign.id);
  // The event is `expanded` now, so the wave resumes rather than repeating --
  // and the unique index is what makes that harmless either way.
  await runCampaignWave({ campaignId: campaign.id, kind: "notice" });

  assert.deepEqual(await ledger(campaign.id), first);
});

test("a reminder records the people who already changed", async () => {
  // The point of the first notice was to get people to change this setting.
  // Telling the ones who did that their model is going away is untrue, and the
  // fastest way to be reported as spam (§12.3).
  const stayed = await account({ defaultModel: RETIRING });
  const moved = await account({ defaultModel: RETIRING });

  const campaign = await cohortCampaign();
  await runCampaignWave({ campaignId: campaign.id, kind: "notice" });

  await prisma.userSettings.update({
    where: { userId: moved },
    data: { defaultModel: REPLACEMENT },
  });

  const run = await runCampaignWave({ campaignId: campaign.id, kind: "reminder" });
  assert.ok(!("refused" in run), JSON.stringify(run));

  const reminderWave = await prisma.emailCampaignWave.findFirstOrThrow({
    where: { campaignId: campaign.id, kind: "reminder" },
    select: { id: true },
  });
  const rows = await prisma.emailCampaignRecipient.findMany({
    where: { waveId: reminderWave.id },
    select: { userId: true, excludedReason: true },
  });

  assert.equal(
    rows.find((row) => row.userId === moved)?.excludedReason,
    "already_changed"
  );
  assert.equal(rows.find((row) => row.userId === stayed)?.excludedReason, null);
});

test("a reminder asks about the people the campaign wrote to, not a fresh query", async () => {
  // A reminder that re-ran the audience query would simply not see the person
  // who took the first notice's advice, and "not seen" and "no longer
  // affected" would be the same silence.
  const moved = await account({ defaultModel: RETIRING });
  const campaign = await cohortCampaign();
  await runCampaignWave({ campaignId: campaign.id, kind: "notice" });

  await prisma.userSettings.update({
    where: { userId: moved },
    data: { defaultModel: REPLACEMENT },
  });

  assert.deepEqual(
    await audienceCandidatePage({
      targetModelId: RETIRING,
      after: null,
      take: 50,
    }),
    [],
    "the audience query no longer returns them, which is the problem"
  );

  await runCampaignWave({ campaignId: campaign.id, kind: "reminder" });
  const reminderWave = await prisma.emailCampaignWave.findFirstOrThrow({
    where: { campaignId: campaign.id, kind: "reminder" },
    select: { id: true },
  });
  assert.equal(
    await prisma.emailCampaignRecipient.count({
      where: { waveId: reminderWave.id, excludedReason: "already_changed" },
    }),
    1
  );
});

test("a wave that named its recipients writes no ledger", async () => {
  // There is no cohort attribution to record, and a guessed eligibilityReason
  // would put a made-up reason in the one table built not to do that.
  const id = await account({ defaultModel: RETIRING });
  const campaign = await createCampaignDraft({
    category: "model_retirement",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales: ["en"],
    audienceSpec: { userIds: [id] },
    createdByEmail: "ops@example.test",
  });
  await approveCampaign({
    campaignId: campaign.id,
    approvalId: `appr-${randomUUID()}`,
  });

  await runCampaignWave({ campaignId: campaign.id, kind: "notice" });

  assert.equal(await prisma.emailDelivery.count(), 1);
  assert.equal(await prisma.emailCampaignRecipient.count(), 0);
});

test("a campaign whose audience names nobody sends to nobody", async () => {
  // The regression: an unreadable spec defaults to an empty one, and an empty
  // one used to fall through to the unfiltered query -- so one mistyped field
  // would have sent a retirement notice to the whole product.
  await account({ defaultModel: REPLACEMENT });
  await account({ defaultModel: REPLACEMENT });

  const campaign = await createCampaignDraft({
    category: "model_retirement",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales: ["en"],
    audienceSpec: { userIdz: ["typo"] },
    createdByEmail: "ops@example.test",
  });
  await approveCampaign({
    campaignId: campaign.id,
    approvalId: `appr-${randomUUID()}`,
  });

  const run = await runCampaignWave({ campaignId: campaign.id, kind: "notice" });
  assert.ok(!("refused" in run));
  assert.ok("refused" in run.expansion);
  assert.equal(run.expansion.refused, "no_audience");
  assert.equal(await prisma.emailDelivery.count(), 0);
});

// The amendment notice cohort (S10): every owed account, once.

const NOTICE_COHORT = {
  cohort: { kind: "policy_change_notice", effectiveDate: "2026-11-16" },
};

const noticeDraft = () =>
  createCampaignDraft({
    category: "other",
    templateKey: POLICY_CHANGE_NOTICE_TEMPLATE,
    locales: ["ko", "en"],
    contentByLocale: { ko: {}, en: {} },
    audienceSpec: NOTICE_COHORT,
    createdByEmail: "ops@example.test",
  });

/** One profile in the active version, so a notice wave has a footer to print. */
const activeProfile = async () =>
  prisma.jurisdictionProfile.create({
    data: {
      profileKey: "ZZ",
      policyVersionId: await ensureBootstrapPolicyVersion(),
      marketingBasis: "opt_in",
      footerBlocks: ["legal_name", "postal_address", "contact_email"],
      unsubscribeSlaBusinessDays: 5,
      notes: "test profile",
    },
  });

const createdAt = (userId: string, value: Date | null) =>
  prisma.user.update({ where: { id: userId }, data: { createdAt: value } });

const noticeRecipients = async () =>
  (
    await prisma.emailDelivery.findMany({
      where: { templateVersion: { template: { key: POLICY_CHANGE_NOTICE_TEMPLATE } } },
      select: { userId: true },
    })
  )
    .map((row) => row.userId)
    .sort();

test("the amendment notice reaches every owed account once, and a later wave only the rest", async () => {
  // The approved hashes are for the production origin.
  process.env.PUBLIC_APP_URL = "https://tomverse.app";
  try {
    // With no profile in the active version the wave is refused before a row
    // exists: the notice would go out without the sender footer.
    const unprofiled = await noticeDraft();
    await approveCampaign({ campaignId: unprofiled.id, approvalId: `appr-${randomUUID()}` });
    const refused = await runCampaignWave({ campaignId: unprofiled.id, kind: "launch" });
    assert.ok("refused" in refused && refused.refused.refusal === "policy_without_profiles");
    assert.equal(await prisma.emailDelivery.count(), 0);
    await prisma.emailCampaign.delete({ where: { id: unprofiled.id } });
    await activeProfile();

    const owed = await account({});
    const suspended = await account({ accountStatus: "suspended" });
    const undated = await account({});
    const noAddress = await account({ email: null });
    const joinedAfter = await account({});
    await createdAt(owed, new Date("2026-01-01T00:00:00Z"));
    await createdAt(suspended, new Date("2026-03-01T00:00:00Z"));
    await createdAt(undated, null);
    await createdAt(noAddress, new Date("2026-02-01T00:00:00Z"));
    // On the effective day itself: the gate does not count it as owed.
    await createdAt(joinedAfter, new Date("2026-11-16T00:00:00Z"));

    // The waves the console drafts pass the approval schedule check.
    const consoleShaped = await createCampaignDraft({
      category: "other",
      templateKey: POLICY_CHANGE_NOTICE_TEMPLATE,
      locales: ["ko", "en"],
      contentByLocale: { ko: {}, en: {} },
      audienceSpec: NOTICE_COHORT,
      createdByEmail: "ops@example.test",
      initialWaves: POLICY_NOTICE_CAMPAIGN_WAVES,
    });
    assert.ok(POLICY_NOTICE_CAMPAIGN_WAVES.length >= 2);
    assert.equal(
      await prisma.emailCampaignWave.count({ where: { campaignId: consoleShaped.id } }),
      POLICY_NOTICE_CAMPAIGN_WAVES.length
    );
    assert.deepEqual(await campaignScheduleProblems({ campaignId: consoleShaped.id }), []);
    await prisma.emailCampaign.delete({ where: { id: consoleShaped.id } });

    const first = await noticeDraft();
    const estimate = await estimateCampaignAudience({
      campaignId: first.id,
      byEmail: "ops@example.test",
    });
    assert.ok(!("refused" in estimate), JSON.stringify(estimate));
    assert.equal(estimate.estimatedRecipients, 3);
    const summary = estimate.summary as {
      kind?: string;
      owed?: number;
      alreadyReached?: number;
      noAddress?: number;
    };
    assert.deepEqual(
      {
        kind: summary.kind,
        owed: summary.owed,
        alreadyReached: summary.alreadyReached,
        noAddress: summary.noAddress,
      },
      { kind: "policy_change_notice", owed: 4, alreadyReached: 0, noAddress: 1 }
    );

    await approveCampaign({ campaignId: first.id, approvalId: `appr-${randomUUID()}` });
    const launch = await runCampaignWave({ campaignId: first.id, kind: "launch" });
    assert.ok(!("refused" in launch), JSON.stringify(launch));
    // A legal message: the suspended account is owed it too. No ledger rows,
    // because the delivery row is this cohort's record.
    assert.deepEqual(await noticeRecipients(), [owed, suspended, undated].sort());
    assert.equal((await ledger(first.id)).length, 0);
    // The console reads the delivery rows for this audience, not an empty ledger.
    const [launchWave] = await waveAudienceBreakdown(first.id);
    assert.deepEqual(
      { keepsLedger: launchWave.keepsLedger, deliveries: launchWave.deliveries },
      { keepsLedger: false, deliveries: 3 }
    );

    // Asked again, the cohort holds nobody: each of them has a notice on its way.
    const again = await runCampaignWave({ campaignId: first.id, kind: "reminder" });
    assert.ok(!("refused" in again), JSON.stringify(again));
    assert.deepEqual(await noticeRecipients(), [owed, suspended, undated].sort());

    // One notice bounced. One was reported delivered with its arrival time,
    // which is what the gate counts as told. One was reported as a complaint
    // with no arrival time, which the gate does not count, so it is sent again.
    // And an account joined before the effective day.
    await prisma.emailDelivery.updateMany({
      where: { userId: owed },
      data: { status: "bounced" },
    });
    await prisma.emailDelivery.updateMany({
      where: { userId: undated },
      data: { status: "delivered", sentAt: new Date(), deliveredAt: new Date() },
    });
    await prisma.emailDelivery.updateMany({
      where: { userId: suspended },
      data: { status: "complained", sentAt: new Date(), deliveredAt: null },
    });
    const late = await account({});
    await createdAt(late, new Date("2026-10-20T00:00:00Z"));
    const followUp = await runCampaignWave({
      campaignId: first.id,
      kind: "final_reminder",
    });
    assert.ok(!("refused" in followUp), JSON.stringify(followUp));
    assert.deepEqual(
      await noticeRecipients(),
      [owed, owed, suspended, suspended, undated, late].sort()
    );

    // A notice sent with no delivery report is on its way for a few days, then
    // asked about again.
    const quiet = await account({});
    await createdAt(quiet, new Date("2026-04-01T00:00:00Z"));
    const sinceSent = await noticeDraft();
    await approveCampaign({ campaignId: sinceSent.id, approvalId: `appr-${randomUUID()}` });
    assert.ok(!("refused" in (await runCampaignWave({ campaignId: sinceSent.id, kind: "launch" }))));
    const quietRows = () =>
      prisma.emailDelivery.count({
        where: { userId: quiet, templateVersion: { template: { key: POLICY_CHANGE_NOTICE_TEMPLATE } } },
      });
    assert.equal(await quietRows(), 1);
    await prisma.emailDelivery.updateMany({
      where: { userId: { not: quiet } },
      data: { status: "delivered", sentAt: new Date(), deliveredAt: new Date() },
    });
    await prisma.emailDelivery.updateMany({
      where: { userId: quiet },
      data: { status: "sent", sentAt: new Date() },
    });
    assert.ok(!("refused" in (await runCampaignWave({ campaignId: sinceSent.id, kind: "reminder" }))));
    assert.equal(await quietRows(), 1);
    await prisma.emailDelivery.updateMany({
      where: { userId: quiet },
      data: { sentAt: new Date(Date.now() - 4 * 86_400_000) },
    });
    assert.ok(
      !("refused" in (await runCampaignWave({ campaignId: sinceSent.id, kind: "final_reminder" })))
    );
    assert.equal(await quietRows(), 2);
  } finally {
    delete process.env.PUBLIC_APP_URL;
  }
});

test("the notice cohort carries only the notice, and the notice only its cohort", async () => {
  process.env.PUBLIC_APP_URL = "https://tomverse.app";
  try {
    await assert.rejects(
      createCampaignDraft({
        category: "other",
        templateKey: PRODUCT_ANNOUNCEMENT_TEMPLATE,
        locales: ["ko", "en"],
        contentByLocale: ASSISTANT_KNOWLEDGE_CAMPAIGN_CONTENT,
        audienceSpec: NOTICE_COHORT,
        createdByEmail: "ops@example.test",
      }),
      /carries only policy_change_notice/
    );
    await assert.rejects(
      createCampaignDraft({
        category: "other",
        templateKey: POLICY_CHANGE_NOTICE_TEMPLATE,
        locales: ["ko", "en"],
        contentByLocale: { ko: {}, en: {} },
        audienceSpec: { cohort: { kind: "marketing_consent", purpose: "product_updates" } },
        createdByEmail: "ops@example.test",
      }),
      /its own cohort/
    );
    await assert.rejects(
      createCampaignDraft({
        category: "other",
        templateKey: POLICY_CHANGE_NOTICE_TEMPLATE,
        locales: ["ko", "en"],
        contentByLocale: { ko: {}, en: {} },
        audienceSpec: { cohort: { kind: "policy_change_notice", effectiveDate: "2026-11-15" } },
        createdByEmail: "ops@example.test",
      }),
      /announces 2026-11-16/
    );
    assert.equal(await prisma.emailCampaign.count(), 0);

    // An event stored before the draft check, or written another way, stops at
    // expansion before a single row.
    await account({});
    const template = await ensureTemplateVersion({
      templateKey: POLICY_CHANGE_NOTICE_TEMPLATE,
      language: "en",
    });
    const event = await prisma.emailEvent.create({
      data: {
        kind: `email.${POLICY_CHANGE_NOTICE_TEMPLATE}`,
        templateId: template.templateId,
        referenceType: "test",
        referenceId: randomUUID(),
        payload: {},
        audienceKind: "user_segment",
        audienceSpec: { cohort: { kind: "marketing_consent", purpose: "product_updates" } },
        status: "pending",
      },
      select: { id: true },
    });
    assert.deepEqual(await expandEmailEvent({ eventId: event.id }), {
      refused: "notice_audience_mismatch",
    });
    assert.equal(await prisma.emailDelivery.count(), 0);
  } finally {
    delete process.env.PUBLIC_APP_URL;
  }
});
