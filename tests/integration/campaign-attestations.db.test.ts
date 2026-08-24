import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { MODEL_LAUNCH_TEMPLATE } from "@/lib/emailTemplateDefinitions";
import { prisma } from "@/lib/prisma";
import {
  approveCampaign,
  campaignAttestationStates,
  campaignSendRefusal,
  campaignTransitionClaim,
  createCampaignDraft,
  recordCampaignAttestation,
  runCampaignWave,
  scheduleCampaignWave,
  withdrawCampaignAttestation,
} from "@/lib/emailCampaignService";
import {
  EMAIL_CAMPAIGNS_FLAG_KEY,
  EMAIL_MARKETING_FLAG_KEY,
} from "@/lib/emailFeatureFlags";
import { setEmailFeatureFlag } from "../support/emailFeatureFlag";

// Where the three unprovable conditions live, and what they gate
// (EM-01 slice 5).
//
// Contract: .github/audits/model-lifecycle-email-2026-08-22.md §13.3.
//
// The pure rules are tested next door. What needs a database is that the
// content digest is taken from the campaign rather than the caller, and that
// the twelve-condition gate actually stops a send.

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "EmailCampaignAttestation", "EmailCampaignRecipient", "EmailCampaignWave",
      "EmailCampaign", "EmailDelivery", "EmailEvent", "TemplateVersion",
      "EmailTemplate", "EmailPolicyVersion", "AdminActionApproval",
      "ModelLifecycleWorkItem", "UserSettings", "User"
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

const draft = async (input: { userIds: string[]; claims?: boolean }) => {
  const campaign = await createCampaignDraft({
    category: "model_retirement",
    templateKey: MODEL_LAUNCH_TEMPLATE,
    locales: ["en"],
    audienceSpec: { userIds: input.userIds },
    createdByEmail: "ops@example.test",
  });
  if (input.claims) {
    await prisma.emailCampaign.update({
      where: { id: campaign.id },
      data: {
        claimsAutomaticTransition: true,
        targetModelId: "gpt-5-4-mini",
        replacementModelId: "gpt-5-6-luna",
      },
    });
  }
  return campaign;
};

const state = (list: Awaited<ReturnType<typeof campaignAttestationStates>>, kind: string) =>
  list.find((entry) => entry.kind === kind);

test("the body attestation takes its digest from the campaign", async () => {
  const campaign = await draft({ userIds: await accounts(1) });
  await recordCampaignAttestation({
    campaignId: campaign.id,
    kind: "differences_stated",
    attestedByEmail: "reader@example.test",
  });

  const row = await prisma.emailCampaignAttestation.findFirstOrThrow({
    where: { campaignId: campaign.id, kind: "differences_stated" },
    select: { contentDigest: true, attestedByEmail: true },
  });
  assert.ok(row.contentDigest, "an attestation about words carries their digest");
  assert.equal(row.attestedByEmail, "reader@example.test");
  assert.equal(
    state(await campaignAttestationStates(campaign.id), "differences_stated")
      ?.satisfied,
    true
  );
});

test("a copy change makes the body attestation stale, and says whose it was", async () => {
  const campaign = await draft({ userIds: await accounts(1) });
  await recordCampaignAttestation({
    campaignId: campaign.id,
    kind: "differences_stated",
    attestedByEmail: "reader@example.test",
  });

  // What a copy edit does: the stored version's text stops matching the digest
  // the attestation was made against.
  await prisma.emailCampaignAttestation.updateMany({
    where: { campaignId: campaign.id, kind: "differences_stated" },
    data: { contentDigest: "en:as-it-read-then" },
  });

  const after = state(
    await campaignAttestationStates(campaign.id),
    "differences_stated"
  );
  assert.equal(after?.satisfied, false);
  assert.equal(after?.stale, true);
  assert.equal(after?.attestedByEmail, "reader@example.test");
});

test("the migration attestations carry no digest at all", async () => {
  // A rehearsal and a rollback are not about the words, and a digest would
  // expire them for a reason that has nothing to do with what they assert.
  const campaign = await draft({ userIds: await accounts(1) });
  for (const kind of ["staging_verified", "reconciliation_ready"] as const) {
    await recordCampaignAttestation({
      campaignId: campaign.id,
      kind,
      attestedByEmail: "ops@example.test",
    });
  }
  const rows = await prisma.emailCampaignAttestation.findMany({
    where: { campaignId: campaign.id, kind: { not: "differences_stated" } },
    select: { contentDigest: true },
  });
  assert.equal(rows.length, 2);
  assert.ok(rows.every((row) => row.contentDigest === null));
});

test("re-attesting replaces rather than stacks", async () => {
  // "Who says this is true" has one answer.
  const campaign = await draft({ userIds: await accounts(1) });
  await recordCampaignAttestation({
    campaignId: campaign.id,
    kind: "staging_verified",
    attestedByEmail: "first@example.test",
  });
  await recordCampaignAttestation({
    campaignId: campaign.id,
    kind: "staging_verified",
    attestedByEmail: "second@example.test",
  });

  const rows = await prisma.emailCampaignAttestation.findMany({
    where: { campaignId: campaign.id, kind: "staging_verified" },
    select: { attestedByEmail: true },
  });
  assert.deepEqual(rows, [{ attestedByEmail: "second@example.test" }]);
});

test("withdrawing leaves nothing behind", async () => {
  const campaign = await draft({ userIds: await accounts(1) });
  await recordCampaignAttestation({
    campaignId: campaign.id,
    kind: "staging_verified",
    attestedByEmail: "ops@example.test",
  });
  await withdrawCampaignAttestation({
    campaignId: campaign.id,
    kind: "staging_verified",
  });

  const after = state(
    await campaignAttestationStates(campaign.id),
    "staging_verified"
  );
  assert.equal(after?.satisfied, false);
  assert.equal(after?.stale, false, "withdrawn is absent, not stale");
});

test("an unknown kind is refused by the database", async () => {
  const campaign = await draft({ userIds: await accounts(1) });
  await assert.rejects(
    prisma.emailCampaignAttestation.create({
      data: {
        campaignId: campaign.id,
        kind: "looks_fine",
        attestedByEmail: "ops@example.test",
      },
    }),
    /kind_check/
  );
});

test("a nameless attestation is refused by the database", async () => {
  // An empty string is what a form posts when the field was never filled.
  const campaign = await draft({ userIds: await accounts(1) });
  await assert.rejects(
    prisma.emailCampaignAttestation.create({
      data: {
        campaignId: campaign.id,
        kind: "staging_verified",
        attestedByEmail: "   ",
      },
    }),
    /attested_by_check/
  );
});

test("a body attestation without a digest is refused by the database", async () => {
  const campaign = await draft({ userIds: await accounts(1) });
  await assert.rejects(
    prisma.emailCampaignAttestation.create({
      data: {
        campaignId: campaign.id,
        kind: "differences_stated",
        attestedByEmail: "ops@example.test",
      },
    }),
    /digest_only_for_content/
  );
});

test("a campaign that promises an automatic transition will not send unproven", async () => {
  // The enforcement point. Without it the twelve conditions are advice.
  const ids = await accounts(2);
  const campaign = await draft({ userIds: ids, claims: true });
  await approveCampaign({
    campaignId: campaign.id,
    approvalId: `appr-${randomUUID()}`,
  });

  const refusal = await campaignSendRefusal(campaign.id);
  assert.equal(refusal?.refusal, "transition_unproven");
  assert.match(refusal?.message ?? "", /twelve conditions/);

  const run = await runCampaignWave({ campaignId: campaign.id, kind: "notice" });
  assert.ok("refused" in run);
  assert.equal(await prisma.emailDelivery.count(), 0);
});

test("a campaign that promises nothing is unaffected by the gate", async () => {
  // The safe sentence -- "this model is going away, pick another" -- is always
  // sendable, and that is what makes the gate a choice rather than a blockage.
  const ids = await accounts(2);
  const campaign = await draft({ userIds: ids });
  await approveCampaign({
    campaignId: campaign.id,
    approvalId: `appr-${randomUUID()}`,
  });

  assert.equal(await campaignSendRefusal(campaign.id), null);
  const run = await runCampaignWave({ campaignId: campaign.id, kind: "notice" });
  assert.ok(!("refused" in run), JSON.stringify(run));
  assert.equal(await prisma.emailDelivery.count(), ids.length);
});

test("the claim reports every unmet condition at once", async () => {
  const campaign = await draft({ userIds: await accounts(1), claims: true });
  const { claim } = await campaignTransitionClaim(campaign.id);

  assert.equal(claim.mayClaim, false);
  // An operator fixing these is doing several different errands; one at a time
  // is several round trips.
  for (const condition of [
    "work_item_approved_retirement",
    "effective_at_fixed",
    "differences_stated",
    "staging_verified",
    "reconciliation_ready",
    "communication_approved",
    "completion_scheduled",
  ]) {
    assert.ok(claim.unmet.includes(condition as never), condition);
  }
  assert.equal(claim.reasons.length, claim.unmet.length);
});

test("attesting removes exactly the conditions it covers", async () => {
  const campaign = await draft({ userIds: await accounts(1), claims: true });
  for (const kind of [
    "differences_stated",
    "staging_verified",
    "reconciliation_ready",
  ] as const) {
    await recordCampaignAttestation({
      campaignId: campaign.id,
      kind,
      attestedByEmail: "ops@example.test",
    });
  }

  const { claim } = await campaignTransitionClaim(campaign.id);
  for (const condition of [
    "differences_stated",
    "staging_verified",
    "reconciliation_ready",
  ]) {
    assert.ok(!claim.unmet.includes(condition as never), condition);
  }
  // And the ones nobody attested to are still there.
  assert.ok(claim.unmet.includes("work_item_approved_retirement"));
});

test("a scheduled completion wave satisfies its condition", async () => {
  const campaign = await draft({ userIds: await accounts(1), claims: true });
  assert.ok(
    (await campaignTransitionClaim(campaign.id)).claim.unmet.includes(
      "completion_scheduled"
    )
  );

  await scheduleCampaignWave({
    campaignId: campaign.id,
    kind: "completion",
    scheduledAt: new Date("2099-01-01T00:00:00Z"),
  });

  assert.ok(
    !(await campaignTransitionClaim(campaign.id)).claim.unmet.includes(
      "completion_scheduled"
    )
  );
});

test("an approved work item with a ticket and an owner satisfies three", async () => {
  const campaign = await draft({ userIds: await accounts(1), claims: true });
  const workItem = await prisma.modelLifecycleWorkItem.create({
    data: {
      provider: "openai",
      apiModel: "gpt-5.4-mini",
      action: "retire",
      status: "approved",
      linkedIssueUrl: "https://github.com/mposition/tomverse/issues/1",
      ownerEmail: "ops@example.test",
    },
    select: { id: true },
  });
  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: { workItemId: workItem.id },
  });

  const { claim } = await campaignTransitionClaim(campaign.id);
  for (const condition of [
    "work_item_approved_retirement",
    "retirement_ticket",
    "owner_assigned",
  ]) {
    assert.ok(!claim.unmet.includes(condition as never), condition);
  }
});

test("a work item that is not an approved retirement satisfies none of the three", async () => {
  const campaign = await draft({ userIds: await accounts(1), claims: true });
  const workItem = await prisma.modelLifecycleWorkItem.create({
    data: {
      provider: "openai",
      apiModel: "gpt-5.4-mini",
      action: "monitor",
      status: "discovered",
    },
    select: { id: true },
  });
  await prisma.emailCampaign.update({
    where: { id: campaign.id },
    data: { workItemId: workItem.id },
  });

  const { claim } = await campaignTransitionClaim(campaign.id);
  assert.ok(claim.unmet.includes("work_item_approved_retirement"));
  assert.ok(claim.unmet.includes("retirement_ticket"));
  assert.ok(claim.unmet.includes("owner_assigned"));
});
