import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { randomUUID } from "node:crypto";

import { claimAmuxIdeaLane } from "@/lib/amux/ideaLaneService";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import {
  SystemIdeaRefused,
  commitSystemIdea,
  commitTraceReportIdea,
} from "@/lib/amux/ideaTraceReportSubmissionService";
import {
  developCiRepairAdmit,
  developCiRepairInFlight,
  runDevelopCiRepairQuietly,
  type DevelopCiRepairSubmit,
} from "@/lib/developCiRepair";
import {
  DEVELOP_CI_REPAIR_IDEA_ACTION,
  DEVELOP_CI_REPAIR_MIN_SIGHTING_GAP_MS,
  DEVELOP_CI_REPAIR_MODE_SETTING_KEY,
  DEVELOP_CI_REPAIR_PER_DAY,
  DEVELOP_CI_REPAIR_STATE_SETTING_KEY,
  developCiRepairRequestId,
} from "@/lib/developCiRepairCore";
import { prisma } from "@/lib/prisma";

// Develop CI repair: the pass's mode and sighting rows, the limits read from
// what a submission writes in its own transaction (the idea row and its system
// audit entry), and the lane claim that takes a repair idea first.

const KEYS = {
  masterKeyId: "synthetic-master",
  masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 1),
  digestKeyId: "synthetic-digest",
  digestKey: Buffer.alloc(32, 2),
};
// A day no audit row is written on, so earlier repairs (the chain keeps them)
// never count against this file's daily limit; only the last test uses today.
const T0 = new Date(Date.UTC(2099, 0, 1, 1));
const TODAY = new Date();
const later = (steps: number) => new Date(T0.getTime() + steps * (DEVELOP_CI_REPAIR_MIN_SIGHTING_GAP_MS + 1));

const head = () => randomUUID().replaceAll("-", "").padEnd(40, "0").slice(0, 40);
const red = (headSha: string) => ({ headSha, checkRuns: [{ id: 41, name: "Unit tests", conclusion: "failure" }] });

const inspected = (requestId: string, idea: string) => {
  const result = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea, repositories: [], pullRequests: [] } }),
  );
  assert.ok(result.ok);
  return result;
};

/** The real transaction, admit check included; only the key store is synthetic. */
const commitRepair = (ownerUserId: string, headSha: string, now: Date, idea = "Fix the failing CI on develop.") =>
  prisma.$transaction((tx) =>
    commitSystemIdea(tx, {
      source: "develop-ci-repair",
      ownerUserId,
      inspected: inspected(developCiRepairRequestId(headSha), idea),
      metadata: { headSha, checks: 1 },
      admit: developCiRepairAdmit(headSha, now),
      ideaId: randomUUID(),
      keys: KEYS as never,
    }),
  );

const realSubmit = () => {
  const ideas: string[] = [];
  const submit: DevelopCiRepairSubmit = async ({ ownerUserId, headSha, idea, now }) => {
    ideas.push(idea);
    return commitRepair(ownerUserId, headSha, now, idea);
  };
  return { ideas, submit };
};

const markMerged = (ideaId: string) =>
  prisma.amuxIdeaLaneAttempt.create({
    data: {
      id: randomUUID(),
      ideaId,
      claimedAt: new Date(),
      leaseUntil: new Date(),
      finishedAt: new Date(),
      outcome: "pr_open",
      prNumber: 1,
      mergedAt: new Date(),
    },
  });

const clearRepairs = async () => {
  const audits = await prisma.adminAuditLog.findMany({
    where: { action: DEVELOP_CI_REPAIR_IDEA_ACTION },
    select: { targetId: true },
  });
  // The audit rows stay (the chain is append-only); their ideas go, so no
  // earlier test's repair is in flight for the next one.
  await prisma.amuxIdeaSubmission.deleteMany({ where: { id: { in: audits.flatMap((row) => row.targetId ?? []) } } });
};

const reset = async () => {
  await prisma.appSetting.deleteMany({
    where: { key: { in: [DEVELOP_CI_REPAIR_MODE_SETTING_KEY, DEVELOP_CI_REPAIR_STATE_SETTING_KEY] } },
  });
  await clearRepairs();
};

const withOwner = async <T>(run: (ownerUserId: string) => Promise<T>) => {
  const email = `develop-ci-repair-${randomUUID()}@example.test`;
  const user = await prisma.user.create({ data: { email } });
  const saved = { ...process.env };
  try {
    process.env.ADMIN_EMAILS = email;
    process.env.ADMIN_OWNER_EMAILS = email;
    process.env.ADMIN_USER_IDS = "";
    process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "develop-ci-repair-test-audit-integrity-key-00000000";
    await prisma.appSetting.create({ data: { key: DEVELOP_CI_REPAIR_MODE_SETTING_KEY, value: `on:${user.id}` } });
    return await run(user.id);
  } finally {
    process.env = saved;
    await prisma.amuxIdeaSubmission.deleteMany({ where: { actorUserId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
};

const repairsToday = () =>
  prisma.adminAuditLog.count({
    where: {
      action: DEVELOP_CI_REPAIR_IDEA_ACTION,
      createdAt: { gte: new Date(Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate())) },
    },
  });

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("off by default: no row means no GitHub read and nothing written", async () => {
  let reads = 0;
  const sha = head();
  const pass = await runDevelopCiRepairQuietly({ readChecks: async () => (reads++, red(sha)), laneEnabled: () => true });
  assert.equal(pass.outcome, "off");
  assert.equal(reads, 0);
  assert.equal(await prisma.appSetting.count({ where: { key: DEVELOP_CI_REPAIR_STATE_SETTING_KEY } }), 0);
});

test("an owner who is no longer one, or a lane that is off, hands nothing over", async () => {
  await withOwner(async () => {
    const { ideas, submit } = realSubmit();
    const sha = head();
    assert.equal((await runDevelopCiRepairQuietly({ readChecks: async () => red(sha), submit, laneEnabled: () => false })).outcome, "lane_off");
    process.env.ADMIN_OWNER_EMAILS = "someone-else@example.test";
    assert.equal((await runDevelopCiRepairQuietly({ readChecks: async () => red(sha), submit, laneEnabled: () => true })).outcome, "owner_gone");
    assert.equal(ideas.length, 0);
  });
});

test("an unreadable develop is reported, not guessed", async () => {
  await withOwner(async () => {
    const pass = await runDevelopCiRepairQuietly({
      readChecks: async () => {
        throw new Error("not_configured");
      },
      laneEnabled: () => true,
    });
    assert.deepEqual(pass, { outcome: "unreadable", reason: "not_configured" });
  });
});

test("a red head is handed over on a second sighting the gap later, once", async () => {
  await withOwner(async (ownerUserId) => {
    const sha = head();
    const { ideas, submit } = realSubmit();
    const logs: number[] = [];
    const pass = (now: Date) =>
      runDevelopCiRepairQuietly({
        readChecks: async () => red(sha),
        readLogTail: async (id) => (logs.push(id), "not ok 1 - adds"),
        submit,
        laneEnabled: () => true,
        now,
      });
    assert.deepEqual(await pass(T0), { outcome: "none", reason: "first_sighting" });
    // An immediate second call is not a second sighting.
    assert.deepEqual(await pass(new Date(T0.getTime() + 1_000)), { outcome: "none", reason: "waiting" });
    const handed = await pass(later(1));
    assert.equal(handed.outcome, "submitted");
    assert.equal(ideas.length, 1);
    assert.ok(ideas[0].includes("not ok 1 - adds"));
    assert.deepEqual(logs, [41]);
    const idea = await prisma.amuxIdeaSubmission.findUniqueOrThrow({ where: { id: handed.ideaId } });
    assert.equal(idea.actorUserId, ownerUserId);
    assert.equal(idea.requestId, developCiRepairRequestId(sha));
    // The same head again: the idea row says it was handed over.
    assert.deepEqual(await pass(later(2)), { outcome: "none", reason: "same_head_already_submitted" });
    assert.equal(ideas.length, 1);
  });
});

test("a lost sighting row costs a sighting, never a limit: the repair in flight holds a new head back", async () => {
  await withOwner(async (ownerUserId) => {
    const { ideas, submit } = realSubmit();
    await commitRepair(ownerUserId, head(), T0);
    // The pass's own row is gone (a crash between the idea and the row, or a wipe).
    await prisma.appSetting.deleteMany({ where: { key: DEVELOP_CI_REPAIR_STATE_SETTING_KEY } });
    const second = head();
    const pass = (now: Date) =>
      runDevelopCiRepairQuietly({ readChecks: async () => red(second), readLogTail: async () => null, submit, laneEnabled: () => true, now });
    assert.equal((await pass(T0)).reason, "first_sighting");
    assert.deepEqual(await pass(later(1)), { outcome: "none", reason: "repair_in_flight" });
    assert.equal(ideas.length, 0);
  });
});

test("the transaction itself refuses a repair the limits no longer allow, and writes nothing", async () => {
  await withOwner(async (ownerUserId) => {
    const inFlight = await commitRepair(ownerUserId, head(), T0);
    assert.equal(await developCiRepairInFlight(inFlight.ideaId, Date.now()), true);
    const sha = head();
    await assert.rejects(commitRepair(ownerUserId, sha, T0), SystemIdeaRefused);
    assert.equal(await prisma.amuxIdeaSubmission.count({ where: { requestId: developCiRepairRequestId(sha) } }), 0);
    // Once that repair's PR merged, the next head may go.
    await markMerged(inFlight.ideaId);
    assert.equal(await developCiRepairInFlight(inFlight.ideaId, Date.now()), false);
    await commitRepair(ownerUserId, sha, T0);
    assert.equal(await prisma.amuxIdeaSubmission.count({ where: { requestId: developCiRepairRequestId(sha) } }), 1);
  });
});

test("the repair idea is audited as the system's, and the lane takes it before older ideas", async () => {
  await withOwner(async (ownerUserId) => {
    process.env.AMUX_IDEA_LANE_MAX_ATTEMPTS_PER_DAY = "100";
    const olderId = randomUUID();
    await prisma.$transaction((tx) =>
      commitTraceReportIdea(tx, {
        ownerUserId,
        caseId: "case-older",
        inspected: inspected(randomUUID(), "An older idea."),
        ideaId: olderId,
        keys: KEYS as never,
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const sha = head();
    const { ideaId: repairId } = await commitRepair(ownerUserId, sha, T0);
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: DEVELOP_CI_REPAIR_IDEA_ACTION, targetId: repairId },
    });
    assert.equal(audit.actorUserId, null);
    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.systemActor, "develop-ci-repair");
    assert.equal(metadata.authorizedByUserId, ownerUserId);
    assert.equal(metadata.headSha, sha);
    // No key store here, so the claim cannot open the idea; the attempt it
    // records says which idea it took.
    await claimAmuxIdeaLane({ actorUserId: ownerUserId });
    assert.equal(await prisma.amuxIdeaLaneAttempt.count({ where: { ideaId: repairId } }), 1);
    assert.equal(await prisma.amuxIdeaLaneAttempt.count({ where: { ideaId: olderId } }), 0);
  });
});

// Last: it fills today's limit, which the audit chain keeps.
test("the daily limit is counted from the audit entries", async () => {
  await withOwner(async (ownerUserId) => {
    while ((await repairsToday()) < DEVELOP_CI_REPAIR_PER_DAY) {
      const { ideaId } = await commitRepair(ownerUserId, head(), TODAY);
      await markMerged(ideaId);
    }
    await assert.rejects(commitRepair(ownerUserId, head(), TODAY), SystemIdeaRefused);
    // The same repairs, read from a later day, leave room again.
    await commitRepair(ownerUserId, head(), T0);
  });
});
