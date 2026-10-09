import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
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
// The store is the only production writer; this file writes directly on
// purpose, to show the database holds the line by itself.
//
// The file runs under mode `t1`: a publish item comes only from a run that
// started under t1, so the first T1 window is open throughout and the pull
// request queue holds one. Every test therefore works one pull request at a
// time and closes what it opens -- runs ended, publish items settled,
// bindings pruned -- before the next begins.

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
const MODE_KEY = "feature.engineeringAgentMode";
const FREEZE_KEY = "feature.engineeringAgentFreeze";

const setMode = (value: string) =>
  prisma.appSetting.upsert({ where: { key: MODE_KEY }, create: { key: MODE_KEY, value }, update: { value } });

before(async () => {
  await setMode("t1");
  await prisma.appSetting.deleteMany({ where: { key: FREEZE_KEY } });
});

after(async () => {
  await prisma.appSetting.deleteMany({ where: { key: { in: [MODE_KEY, FREEZE_KEY] } } });
  if (fixtureTaskIds.length > 0) {
    await prisma.amuxWorkItem.updateMany({ where: { id: { in: fixtureTaskIds } }, data: { archivedAt: new Date() } });
  }
  await prisma.$disconnect();
});

const sha1 = (seed: string) => createHash("sha1").update(seed).digest("hex");
const sha256 = (seed: string) => createHash("sha256").update(seed).digest("hex");
const inSeconds = (seconds: number) => new Date(Date.now() + seconds * 1000);
let runCounter = Math.floor(Date.now() / 1000) % 100_000_000;
const nextRunId = () => String((runCounter += 1));

/** The database refuses, whatever the message. */
const refused = (promise: Promise<unknown>, label: string) =>
  assert.rejects(
    promise,
    (error: unknown) =>
      /check_violation|23514|23505|violates|constraint|cannot|only|must|starts|immutable|kept|after|match|decide|consume|refused|once|full|cap|without|whole|lapse|off|frozen|commit|product|one current/i.test(
        String(error),
      ),
    label,
  );

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
      // Still running: a run on an ended attempt is an orphaned run, which
      // halts the agent for every suite after this one (§11).
      leaseExpiresAt: new Date(now.getTime() + 60 * 60_000),
    },
  });
  return { task, attempt };
};

const newRun = async (leaseSeconds = 60, extra: { modeAtStart?: string } = {}) => {
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
      ...extra,
    },
  });
};

/** Ends a run, so the owner queue no longer counts what it might produce. */
const endRun = (id: string) =>
  prisma.engineeringAgentRun.update({ where: { id }, data: { status: "abandoned", outcome: "abandoned" } });

const productData = (kind: "t2_draft" | "publish", runId: string, patchBody = "patch") => ({
  id: randomUUID(),
  kind,
  state: kind === "publish" ? "queued" : "open",
  causeKey: `${kind}:${randomUUID()}`,
  runId,
  // The body is the text its digest names; the database checks it.
  patchBody,
  patchDigest: sha256("patch"),
  baseSha: sha1("base"),
  ...(kind === "publish" ? { expectedTreeId: sha1("tree") } : {}),
});

/** A run's one product, made while the run is active; the run then ends. */
const newProduct = async (kind: "t2_draft" | "publish") => {
  const run = await newRun();
  const item = await prisma.engineeringAgentWorkItem.create({ data: productData(kind, run.id) });
  await endRun(run.id);
  return item;
};

/** A work item that is no run's product. */
const newItem = (kind: "decision" | "state_mismatch" | "expire_close" | "prune") =>
  prisma.engineeringAgentWorkItem.create({
    data: {
      id: randomUUID(),
      kind,
      state: kind === "expire_close" || kind === "prune" ? "queued" : "open",
      causeKey: `${kind}:${randomUUID()}`,
    },
  });

const claim = (id: string, fencingToken: number, mode: "write" | "lookup", leaseSeconds = 60) =>
  prisma.engineeringAgentWorkItem.update({
    where: { id },
    data: {
      state: "claimed",
      claimMode: mode,
      fencingToken: BigInt(fencingToken),
      leaseExpiresAt: inSeconds(leaseSeconds),
    },
  });

const setState = (id: string, state: string) =>
  prisma.engineeringAgentWorkItem.update({ where: { id }, data: { state } });

/** Settles a publish item the owner queue would otherwise keep counting. */
const retirePublish = async (id: string) => {
  const item = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id } });
  if (item.state === "queued") {
    await setState(id, "expired");
    return;
  }
  if (item.state === "claimed" && item.leaseExpiresAt && item.leaseExpiresAt.getTime() > Date.now()) {
    await setState(id, "publish_failed");
    return;
  }
  if (item.state === "claimed") await setState(id, "needs_lookup");
  await claim(id, Number(item.fencingToken) + 1, "lookup");
  await setState(id, "publish_failed");
};

const issueCapability = async (
  workItemId: string,
  options: { expectedTreeId?: string; expiresInSeconds?: number; branch?: string } = {},
) => {
  const item = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: workItemId }, select: { runId: true } });
  return prisma.engineeringAgentCapability.create({
    data: {
      id: randomUUID(),
      workItemId,
      baseSha: sha1("base"),
      patchDigest: sha256("patch"),
      expectedTreeId: options.expectedTreeId ?? sha1("tree"),
      verifierVersion: 1,
      policyVersion: 1,
      // A capability allows its run's branch and no other.
      branch: options.branch ?? `agent/engineering/${item.runId}`,
      commitDigest: sha256("commit"),
      expiresAt: inSeconds(options.expiresInSeconds ?? 600),
    },
  });
};

const consume = (id: string, fencingToken: number) =>
  prisma.engineeringAgentCapability.update({
    where: { id },
    data: { consumedAt: new Date("2000-01-01T00:00:00.000Z"), claimFencingToken: BigInt(fencingToken) },
  });

/** Publishes a claimed item and binds its pull request in one transaction, as the publisher's result does. */
const publishAndBind = async (itemId: string, runId: string, prNumber = prNumberSeed()) => {
  const [, binding] = await prisma.$transaction([
    setState(itemId, "published"),
    prisma.engineeringAgentBinding.create({ data: bindingFor(runId, prNumber) }),
  ]);
  return binding;
};

/**
 * An active t1 run whose one publish item has been published and bound. The
 * caller retires the binding and ends the run.
 */
const publishedRun = async (prNumber = prNumberSeed()) => {
  const run = await newRun();
  const item = await prisma.engineeringAgentWorkItem.create({ data: productData("publish", run.id) });
  const capability = await issueCapability(item.id);
  await claim(item.id, 1, "write");
  await consume(capability.id, 1);
  const binding = await publishAndBind(item.id, run.id, prNumber);
  return { run, binding, prNumber };
};

const snapshot = (overrides: Record<string, unknown> = {}) => ({
  baseSha: sha1("base"),
  diffDigest: sha256("diff"),
  treeId: sha1("tree"),
  invalidatedReviewIds: [],
  ...overrides,
});

const approvedObservation = {
  verdict: "approved",
  reviewId: 7,
  reviewCommitId: sha1("head"),
  submittedAt: "2026-09-28T01:02:03.000Z",
  observedAt: "2026-09-28T01:03:03.000Z",
};

const bindingFor = (runId: string, prNumber: number) => ({
  id: randomUUID(),
  runId,
  prNumber,
  headSha: sha1("head"),
  verifiedHeadSha: sha1("head"),
  ref: `agent/engineering/${runId}`,
  snapshot: snapshot(),
});

const retireBinding = async (id: string) => {
  const binding = await prisma.engineeringAgentBinding.findUniqueOrThrow({ where: { id } });
  if (binding.state === "open") await prisma.engineeringAgentBinding.update({ where: { id }, data: { state: "closed" } });
  if (binding.state !== "pruned") await prisma.engineeringAgentBinding.update({ where: { id }, data: { state: "pruned" } });
};

const prNumberSeed = () => 100_000 + Math.floor(Math.random() * 800_000);

test("a run starts active on the database clock, on its attempt's card, ends once, and is not a success after its lease", async () => {
  const run = await newRun();
  assert.ok(run.startedAt.getTime() < Date.now() + 60_000, "the caller's start time was replaced");
  const { attempt } = await amuxAttempt();
  const { task: otherCard } = await amuxAttempt();
  await refused(
    prisma.engineeringAgentRun.create({
      data: {
        id: nextRunId(),
        amuxAttemptId: attempt.id,
        cardId: otherCard.id,
        cardKind: "code",
        baseSha: sha1("base"),
        leaseExpiresAt: inSeconds(60),
      },
    }),
    "a run binds an attempt to that attempt's own card",
  );
  await refused(
    prisma.engineeringAgentRun.update({ where: { id: run.id }, data: { status: "finished" } }),
    "a finished run carries an outcome",
  );
  await prisma.engineeringAgentRun.update({ where: { id: run.id }, data: { status: "finished", outcome: "private_result" } });
  assert.equal(await prisma.engineeringAgentWorkItem.count({ where: { runId: run.id } }), 0);
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
  await endRun(late.id);
  const extra = await newRun();
  await refused(prisma.engineeringAgentRun.delete({ where: { id: extra.id } }), "an active run is not deleted");
  await endRun(extra.id);
  // Ended runs are the circuit's input: an ended run with nothing pointing at
  // it is kept just the same.
  await refused(prisma.engineeringAgentRun.delete({ where: { id: late.id } }), "an abandoned run is not deleted");
  await refused(prisma.engineeringAgentRun.delete({ where: { id: run.id } }), "a finished run is not deleted");
});

test("a run is a claim: none while the mode is off or the agent is frozen, and it records the mode it committed under", async () => {
  try {
    await prisma.appSetting.deleteMany({ where: { key: MODE_KEY } });
    await refused(newRun(), "an unset mode is off, and off claims nothing");
    await setMode("t1-ish");
    await refused(newRun(), "an unknown mode is off");
    await setMode("shadow");
    await prisma.appSetting.create({ data: { key: FREEZE_KEY, value: "true" } });
    await refused(newRun(), "a frozen agent claims nothing");
    await prisma.appSetting.delete({ where: { key: FREEZE_KEY } });

    const run = await newRun(60, { modeAtStart: "t1" });
    assert.equal(run.modeAtStart, "shadow", "the trigger reads the mode; a caller's claim is replaced");
    await refused(
      prisma.engineeringAgentRun.update({ where: { id: run.id }, data: { modeAtStart: "t1" } }),
      "the mode a run started under never changes",
    );
    // In shadow a T1 result is a T2 draft: a shadow run makes no publish item.
    await refused(
      prisma.engineeringAgentWorkItem.create({ data: productData("publish", run.id) }),
      "a publish item comes only from a run that started under t1",
    );
    await endRun(run.id);

    // A mode set and taken back inside the run's own transaction was never in force.
    const { task, attempt } = await amuxAttempt();
    const runId = nextRunId();
    await refused(
      prisma.$transaction([
        setMode("t1"),
        prisma.engineeringAgentRun.create({
          data: {
            id: runId,
            amuxAttemptId: attempt.id,
            cardId: task.id,
            cardKind: "code",
            baseSha: sha1("base"),
            leaseExpiresAt: inSeconds(60),
          },
        }),
        setMode("shadow"),
      ]),
      "a run records the mode its transaction commits with",
    );
    assert.equal(await prisma.engineeringAgentRun.count({ where: { id: runId } }), 0, "nothing of it remains");
  } finally {
    await setMode("t1");
  }
});

test("a draft or a publish item is the one product of an active run", async () => {
  await refused(
    prisma.engineeringAgentWorkItem.create({ data: { ...productData("t2_draft", "0"), runId: null } }),
    "a product names its run",
  );
  const run = await newRun();
  await prisma.engineeringAgentWorkItem.create({ data: productData("t2_draft", run.id) });
  await refused(
    prisma.engineeringAgentWorkItem.create({ data: productData("publish", run.id) }),
    "a run has one product",
  );
  await endRun(run.id);
  await refused(
    prisma.engineeringAgentWorkItem.create({ data: productData("t2_draft", run.id) }),
    "an ended run makes nothing more",
  );
  const draft = await prisma.engineeringAgentWorkItem.findFirstOrThrow({ where: { runId: run.id } });
  await setState(draft.id, "expired");
  await refused(prisma.engineeringAgentWorkItem.delete({ where: { id: draft.id } }), "a closed work item is kept");
});

test("a write item claims with the next fencing token, and after its lease only a lookup follows", async () => {
  const item = await newItem("expire_close");
  await refused(claim(item.id, 5, "write"), "a claim takes the next token, not any token");
  await refused(claim(item.id, 1, "lookup"), "a lookup claim does not start from queued");
  await claim(item.id, 1, "write");
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: item.id }, data: { state: "closed", fencingToken: BigInt(2) } }),
    "a result keeps the claim's token",
  );
  await setState(item.id, "closed");
  const closed = await prisma.engineeringAgentWorkItem.findUniqueOrThrow({ where: { id: item.id } });
  assert.equal(closed.claimMode, null);
  assert.ok(closed.closedAt);
  await refused(setState(item.id, "queued"), "a closed item is closed");

  const slow = await newItem("prune");
  await claim(slow.id, 1, "write", 1);
  await sleep(1_500);
  for (const next of ["pruned", "prune_failed", "prune_refused", "queued", "outcome_unknown"]) {
    await refused(setState(slow.id, next), `after the lease, not ${next}`);
  }
  await setState(slow.id, "needs_lookup");
  await claim(slow.id, 2, "lookup");
  await refused(setState(slow.id, "expired"), "only an unclaimed publish item expires, and only a publish item");
  await setState(slow.id, "prune_failed");
});

test("a publish is a consumed capability; unwritten work returns to the queue under a new one", async () => {
  const bare = await newProduct("publish");
  await claim(bare.id, 1, "write");
  await refused(setState(bare.id, "published"), "no capability, no publish");
  await retirePublish(bare.id);

  const item = await newProduct("publish");
  const capability = await issueCapability(item.id);
  assert.equal(capability.unconsumedWorkItemId, item.id, "the new capability is the item's live one");
  await refused(issueCapability(item.id), "one live capability per publish item");
  await refused(consume(capability.id, 1), "an unclaimed item cannot consume");
  await claim(item.id, 1, "write");
  await refused(consume(capability.id, 7), "a stale fencing token cannot consume");
  await consume(capability.id, 1);
  const consumed = await prisma.engineeringAgentCapability.findUniqueOrThrow({ where: { id: capability.id } });
  assert.ok(consumed.consumedAt && consumed.consumedAt.getFullYear() > 2000, "the database wrote the consumption time");
  assert.equal(consumed.unconsumedWorkItemId, null, "a consumed capability is no longer live");
  await refused(
    prisma.engineeringAgentCapability.update({ where: { id: capability.id }, data: { consumedAt: null, claimFencingToken: null } }),
    "consumption is irrevocable",
  );
  await refused(prisma.engineeringAgentCapability.delete({ where: { id: capability.id } }), "a capability is kept");
  // Refused before writing (§10): back to the queue; the spent capability
  // stays spent and the next claim needs a new one.
  await setState(item.id, "queued");
  const second = await issueCapability(item.id);
  await claim(item.id, 2, "write");
  await refused(consume(capability.id, 2), "a spent capability is never consumed again");
  await consume(second.id, 2);
  // Published only with its binding: otherwise the queue would lose count of a real pull request.
  await refused(setState(item.id, "published"), "a publish is committed with its binding");
  await retireBinding((await publishAndBind(item.id, item.runId!)).id);

  // A lookup after an unknown outcome settles a publish an earlier write
  // claim consumed for.
  const looked = await newProduct("publish");
  const lookedCapability = await issueCapability(looked.id);
  await claim(looked.id, 1, "write");
  await consume(lookedCapability.id, 1);
  await setState(looked.id, "needs_lookup");
  await claim(looked.id, 2, "lookup");
  await retireBinding((await publishAndBind(looked.id, looked.runId!)).id);

  const unconsumed = await newProduct("publish");
  await issueCapability(unconsumed.id);
  await claim(unconsumed.id, 1, "write");
  await setState(unconsumed.id, "needs_lookup");
  await claim(unconsumed.id, 2, "lookup");
  await refused(setState(unconsumed.id, "published"), "a lookup finds no publish where nothing was consumed");
  await setState(unconsumed.id, "queued");
  await retirePublish(unconsumed.id);

  const lapsed = await newProduct("publish");
  const lapsedCapability = await issueCapability(lapsed.id);
  await claim(lapsed.id, 1, "write", 1);
  await sleep(1_500);
  await refused(consume(lapsedCapability.id, 1), "a claim whose lease has passed does not consume");
  await retirePublish(lapsed.id);

  // An unconsumed capability that expired may lapse, freeing its item for a
  // new one; a lapsed capability is never consumed.
  const expiring = await newProduct("publish");
  const short = await issueCapability(expiring.id, { expiresInSeconds: 1 });
  const lapse = () =>
    prisma.engineeringAgentCapability.update({ where: { id: short.id }, data: { unconsumedWorkItemId: null } });
  await refused(lapse(), "a capability lapses only after it expires");
  await sleep(1_500);
  await lapse();
  await claim(expiring.id, 1, "write");
  await refused(consume(short.id, 1), "a lapsed capability is never consumed");
  await setState(expiring.id, "queued");
  await issueCapability(expiring.id);
  await retirePublish(expiring.id);

  const mismatched = await newProduct("publish");
  await refused(issueCapability(mismatched.id, { expectedTreeId: sha1("other tree") }), "a capability matches its item");
  await refused(issueCapability(mismatched.id, { branch: "agent/engineering/42" }), "a capability allows only its run's branch");
  await retirePublish(mismatched.id);

  const run = await newRun();
  await refused(
    prisma.engineeringAgentWorkItem.create({ data: { ...productData("publish", run.id), patchBody: null } }),
    "a publish item carries the patch the publisher applies",
  );
  await refused(
    prisma.engineeringAgentWorkItem.create({ data: productData("publish", run.id, "diff --git a/x b/x") }),
    "the patch is the text its digest names",
  );
  await refused(
    prisma.engineeringAgentWorkItem.create({
      data: { id: randomUUID(), kind: "decision", state: "open", causeKey: `decision:${randomUUID()}`, patchBody: "patch" },
    }),
    "no other kind carries a patch",
  );
  await endRun(run.id);
});

test("a T2 decision closes its draft in the same transaction, binds to what the owner saw, and stays", async () => {
  const session = {
    user: { id: `eng-agent-owner-${randomUUID()}`, email: "owner@example.test" },
    expires: inSeconds(3600).toISOString(),
  } as Session;
  const audit = (targetId: string) =>
    writeAdminAuditLog({
      session,
      request: new Request("https://tomverse.test/api/admin/engineering-agent/decide"),
      action: "engineering_agent.t2_decision",
      targetType: "engineering_agent_work_item",
      targetId,
      summary: "T2 decision fixture",
      metadata: { decision: "approved" },
    });
  const decision = (workItemId: string, auditLogId: string, patchDigest = sha256("patch")) =>
    prisma.engineeringAgentApproval.create({
      data: {
        id: randomUUID(),
        workItemId,
        decision: "approved",
        patchDigest,
        baseSha: sha1("base"),
        actorUserId: session.user!.id!,
        auditLogId,
      },
    });

  const draft = await newProduct("t2_draft");
  await refused(setState(draft.id, "approved"), "a draft does not close without its decision");
  await refused(decision(draft.id, await audit(draft.id), sha256("other patch")), "a decision binds to the draft's digest");
  await refused(decision(draft.id, await audit(draft.id)), "a decision alone, with the draft left open, does not commit");

  const auditLogId = await audit(draft.id);
  const [approval] = await prisma.$transaction([decision(draft.id, auditLogId), setState(draft.id, "approved")]);
  await refused(
    prisma.engineeringAgentApproval.update({ where: { id: approval.id }, data: { decision: "rejected" } }),
    "a decision is never changed",
  );
  await refused(prisma.engineeringAgentApproval.delete({ where: { id: approval.id } }), "a decision is kept");
  await refused(
    prisma.engineeringAgentWorkItem.update({ where: { id: draft.id }, data: { patchBody: null } }),
    "the patch body is kept until a retention period is fixed",
  );

  const other = await newProduct("t2_draft");
  const otherAudit = await audit(other.id);
  await refused(
    prisma.$transaction([decision(other.id, otherAudit), setState(other.id, "expired")]),
    "a decided draft does not merely expire",
  );
  await refused(
    prisma.$transaction([decision(other.id, otherAudit), setState(other.id, "rejected")]),
    "the draft closes as decided, not otherwise",
  );
  await setState(other.id, "expired");
});

test("a binding records its run's published item, keeps its snapshot, and records observations and its reviewer once", async () => {
  const bare = await newRun();
  await refused(
    prisma.engineeringAgentBinding.create({ data: bindingFor(bare.id, prNumberSeed()) }),
    "a binding records a published item, and this run has none",
  );
  await endRun(bare.id);

  const { run, binding, prNumber } = await publishedRun();
  assert.equal(binding.currentPrNumber, prNumber, "the database marks the row current");
  await refused(prisma.engineeringAgentBinding.create({ data: bindingFor(run.id, prNumber) }), "one current binding per pull request");
  await refused(
    prisma.engineeringAgentBinding.create({ data: bindingFor(run.id, prNumber + 1) }),
    "one current binding per run",
  );
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { snapshot: snapshot({ diffDigest: sha256("other") }) } }),
    "a snapshot is immutable",
  );
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { state: "pruned" } }),
    "a binding closes before it is pruned",
  );
  await prisma.engineeringAgentBinding.update({
    where: { id: binding.id },
    data: { state: "closed", approvalObservation: approvedObservation, reviewerGithubId: BigInt(60078951), reviewerLogin: "owner" },
  });
  await refused(
    prisma.engineeringAgentBinding.update({
      where: { id: binding.id },
      data: { approvalObservation: { verdict: "not_approved", reason: "snapshot_changed", observedAt: "2026-09-28T01:04:03.000Z" } },
    }),
    "an observation is recorded once",
  );
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { reviewerLogin: "someone-else" } }),
    "a recorded reviewer is not rewritten",
  );
  // Half a reviewer is no reviewer: retention removes the pair or nothing.
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { reviewerGithubId: null } }),
    "the reviewer's number is not removed without its login",
  );
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { reviewerLogin: null } }),
    "the reviewer's login is not removed without its number",
  );
  await prisma.engineeringAgentBinding.update({
    where: { id: binding.id },
    data: { reviewerLogin: null, reviewerGithubId: null },
  });
  await refused(
    prisma.engineeringAgentBinding.update({
      where: { id: binding.id },
      data: { reviewerLogin: "someone-else", reviewerGithubId: BigInt(1) },
    }),
    "a removed reviewer is not put back",
  );

  await retireBinding(binding.id);
  await refused(prisma.engineeringAgentBinding.delete({ where: { id: binding.id } }), "a pruned binding is kept");
  await endRun(run.id);
});

test("a binding's JSON holds digests, enums and review ids, never free text or a person", async () => {
  const { run, binding, prNumber } = await publishedRun();
  const replaceWith = (data: Record<string, unknown>) =>
    prisma.$transaction([
      prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data: { supersededAt: new Date() } }),
      prisma.engineeringAgentBinding.create({ data: { ...bindingFor(run.id, prNumber), ...data } }),
    ]);
  const snapshotRefused = (promise: Promise<unknown>, label: string) =>
    assert.rejects(promise, /EngineeringAgentBinding_snapshot_check/, label);
  await snapshotRefused(replaceWith({ snapshot: snapshot({ note: "free text" }) }), "a snapshot has an exact key set");
  await snapshotRefused(replaceWith({ snapshot: snapshot({ baseSha: "main" }) }), "a snapshot's base is a commit id");
  await snapshotRefused(replaceWith({ snapshot: snapshot({ invalidatedReviewIds: ["mposition"] }) }), "invalidated reviews are ids");
  await snapshotRefused(replaceWith({ snapshot: snapshot({ invalidatedReviewIds: [1.5] }) }), "a review id is a whole number");

  const observe = (data: Record<string, unknown>) =>
    prisma.engineeringAgentBinding.update({ where: { id: binding.id }, data });
  await refused(observe({ approvalObservation: { ...approvedObservation, reviewerLogin: "mposition" } }), "no person in an observation");
  await refused(observe({ approvalObservation: { ...approvedObservation, reviewId: 1.5 } }), "an approving review id is a whole number");
  await refused(
    observe({ approvalObservation: { verdict: "not_approved", reason: "looked fine", observedAt: "2026-09-28T01:03:03.000Z" } }),
    "a reason is an enum",
  );
  await refused(
    observe({
      mergeObservation: {
        merged: true,
        mergeCommitSha: sha1("merge"),
        mergedAt: "2026-09-28T02:00:00.000Z",
        mergedByKind: "mposition",
        observedAt: "2026-09-28T02:01:00.000Z",
      },
    }),
    "a merger is a kind, never who",
  );
  await refused(
    observe({
      mergeObservation: {
        merged: true,
        mergeCommitSha: null,
        mergedAt: null,
        mergedByKind: "user",
        observedAt: "2026-09-28T02:01:00.000Z",
      },
    }),
    "a merge has a commit and a time",
  );
  await observe({
    mergeObservation: {
      merged: false,
      mergeCommitSha: null,
      mergedAt: null,
      mergedByKind: "unknown",
      observedAt: "2026-09-28T02:01:00.000Z",
    },
  });
  await retireBinding(binding.id);
  await endRun(run.id);
});

test("a binding is superseded only by a replacement that is current and still counted", async () => {
  const { run, binding: first, prNumber } = await publishedRun();
  const supersede = (id: string) =>
    prisma.engineeringAgentBinding.update({
      where: { id },
      data: { supersededAt: new Date("2000-01-01T00:00:00.000Z") },
    });
  await refused(supersede(first.id), "an open pull request does not drop out of the count");

  // A replacement already pruned by commit does not count, so it does not replace.
  const pruned = bindingFor(run.id, prNumber);
  await refused(
    prisma.$transaction([
      supersede(first.id),
      prisma.engineeringAgentBinding.create({ data: pruned }),
      prisma.engineeringAgentBinding.update({ where: { id: pruned.id }, data: { state: "closed" } }),
      prisma.engineeringAgentBinding.update({ where: { id: pruned.id }, data: { state: "pruned" } }),
    ]),
    "the replacement is open or closed, not pruned",
  );

  const [superseded, replacement] = await prisma.$transaction([
    supersede(first.id),
    prisma.engineeringAgentBinding.create({ data: bindingFor(run.id, prNumber) }),
  ]);
  assert.ok(superseded.supersededAt && superseded.supersededAt.getFullYear() > 2000, "the database wrote the time");
  assert.equal(superseded.currentPrNumber, null);
  assert.equal(replacement.currentPrNumber, prNumber);
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: first.id }, data: { supersededAt: new Date() } }),
    "superseding is written once",
  );
  await refused(
    prisma.engineeringAgentBinding.update({ where: { id: first.id }, data: { currentPrNumber: prNumber } }),
    "the current slot is the database's",
  );
  await retireBinding(first.id);
  await retireBinding(replacement.id);
  await endRun(run.id);
});

test("an unknown write outcome opens its own decision item, which the owner queue counts", async () => {
  const item = await newItem("prune");
  await claim(item.id, 1, "write");
  await refused(setState(item.id, "outcome_unknown"), "an unknown outcome is not left without a person");
  const decisionFor = (causeKey: string) =>
    prisma.engineeringAgentWorkItem.create({
      data: { id: randomUUID(), kind: "decision", state: "open", causeKey },
    });
  await refused(
    prisma.$transaction([setState(item.id, "outcome_unknown"), decisionFor(`unknown:${item.id}:7`)]),
    "the decision item names this claim, not another",
  );
  const [, decision] = await prisma.$transaction([
    setState(item.id, "outcome_unknown"),
    decisionFor(`unknown:${item.id}:1`),
  ]);
  await setState(decision.id, "acknowledged");
});

test("a partial registration is an owner decision, resolved only after a person has seen it", async () => {
  const registration = await prisma.engineeringAgentRegistration.create({
    data: {
      id: randomUUID(),
      source: "S2",
      pinnedCommit: sha1("backlog"),
      itemKey: `ITEM-${randomUUID().slice(0, 8)}`,
      itemDigest: sha256(randomUUID()),
      proposalDigest: sha256("proposal"),
      guardResult: "register",
      roundId: `round-${randomUUID().slice(0, 12)}`,
    },
  });
  const toResult = (result: string) =>
    prisma.engineeringAgentRegistration.update({ where: { id: registration.id }, data: { result } });
  await refused(
    prisma.engineeringAgentRegistration.update({
      where: { id: registration.id },
      data: { result: "partial", roundId: `round-${randomUUID().slice(0, 12)}` },
    }),
    "a registration keeps its round",
  );
  await refused(toResult("partial"), "a partial registration is not left without a decision item");
  const [partial, decision] = await prisma.$transaction([
    toResult("partial"),
    prisma.engineeringAgentWorkItem.create({
      data: { id: randomUUID(), kind: "decision", state: "open", causeKey: `registration:${registration.id}` },
    }),
  ]);
  await refused(toResult("absent"), "not resolved while its decision is open");
  await setState(decision.id, "acknowledged");
  const resolved = await toResult("absent");
  assert.ok(resolved.resolvedAt, "the resolution is recorded");
  assert.equal(resolved.decidedAt?.getTime(), partial.decidedAt?.getTime(), "beside the first answer, not over it");
  await refused(toResult("partial"), "a resolved registration stays resolved");
});

test("a temporary table of the same name does not stand in for the real one", async () => {
  const open = [await newItem("decision"), await newItem("decision"), await newItem("decision")];
  const { task, attempt } = await amuxAttempt();
  await refused(
    prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        'CREATE TEMP TABLE "EngineeringAgentWorkItem" ("kind" TEXT, "state" TEXT) ON COMMIT DROP',
      );
      await tx.engineeringAgentRun.create({
        data: {
          id: nextRunId(),
          amuxAttemptId: attempt.id,
          cardId: task.id,
          cardKind: "code",
          baseSha: sha1("base"),
          leaseExpiresAt: inSeconds(60),
        },
      });
    }),
    "the queue is counted from the real table",
  );
  for (const item of open) await setState(item.id, "expired");
});

test("a registration result is written once, and the round cap is the database's", async () => {
  const roundId = `round-${randomUUID().slice(0, 12)}`;
  const propose = () =>
    prisma.engineeringAgentRegistration.create({
      data: {
        id: randomUUID(),
        source: "S1",
        pinnedCommit: sha1("backlog"),
        itemKey: `ITEM-${randomUUID().slice(0, 8)}`,
        itemDigest: sha256(randomUUID()),
        proposalDigest: sha256("proposal"),
        guardResult: "register",
        roundId,
      },
    });
  const first = await propose();
  await refused(
    prisma.engineeringAgentRegistration.update({ where: { id: first.id }, data: { result: "registered" } }),
    "a registered result names its card",
  );
  await prisma.engineeringAgentRegistration.update({ where: { id: first.id }, data: { result: "registration_refused" } });
  await refused(
    prisma.engineeringAgentRegistration.update({ where: { id: first.id }, data: { result: "partial" } }),
    "a result is written once",
  );
  // A refused proposal does not count; three that may have made cards fill the round.
  await propose();
  await propose();
  await propose();
  await refused(propose(), "the fourth registration of a round");
});

test("a request's end is kept, so a retry never starts over", async () => {
  const key = randomUUID().replace(/-/g, "");
  await prisma.engineeringAgentRequest.create({ data: { key, route: "run/start", requestDigest: sha256("request") } });
  await refused(
    prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "committed" } }),
    "a request commits only from in_progress",
  );
  await prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "in_progress" } });
  await refused(
    prisma.engineeringAgentRequest.update({ where: { key }, data: { resultRef: "123456789012" } }),
    "a result is recorded only with the commit",
  );
  await refused(
    prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "committed", resultRef: "not an id" } }),
    "a result is a run id or a work item id",
  );
  await prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "committed", resultRef: "123456789012" } });
  await refused(
    prisma.engineeringAgentRequest.update({ where: { key }, data: { resultRef: "123456789013" } }),
    "a recorded result never changes",
  );
  await refused(
    prisma.engineeringAgentRequest.update({ where: { key }, data: { state: "aborted" } }),
    "a committed request stays committed",
  );
  await refused(prisma.engineeringAgentRequest.delete({ where: { key } }), "a request is never deleted");
});

test("no run starts while the owner queue is full, counting what running work may still produce", async () => {
  // Three open owner items fill the decision queue: two here, and a draft,
  // which is the product of its own run.
  const open = [await newItem("decision"), await newItem("state_mismatch"), await newProduct("t2_draft")];
  await refused(newRun(), "a full decision queue refuses a new run");
  for (const item of open) await setState(item.id, item.kind === "state_mismatch" ? "resolved" : "expired");

  // Inside the first T1 window the pull request queue holds one: an active
  // run may still produce a pull request, and so may an unsettled publish item.
  const running = await newRun();
  await refused(newRun(), "an active run holds the one place");
  await endRun(running.id);
  const pending = await newProduct("publish");
  await refused(newRun(), "an unsettled publish item holds the one place");
  await retirePublish(pending.id);
  await endRun((await newRun()).id);
});

test("inside the first T1 window one open pull request fills the queue", async () => {
  const { run, binding } = await publishedRun();
  assert.equal(run.modeAtStart, "t1");
  await endRun(run.id);
  await refused(newRun(), "one open pull request fills the first T1 window");
  await retireBinding(binding.id);
  await endRun((await newRun()).id);
});
