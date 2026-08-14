import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import { closeAttempt } from "@/lib/routingAttemptStore";
import {
  STALE_ATTEMPT_AFTER_MS,
  staleAttemptBacklog,
  sweepStaleRoutingAttempts,
} from "@/lib/routingAttemptSweep";

/**
 * A dispatch is recorded before the provider's stream is read and the outcome
 * after it. Between those two the process can die, and the attempt stays
 * `pending` for ever — polluting the reliability numbers and ROUTE-06's
 * evidence long after the incident.
 *
 * These are about what the sweep may conclude (very little), what it must not
 * touch, and the compare-and-set that stops it racing the live request.
 */

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ContextManifest",
      "RoutingAttempt",
      "RoutingRun",
      "ChatCreditReservation",
      "ChatRequestLease",
      "ChatUsageBucket",
      "User"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const ancient = () => new Date(Date.now() - STALE_ATTEMPT_AFTER_MS - 60_000);

const makeRun = async (overrides: { subjectKey?: string } = {}) => {
  const subjectKey = overrides.subjectKey ?? `sweep:${randomUUID()}`;
  const run = await prisma.routingRun.create({
    data: {
      traceId: `trace-${randomUUID()}`,
      subjectKey,
      mode: "auto",
      plan: "Pro",
      initialModelId: "gpt-5-6-luna",
      taskProfileVersion: "sweep-test",
      candidateFilterVersion: "sweep-test",
      selectionVersion: "sweep-test",
      estimatorVersion: "sweep-test",
      profileKind: "general",
      profileConfidence: "high",
      needsCurrentInformation: false,
      hasImageInput: false,
      hasDocumentInput: false,
      expectedOutputLength: "short",
      estimatedInputTokens: 100,
      reservedInputTokens: 100,
      requestOutputCapTokens: 100,
      eligibleCount: 1,
      rejectedByReason: {},
      selectionReason: "task_preference",
      selectionMargin: 0,
      userSelectedModelId: "gpt-5-6-luna",
      decisionMicros: 1_000,
    },
    select: { id: true },
  });
  return { runId: run.id, subjectKey };
};

const makeAttempt = async (
  runId: string,
  overrides: {
    outcome?: string;
    dispatchedAt?: Date | null;
    createdAt?: Date;
  } = {}
) => {
  const dispatchedAt =
    overrides.dispatchedAt === undefined ? ancient() : overrides.dispatchedAt;
  // Created undispatched, then marked dispatched once its manifest is
  // finalized: ROUTE-06's constraint refuses a dispatch that has no finalized
  // manifest, which is the boundary the whole feature rests on.
  const attempt = await prisma.routingAttempt.create({
    data: {
      runId,
      attemptIndex: 0,
      modelId: "gpt-5-6-luna",
      provider: "openai",
      outcome: overrides.outcome ?? "pending",
      failureLayer: "none",
    },
    select: { id: true },
  });
  if (dispatchedAt) {
    await prisma.contextManifest.create({
      data: {
        attemptId: attempt.id,
        state: "finalized",
        sourceRefs: [],
        tokenizerVersion: "sweep-test",
        tokenCount: 100,
        contextWindowTokens: 1_000,
        // A finalized manifest must be able to say what it committed to; the
        // constraint refuses one that only claims to be finalized.
        plannerVersion: "none",
        adapterVersion: "sweep-test",
        effectiveRequestHash: "sweep-test-hash",
        contentHashVersion: "sweep-test",
        hashAlgorithm: "hmac-sha256",
        hashKeyId: "test-key",
        finalizedAt: dispatchedAt,
      },
    });
    await prisma.routingAttempt.update({
      where: { id: attempt.id },
      // The attempt carries its own copy of the finalization time, and the
      // constraint requires it to be at or before the dispatch: a manifest
      // finalized afterwards would describe a request that had already gone.
      data: { manifestFinalizedAt: dispatchedAt, dispatchedAt },
    });
  }
  if (overrides.createdAt !== undefined) {
    await prisma.$executeRaw`
      UPDATE "RoutingAttempt" SET "createdAt" = ${overrides.createdAt} WHERE "id" = ${attempt.id}
    `;
  }
  return attempt.id;
};

const outcomeOf = async (id: string) =>
  (await prisma.routingAttempt.findUniqueOrThrow({ where: { id } })).outcome;

test("a dispatched attempt whose process stopped is closed, honestly", async () => {
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });

  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.closed, 1);

  const row = await prisma.routingAttempt.findUniqueOrThrow({ where: { id } });
  // Not `failed_pre_token`: nobody observed the provider call, so a failure
  // would be a claim about an outcome nothing saw.
  assert.equal(row.outcome, "unknown_after_dispatch");
  // Not `provider`: §8's recovery reads provider health to decide what to
  // route to next, and a host restart is not evidence about a model.
  assert.equal(row.failureLayer, "process");
  // The record of what reached a provider is still true and is left alone.
  assert.ok(row.dispatchedAt);
});

test("an attempt that never dispatched is left alone", async () => {
  // There is no uncertainty to record: it did not reach a provider, and
  // `not_dispatched` is what says so.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, {
    dispatchedAt: null,
    createdAt: ancient(),
  });
  const result = await sweepStaleRoutingAttempts();
  assert.equal(result.examined, 0);
  assert.equal(await outcomeOf(id), "pending");
});

test("a young attempt is left alone", async () => {
  // A turn can legitimately stream for minutes, and closing a live attempt is
  // worse than closing a dead one late.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: new Date() });
  assert.equal((await sweepStaleRoutingAttempts()).examined, 0);
  assert.equal(await outcomeOf(id), "pending");
});

test("an attempt whose subject still holds a lease is left alone", async () => {
  const { runId, subjectKey } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });
  await prisma.chatRequestLease.create({
    data: {
      id: `lease-${randomUUID()}`,
      subjectKey,
      ipKey: `ip-${randomUUID()}`,
      expiresAt: new Date(Date.now() + 60_000),
    },
  });
  assert.equal((await sweepStaleRoutingAttempts()).examined, 0);
  assert.equal(await outcomeOf(id), "pending");
});

test("a terminal outcome cannot be changed, by the sweep or anyone", async () => {
  // The field §5's outcomes, §8's recovery and the drill's scenarios are all
  // told apart by.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, {
    outcome: "succeeded",
    createdAt: ancient(),
  });
  await assert.rejects(
    prisma.routingAttempt.update({
      where: { id },
      data: { outcome: "failed_pre_token" },
    }),
    /terminal outcome cannot be changed/
  );
  assert.equal(await outcomeOf(id), "succeeded");
});

test("closing an already-closed attempt reports that it lost, and changes nothing", async () => {
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });

  assert.equal(await closeAttempt({ attemptId: id, outcome: "succeeded" }), true);
  assert.equal(
    await closeAttempt({ attemptId: id, outcome: "failed_pre_token" }),
    false,
    "the second close must report that it did not write"
  );
  assert.equal(await outcomeOf(id), "succeeded");
});

test("the live request and the sweep cannot both close one attempt", async () => {
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { createdAt: ancient() });

  const [live, swept] = await Promise.all([
    closeAttempt({ attemptId: id, outcome: "succeeded" }),
    sweepStaleRoutingAttempts(),
  ]);
  const wonBySweep = swept.closed === 1;
  assert.equal(
    [live, wonBySweep].filter(Boolean).length,
    1,
    "exactly one of the live close and the sweep may win"
  );
  assert.ok(["succeeded", "unknown_after_dispatch"].includes(await outcomeOf(id)));
});

test("the backlog reports how far behind the sweep is, not only that it is", async () => {
  // A backlog of zero on a sweep that never runs looks identical to a backlog
  // of zero on one that keeps up; the age is what tells them apart.
  const { runId } = await makeRun();
  await makeAttempt(runId, { createdAt: ancient() });

  const before = await staleAttemptBacklog();
  assert.equal(before.backlog, 1);
  assert.ok((before.oldestPendingMs ?? 0) >= STALE_ATTEMPT_AFTER_MS);

  await sweepStaleRoutingAttempts();
  const after = await staleAttemptBacklog();
  assert.deepEqual(after, { backlog: 0, oldestPendingMs: null });
});

test("an unknown_after_dispatch outcome requires a dispatch", async () => {
  // Enforced by the database, so no future writer can record the uncertainty
  // about a call that never happened.
  const { runId } = await makeRun();
  const id = await makeAttempt(runId, { dispatchedAt: null });
  await assert.rejects(
    prisma.routingAttempt.update({
      where: { id },
      data: { outcome: "unknown_after_dispatch", failureLayer: "process" },
    }),
    /constraint/i
  );
});
