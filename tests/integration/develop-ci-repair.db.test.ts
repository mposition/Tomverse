import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { randomUUID } from "node:crypto";

import { claimAmuxIdeaLane } from "@/lib/amux/ideaLaneService";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { commitSystemIdea, commitTraceReportIdea } from "@/lib/amux/ideaTraceReportSubmissionService";
import {
  developCiRepairInFlight,
  runDevelopCiRepairQuietly,
  type DevelopCiRepairSubmit,
} from "@/lib/developCiRepair";
import {
  DEVELOP_CI_REPAIR_MODE_SETTING_KEY,
  DEVELOP_CI_REPAIR_STATE_SETTING_KEY,
  developCiRepairRequestId,
  readDevelopCiRepairState,
} from "@/lib/developCiRepairCore";
import { prisma } from "@/lib/prisma";

// Develop CI repair: the pass's mode and state rows, the system idea and its
// audit entry, and the lane claim that takes a repair idea first.

const HEAD = "c".repeat(40);
const KEYS = {
  masterKeyId: "synthetic-master",
  masterKeyVersion: 1,
  masterKey: Buffer.alloc(32, 1),
  digestKeyId: "synthetic-digest",
  digestKey: Buffer.alloc(32, 2),
};

const reset = () =>
  prisma.appSetting.deleteMany({
    where: { key: { in: [DEVELOP_CI_REPAIR_MODE_SETTING_KEY, DEVELOP_CI_REPAIR_STATE_SETTING_KEY] } },
  });

const red = { headSha: HEAD, checkRuns: [{ id: 41, name: "Unit tests", conclusion: "failure" }] };

const recordingSubmit = () => {
  const calls: Parameters<DevelopCiRepairSubmit>[0][] = [];
  const submit: DevelopCiRepairSubmit = async (input) => {
    calls.push(input);
    return { ideaId: `idea-${calls.length}` };
  };
  return { calls, submit };
};

const inspected = (requestId: string, idea: string) => {
  const result = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea, repositories: [], pullRequests: [] } }),
  );
  assert.ok(result.ok);
  return result;
};

const withOwner = async <T>(run: (ownerUserId: string) => Promise<T>) => {
  const email = `develop-ci-repair-${randomUUID()}@example.test`;
  const user = await prisma.user.create({ data: { email } });
  const saved = { ...process.env };
  try {
    process.env.ADMIN_EMAILS = email;
    process.env.ADMIN_OWNER_EMAILS = email;
    process.env.ADMIN_USER_IDS = "";
    return await run(user.id);
  } finally {
    process.env = saved;
    await prisma.amuxIdeaSubmission.deleteMany({ where: { actorUserId: user.id } });
    await prisma.user.deleteMany({ where: { id: user.id } });
  }
};

beforeEach(reset);

after(async () => {
  await reset();
  await prisma.$disconnect();
});

test("off by default: no row means no GitHub read and nothing written", async () => {
  let reads = 0;
  const pass = await runDevelopCiRepairQuietly({ readChecks: async () => (reads++, red), laneEnabled: () => true });
  assert.equal(pass.outcome, "off");
  assert.equal(reads, 0);
  assert.equal(await prisma.appSetting.count({ where: { key: DEVELOP_CI_REPAIR_STATE_SETTING_KEY } }), 0);
});

test("on: a red head is handed over on its second pass, once", async () => {
  await withOwner(async (ownerUserId) => {
    await prisma.appSetting.create({ data: { key: DEVELOP_CI_REPAIR_MODE_SETTING_KEY, value: `on:${ownerUserId}` } });
    const { calls, submit } = recordingSubmit();
    const logs: number[] = [];
    const deps = {
      readChecks: async () => red,
      readLogTail: async (id: number) => (logs.push(id), "not ok 1 - adds"),
      submit,
      laneEnabled: () => true,
    };
    assert.deepEqual(await runDevelopCiRepairQuietly(deps), { outcome: "none", reason: "first_sighting" });
    assert.equal(calls.length, 0);
    const second = await runDevelopCiRepairQuietly(deps);
    assert.equal(second.outcome, "submitted");
    assert.equal(calls.length, 1);
    assert.equal(calls[0].ownerUserId, ownerUserId);
    assert.equal(calls[0].headSha, HEAD);
    assert.ok(calls[0].idea.includes("not ok 1 - adds"));
    assert.deepEqual(logs, [41]);
    const state = readDevelopCiRepairState(
      (await prisma.appSetting.findUniqueOrThrow({ where: { key: DEVELOP_CI_REPAIR_STATE_SETTING_KEY } })).value,
    );
    assert.equal(state.lastHeadSha, HEAD);
    assert.equal(state.submitted, 1);
    // The same head again: nothing more, whether or not that idea still runs.
    assert.equal((await runDevelopCiRepairQuietly(deps)).reason, "same_head_already_submitted");
    assert.equal(calls.length, 1);
  });
});

test("an owner who is no longer one, or a lane that is off, hands nothing over", async () => {
  await withOwner(async (ownerUserId) => {
    await prisma.appSetting.create({ data: { key: DEVELOP_CI_REPAIR_MODE_SETTING_KEY, value: `on:${ownerUserId}` } });
    const { calls, submit } = recordingSubmit();
    assert.equal((await runDevelopCiRepairQuietly({ readChecks: async () => red, submit, laneEnabled: () => false })).outcome, "lane_off");
    process.env.ADMIN_OWNER_EMAILS = "someone-else@example.test";
    assert.equal((await runDevelopCiRepairQuietly({ readChecks: async () => red, submit, laneEnabled: () => true })).outcome, "owner_gone");
    assert.equal(calls.length, 0);
  });
});

test("an unreadable develop is reported, not guessed", async () => {
  await withOwner(async (ownerUserId) => {
    await prisma.appSetting.create({ data: { key: DEVELOP_CI_REPAIR_MODE_SETTING_KEY, value: `on:${ownerUserId}` } });
    const pass = await runDevelopCiRepairQuietly({
      readChecks: async () => {
        throw new Error("not_configured");
      },
      laneEnabled: () => true,
    });
    assert.deepEqual(pass, { outcome: "unreadable", reason: "not_configured" });
  });
});

test("the repair idea is the owner's, audited as the system's, and the lane takes it before older ideas", async () => {
  await withOwner(async (ownerUserId) => {
    process.env.ADMIN_AUDIT_INTEGRITY_KEY ??= "develop-ci-repair-test-audit-integrity-key-00000000";
    process.env.AMUX_IDEA_LANE_MAX_ATTEMPTS_PER_DAY = "100";
    // An older ordinary idea first, then the repair.
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
    const repairId = randomUUID();
    await prisma.$transaction((tx) =>
      commitSystemIdea(tx, {
        source: "develop-ci-repair",
        ownerUserId,
        inspected: inspected(developCiRepairRequestId(HEAD), "Fix the failing CI on develop."),
        metadata: { headSha: HEAD, checks: 1 },
        ideaId: repairId,
        keys: KEYS as never,
      }),
    );
    const audit = await prisma.adminAuditLog.findFirstOrThrow({
      where: { action: "develop_ci_repair.idea_submitted", targetId: repairId },
    });
    assert.equal(audit.actorUserId, null);
    const metadata = audit.metadata as Record<string, unknown>;
    assert.equal(metadata.systemActor, "develop-ci-repair");
    assert.equal(metadata.authorizedByUserId, ownerUserId);
    assert.equal(metadata.headSha, HEAD);

    assert.equal(await developCiRepairInFlight(repairId, Date.now()), true);
    // No key store here, so the claim cannot open the idea; the attempt it
    // records says which idea it took.
    await claimAmuxIdeaLane({ actorUserId: ownerUserId });
    assert.equal(await prisma.amuxIdeaLaneAttempt.count({ where: { ideaId: repairId } }), 1);
    assert.equal(await prisma.amuxIdeaLaneAttempt.count({ where: { ideaId: olderId } }), 0);

    // A repair whose PR merged no longer holds the next one back.
    await prisma.amuxIdeaLaneAttempt.updateMany({
      where: { ideaId: repairId },
      data: { outcome: "pr_open", prNumber: 1, mergedAt: new Date() },
    });
    assert.equal(await developCiRepairInFlight(repairId, Date.now()), false);
    assert.equal(await developCiRepairInFlight(null, Date.now()), false);
  });
});
