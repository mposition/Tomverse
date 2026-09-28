import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";

// Real PostgreSQL evidence for the engineering agent's state tables
// (docs/policy/engineering-agent.md §11): the triggers in migration
// 20260928120000_engineering_agent_state refuse what the policy forbids even
// when a caller writes the tables directly. A missing TEST_DATABASE_URL means
// this file was not executed, not that it passed.
//
// The store (lib/engineeringAgentStore.ts) is the only production writer;
// this file writes directly on purpose, to show the database holds the line
// by itself.

const requireDedicatedDatabase = () => {
  const testRaw = process.env.TEST_DATABASE_URL?.trim();
  if (!testRaw || process.env.DATABASE_URL?.trim() !== testRaw) {
    throw new Error("REFUSE: engineering agent DB tests require DATABASE_URL=TEST_DATABASE_URL");
  }
  const url = new URL(testRaw);
  const databaseName = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  if (!/(?:^|[_-])(?:test|testing|ci|e2e)(?:[_-]|$)/i.test(databaseName) || url.hostname.startsWith("pooled.")) {
    throw new Error("REFUSE: engineering agent DB tests require a direct dedicated test database");
  }
};

requireDedicatedDatabase();

const fixtureTaskIds: string[] = [];

after(async () => {
  if (fixtureTaskIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({ where: { id: { in: fixtureTaskIds } }, data: { archivedAt: new Date() } });
  }
  await prisma.$disconnect();
});

const sha1 = (seed: string) => createHash("sha1").update(seed).digest("hex");
const sha256 = (seed: string) => createHash("sha256").update(seed).digest("hex");
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000);
let runCounter = Math.floor(Date.now() / 1000) % 1_000_000_000;
const nextRunId = () => String((runCounter += 1));

/** The database refuses with a check violation, whatever the message. */
const refused = (promise: Promise<unknown>, label: string) =>
  assert.rejects(promise, (error: unknown) => /check_violation|23514|violates|constraint|cannot|only|must|starts|immutable|kept|after|match|decide|consume/i.test(String(error)), label);

const amuxAttempt = async () => {
  const task = await prisma.amuxWorkItem.create({
    data: {
      id: `eng-agent-card-${randomUUID()}`,
      title: "Engineering agent schema fixture",
      status: "review",
      kind: "code",
      priority: "p3",
      revision: 2,
      requiresHumanReview: true,
      reviewSpecialty: "code-review",
      reviewPrNumber: 1706,
    },
  });
  fixtureTaskIds.push(task.id);
  const now = new Date();
  const attempt = await prisma.amuxExecutionAttempt.create({
    data: {
      id: `eng-agent-attempt-${randomUUID()}`,
      taskId: task.id,
      worker: "engineering-runner",
      workerInstanceId: "schema-fixture",
      workerGeneration: 1,
      taskRevision: 1,
      attemptNumber: 1,
      heartbeatAt: now,
      startedAt: now,
      endedAt: now,
      outcome: "succeeded",
      toStatus: "review",
      endedBy: "engineering-runner",
    },
  });
  return { task, attempt };
};

const newRun = async (leaseSeconds = 60) => {
  const { task, attempt } = await amuxAttempt();
  return prisma.engineeringAgentRun.create({
    data: {
      id: nextRunId(),
      amuxAttemptId: attempt.id,
      cardId: task.id,
      cardKind: "code",
      baseSha: sha1("base"),
      leaseExpiresAt: inSeconds(leaseSeconds),
      // The trigger replaces a caller's clock with the database's.
      startedAt: new Date("2050-01-01T00:00:00.000Z"),
    },
  });
};

const newItem = (kind: string, extra: Record<string, unknown> = {}) =>
  prisma.engineeringAgentWorkItem.create({
    data: {
      id: randomUUID(),
      kind,
      state: ["publish", "expire_close", "prune"].includes(kind) ? "queued" : "open",
      causeKey: `${kind}:${randomUUID()}`,
      ...(kind === "t2_draft" || kind === "publish"
        ? { patchDigest: sha256("patch"), baseSha: sha1("base"), patchBody: kind === "t2_draft" ? "diff --git a/x b/x\n" : null }
        : {}),
      ...(kind === "publish" ? { expectedTreeId: sha1("tree") } : {}),
      ...extra,
    },
  });

const claim = (id: string, fencingToken: bigint, mode: "write" | "lookup", leaseSeconds = 60) =>
  prisma.engineeringAgentWorkItem.update({
    where: { id },
    data: { state: "claimed", claimMode: mode, fencingToken, leaseExpiresAt: inSeconds(leaseSeconds) },
  });

test("a run starts active on the database clock, ends once, and is not a success after its lease", async () => {
  const run = await newRun();
  assert.ok(run.startedAt.getTime() < Date.now() + 60_000, "the caller's start time was replaced");
  await refused(
    prisma.engineeringAgentRun.update({ where: { id: run.id }, data: { status: "finished" } }),
    "a finished run carries an outcome",
  );
  await prisma.engineeringAgentRun.update({ where: { id: run.id }, data: { status: "finished", outcome: "t2_draft" } });
  await refused(
    prisma.engineeringAgentRun.update({ where: { id: run.id }, data: { halt: "circuit_open" } }),
    "an ended run is immutable",
  );

  const late = await newRun(1);
  await sleep(1_500);
  await refused(
    prisma.engineeringAgentRun.update({ where: { id: late.id }, data: { status: "finished", outcome: "t1_queued" } }),
    "a run that outlived its lease does not finish",
  );
  await refused(
    prisma.engineeringAgentRun.update({ where: { id: late.id }, data: { leaseExpiresAt: inSeconds(60) } }),
    "a lease that ran out is not renewed",
  );
  await prisma.engineeringAgentRun.update({ where: { id: late.id }, data: { status: "abandoned", outcome: "abandoned" } });
  await refused(prisma.engineeringAgentRun.delete({ where: { id: (await newRun()).id } }), "an active run is not deleted");
});

test("a write item claims with the next fencing token, and a result after its lease is not a success", async () => {
  const item = await newItem("publish");
  await refused(claim(item.id, BigInt(5), "write"), "a claim takes the next token, not any token");
  await refused(claim(item.id, BigInt(1), "lookup"), "a lookup claim does not start from queued");
  await claim(item.id, BigInt(1), "write");
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: "published", fencingToken: BigInt(2) } }),
    "a result keeps the claim's token",
  );
  await prisma.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: "published" } });
  const closed = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(closed.claimMode, null);
  assert.ok(closed.closedAt);
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: "queued" } }),
    "a closed item is closed",
  );

  const slow = await newItem("prune");
  await claim(slow.id, BigInt(1), "write", 1);
  await sleep(1_500);
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: slow.id }, data: { state: "pruned" } }),
    "a write result after the lease is not a success",
  );
  await prisma.engineeringAgentWorkItem.update({ where: { id: slow.id }, data: { state: "needs_lookup" } });
  await claim(slow.id, BigInt(2), "lookup");
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: slow.id }, data: { state: "expired" } }),
    "only an unclaimed publish item expires, and only a publish item",
  );
});

test("a T2 decision is written first, binds to what the owner saw, and stays", async () => {
  const draft = await newItem("t2_draft");
  const session = {
    user: { id: `eng-agent-owner-${randomUUID()}`, email: "owner@example.test" },
    expires: inSeconds(3600).toISOString(),
  } as Session;
  const auditLogId = await writeAdminAuditLog({
    session,
    request: new Request("https://tomverse.test/api/admin/engineering-agent/decide"),
    action: "engineering_agent.t2_decision",
    targetType: "engineering_agent_work_item",
    targetId: draft.id,
    summary: "T2 decision fixture",
    metadata: { decision: "approved" },
  });

  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: draft.id }, data: { state: "approved" } }),
    "a draft does not close without its decision",
  );
  await refused(
    prisma.engineeringAgentApproval.create({
      data: {
        id: randomUUID(),
        workItemId: draft.id,
        decision: "approved",
        patchDigest: sha256("other patch"),
        baseSha: sha1("base"),
        actorUserId: session.user!.id!,
        auditLogId,
      },
    }),
    "a decision binds to the draft's digest",
  );
  const approval = await prisma.engineeringAgentApproval.create({
    data: {
      id: randomUUID(),
      workItemId: draft.id,
      decision: "approved",
      patchDigest: sha256("patch"),
      baseSha: sha1("base"),
      actorUserId: session.user!.id!,
      auditLogId,
    },
  });
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: draft.id }, data: { state: "rejected" } }),
    "the draft closes as decided, not otherwise",
  );
  await prisma.engineeringAgentWorkItem.update({ where: { id: draft.id }, data: { state: "approved" } });
  await refused(
    prisma.engineeringAgentApproval.update({ where: { id: approval.id }, data: { decision: "rejected" } }),
    "a decision is never changed",
  );
  await refused(prisma.engineeringAgentApproval.delete({ where: { id: approval.id } }), "a decision is kept");

  // Retention removes the body, never the digest.
  await prisma.engineeringAgentWorkItem.update({ where: { id: draft.id }, data: { patchBody: null } });
  const kept = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: draft.id } });
  assert.equal(kept.patchBody, null);
  assert.equal(kept.patchDigest, sha256("patch"));

  const open = await newItem("t2_draft");
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: open.id }, data: { patchBody: null } }),
    "an open draft keeps its body",
  );
});

test("a capability matches a queued publish item, is consumed once by the current write claim, then never changes", async () => {
  const item = await newItem("publish");
  const capability = {
    id: randomUUID(),
    workItemId: item.id,
    baseSha: sha1("base"),
    patchDigest: sha256("patch"),
    expectedTreeId: sha1("tree"),
    verifierVersion: 1,
    policyVersion: 1,
    branch: "agent/engineering/42",
    commitDigest: sha256("commit"),
    expiresAt: inSeconds(600),
  };
  await refused(
    prisma.engineeringAgentCapability.create({ data: { ...capability, id: randomUUID(), expectedTreeId: sha1("other") } }),
    "a capability matches its item",
  );
  const issued = await prisma.engineeringAgentCapability.create({ data: capability });
  await refused(
    prisma.engineeringAgentCapability.create({ data: { ...capability, id: randomUUID() } }),
    "one capability per publish item",
  );
  await refused(
    prisma.engineeringAgentCapability.update({
      where: { id: issued.id },
      data: { consumedAt: new Date(), claimFencingToken: BigInt(1) },
    }),
    "an unclaimed item cannot consume",
  );
  await claim(item.id, BigInt(1), "write");
  await refused(
    prisma.engineeringAgentCapability.update({
      where: { id: issued.id },
      data: { consumedAt: new Date(), claimFencingToken: BigInt(7) },
    }),
    "a stale fencing token cannot consume",
  );
  await prisma.engineeringAgentCapability.update({
    where: { id: issued.id },
    data: { consumedAt: new Date("2000-01-01T00:00:00.000Z"), claimFencingToken: BigInt(1) },
  });
  const consumed = await prisma.engineeringAgentCapability.findUniqueOrThrow({ where: { id: issued.id } });
  assert.ok(consumed.consumedAt && consumed.consumedAt.getFullYear() > 2000, "the database wrote the consumption time");
  await refused(
    prisma.engineeringAgentCapability.update({ where: { id: issued.id }, data: { consumedAt: null, claimFencingToken: null } }),
    "consumption is irrevocable",
  );
  await refused(prisma.engineeringAgentCapability.delete({ where: { id: issued.id } }), "a capability is kept");
});

test("a binding's snapshot never changes, and one row per pull request is current", async () => {
  const run = await newRun();
  const prNumber = 100_000 + Math.floor(Math.random() * 900_000);
  const binding = await prisma.engineeringAgentBinding.create({
    data: {
      id: randomUUID(),
      runId: run.id,
      prNumber,
      headSha: sha1("head"),
      verifiedHeadSha: sha1("head"),
      ref: `agent/engineering/${run.id}`,
      snapshot: { files: 1 },
    },
  });
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { snapshot: { files: 2 } } }),
    "a snapshot is immutable",
  );
  await refused(
    prisma.engineeringAgentBinding.create({
      data: {
        id: randomUUID(),
        runId: run.id,
        prNumber,
        headSha: sha1("head"),
        verifiedHeadSha: sha1("head"),
        ref: `agent/engineering/${run.id}`,
        snapshot: { files: 1 },
      },
    }),
    "one current binding per pull request",
  );
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { state: "pruned" } }),
    "a binding closes before it is pruned",
  );
  await prisma.engineeringAgentBinding.update({
    where: { id: binding.id },
    data: { state: "closed", reviewerGithubId: BigInt(60078951), reviewerLogin: "owner" },
  });
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { reviewerLogin: "someone-else" } }),
    "a recorded reviewer is not rewritten",
  );
  await prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { reviewerLogin: null } });
});

test("a registration result and a request's end are written once", async () => {
  const registration = await prisma.engineeringAgentRegistration.create({
    data: {
      id: randomUUID(),
      source: "S1",
      pinnedCommit: sha1("backlog"),
      itemKey: `ITEM-${randomUUID().slice(0, 8)}`,
      itemDigest: sha256("item"),
      proposalDigest: sha256("proposal"),
      guardResult: "register",
    },
  });
  await refused(
    prisma.engineeringAgentRegistration.update({ where: { id: registration.id }, data: { result: "registered" } }),
    "a registered result names its card",
  );
  await prisma.engineeringAgentRegistration.update({ where: { id: registration.id }, data: { result: "absent" } });
  await refused(
    prisma.engineeringAgentRegistration.update({ where: { id: registration.id }, data: { result: "partial" } }),
    "a result is written once",
  );

  const key = randomUUID().replace(/-/g, "");
  await prisma.engineeringAgentRequest.create({ data: { key, route: "run/start", requestDigest: sha256("request") } });
  await refused(
    prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "committed" } }),
    "a request commits only from in_progress",
  );
  await prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "in_progress" } });
  await refused(prisma.engineeringAgentRequest.delete({ where: { key } }), "an unfinished request is kept");
  await prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "committed" } });
  await refused(
    prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "aborted" } }),
    "a committed request stays committed",
  );
});
