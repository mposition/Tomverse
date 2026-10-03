import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { deleteTomverseAccount } from "@/lib/accountDeletion";
import { prisma } from "@/lib/prisma";

// Support-triage data in a real account deletion (docs/policy/support-triage.md §5).
//
// What needs a database: account deletion keeps the reports and anonymises
// them, so the only thing that removes the triage rows derived from them is
// the delete inside that transaction. This drives the real deletion path,
// not a Feedback delete.

const reset = async () => {
  await prisma.$executeRawUnsafe(`DELETE FROM "SupportTriageSuggestion"`);
  await prisma.feedback.deleteMany({ where: { id: { startsWith: "fb-del-" } } });
  await prisma.user.deleteMany({ where: { email: { endsWith: "@support-triage-deletion.test" } } });
  await prisma.$executeRawUnsafe(`TRUNCATE TABLE "AdminAuditLog" RESTART IDENTITY CASCADE`);
};

const DIGEST = "a".repeat(64);

const seed = async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@support-triage-deletion.test`, accountStatus: "active", plan: "Free" },
  });
  const other = await prisma.user.create({
    data: { email: `${randomUUID()}@support-triage-deletion.test`, accountStatus: "active", plan: "Free" },
  });
  await prisma.feedback.create({ data: { id: "fb-del-mine-1", type: "bug", message: "mine one", userId: user.id } });
  await prisma.feedback.create({ data: { id: "fb-del-mine-2", type: "billing", message: "mine two", userId: user.id } });
  await prisma.feedback.create({ data: { id: "fb-del-other", type: "bug", message: "not mine", userId: other.id } });
  for (const [id, feedbackId] of [
    ["s-mine-1", "fb-del-mine-1"],
    ["s-mine-2", "fb-del-mine-2"],
    ["s-other", "fb-del-other"],
  ]) {
    await prisma.supportTriageSuggestion.create({ data: { id, feedbackId, inputDigest: DIGEST } });
  }
  // One of the account's suggestions carries a proposal, as a real one would.
  await prisma.supportTriageSuggestion.update({ where: { id: "s-mine-1" }, data: { state: "claimed", claimToken: "t" } });
  await prisma.supportTriageSuggestion.update({
    where: { id: "s-mine-1" },
    data: { state: "ready", lane: "trust_safety_human", keywordFlags: ["account_privacy"] },
  });
  return { user, other };
};

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("deleting an account deletes the triage rows derived from its reports, and only those", async () => {
  const { user } = await seed();
  const result = await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.equal(result.deleted, true);

  assert.deepEqual(
    (await prisma.supportTriageSuggestion.findMany({ select: { id: true } })).map((row) => row.id),
    ["s-other"]
  );
  // The reports themselves stay, anonymised.
  const report = await prisma.feedback.findUniqueOrThrow({ where: { id: "fb-del-mine-1" } });
  assert.equal(report.userId, null);
  assert.equal(report.message, "[deleted account]");

  const audits = await prisma.adminAuditLog.findMany({ where: { targetType: "SupportTriageSuggestion" } });
  assert.equal(audits.length, 1);
  assert.equal(audits[0].action, "support_triage.account_data_deleted");
  assert.equal(audits[0].actorUserId, null);
  assert.deepEqual(audits[0].metadata, { suggestions: 2, systemActor: "support-triage-account-deletion" });
  assert.equal(audits[0].targetId, null);
});

test("after the deletion nothing is derived again from those reports", async () => {
  const { user } = await seed();
  await deleteTomverseAccount(user.id, { cancelSubscription: false });
  await assert.rejects(
    prisma.supportTriageSuggestion.create({ data: { id: "again", feedbackId: "fb-del-mine-1", inputDigest: "b".repeat(64) } }),
    /deleted account/
  );
});

test("an account with nothing derived writes no triage audit entry", async () => {
  const user = await prisma.user.create({
    data: { email: `${randomUUID()}@support-triage-deletion.test`, accountStatus: "active", plan: "Free" },
  });
  await prisma.feedback.create({ data: { id: "fb-del-plain", type: "bug", message: "plain", userId: user.id } });
  await deleteTomverseAccount(user.id, { cancelSubscription: false });
  assert.equal(await prisma.adminAuditLog.count({ where: { targetType: "SupportTriageSuggestion" } }), 0);
});
