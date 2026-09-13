import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { prisma } from "@/lib/prisma";
import {
  listModelDiscoveryQueue,
  recordAdoptionDecision,
  recordDiscoveredWorkItems,
  summariseLifecycleChanges,
  transitionWorkItems,
  queueStatusSetUnchanged,
} from "@/lib/modelLifecycleWorkItems";

// Excluding a discovered model and reviewing it again.
//
// The panel offers two decisions -- adopt and exclude -- and an excluded family
// can be returned to the queue on purpose. Three facts need a database: that an
// exclusion writes its reason, the operator's words and the analysis in
// separate columns; that a later scan neither re-files nor reopens it; and that
// the history table itself refuses an exclusion or a reopen without its record,
// whoever the caller is.

const actorEmail = "ops@tomverse.app";
const provider = "openai";
const apiModel = "gpt-7-nova";

const reset = () =>
  prisma.$executeRawUnsafe(`
    TRUNCATE TABLE
      "ModelLifecycleWorkItemEvent", "ModelLifecycleWorkItem",
      "ProviderModelCatalogEntry", "ProviderModelCatalogRun",
      "ModelRegistryEntry"
    RESTART IDENTITY CASCADE
  `);

beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const discover = async () => {
  const result = await recordDiscoveredWorkItems({
    observed: [{ provider, apiModel }],
  });
  assert.equal(result.created, 1, "the fixture model must be queueable");
  const item = await prisma.modelLifecycleWorkItem.findFirstOrThrow({
    where: { provider, apiModel },
  });
  return item.id;
};

const exclude = (
  workItemIds: string[],
  reasonCode: "served_by_better_model" | "other",
  operatorReason: string | null = null
) =>
  transitionWorkItems({
    workItemIds,
    to: "closed_no_action",
    actorEmail,
    // Later than the creation event, so the history orders the same way on
    // every run rather than by which row a shared millisecond sorts first.
    now: new Date(Date.now() + 60_000),
    eventDecision: {
      decision: "exclude",
      reasonCode,
      operatorReason,
      analysisSnapshots: new Map(workItemIds.map((id) => [id, "automatic analysis"])),
    },
  });

test("an exclusion records the reason, the operator's words and the analysis apart", async () => {
  const id = await discover();
  const result = await exclude([id], "served_by_better_model", "Grok 4.5 covers it");
  assert.equal(result.ok, true);

  const item = await prisma.modelLifecycleWorkItem.findUniqueOrThrow({ where: { id } });
  assert.equal(item.status, "closed_no_action");
  assert.ok(item.closedAt);
  assert.equal(item.decision, "reject");
  assert.equal(item.reviewerEmail, actorEmail);

  const event = await prisma.modelLifecycleWorkItemEvent.findFirstOrThrow({
    where: { workItemId: id, toStatus: "closed_no_action" },
  });
  assert.equal(event.decision, "exclude");
  assert.equal(event.reasonCode, "served_by_better_model");
  assert.equal(event.operatorReason, "Grok 4.5 covers it");
  assert.equal(event.analysisSnapshot, "automatic analysis");
  assert.equal(event.note, null, "the analysis is never written as the note");
  assert.equal(event.actorEmail, actorEmail);
});

test("a later scan neither files the model again nor reopens it", async () => {
  const id = await discover();
  assert.equal((await exclude([id], "served_by_better_model")).ok, true);

  const rescan = await recordDiscoveredWorkItems({ observed: [{ provider, apiModel }] });
  assert.equal(rescan.created, 0);
  assert.equal(await prisma.modelLifecycleWorkItem.count(), 1);
  const item = await prisma.modelLifecycleWorkItem.findUniqueOrThrow({ where: { id } });
  assert.equal(item.status, "closed_no_action");
});

test("the excluded view lists the exclusion, and a reopen returns the item undecided", async () => {
  const id = await discover();
  assert.equal((await exclude([id], "other", "Waiting for the regional launch")).ok, true);

  const excludedView = await listModelDiscoveryQueue({ view: "excluded" });
  assert.deepEqual(
    excludedView.items.map((row) => [row.id, row.exclusion?.reasonCode, row.exclusion?.operatorReason]),
    [[id, "other", "Waiting for the regional launch"]]
  );
  assert.equal((await listModelDiscoveryQueue()).items.length, 0);

  const reopened = await transitionWorkItems({
    workItemIds: [id],
    to: "discovered",
    actorEmail,
    eventDecision: { decision: "reopen", operatorReason: "Price dropped" },
    now: new Date(Date.now() + 120_000),
  });
  assert.equal(reopened.ok, true);

  const item = await prisma.modelLifecycleWorkItem.findUniqueOrThrow({ where: { id } });
  assert.equal(item.status, "discovered");
  assert.equal(item.closedAt, null);
  assert.equal(item.decision, null);
  assert.equal(item.decisionReason, null);

  const events = await prisma.modelLifecycleWorkItemEvent.findMany({
    where: { workItemId: id },
    orderBy: { occurredAt: "asc" },
  });
  assert.deepEqual(
    events.map((event) => [event.toStatus, event.decision]),
    [
      ["discovered", null],
      ["closed_no_action", "exclude"],
      ["discovered", "reopen"],
    ]
  );
  assert.equal(events[2].operatorReason, "Price dropped");
  assert.equal((await listModelDiscoveryQueue({ view: "excluded" })).items.length, 0);
  assert.deepEqual((await listModelDiscoveryQueue()).items.map((row) => row.id), [id]);
});

test("an exclusion without the analysis it was made against writes nothing", async () => {
  const id = await discover();
  const result = await transitionWorkItems({
    workItemIds: [id],
    to: "closed_no_action",
    actorEmail,
    eventDecision: { decision: "exclude", reasonCode: "no_product_path" },
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.code, "analysis_required");
  const item = await prisma.modelLifecycleWorkItem.findUniqueOrThrow({ where: { id } });
  assert.equal(item.status, "discovered");
});

test("the excluded view shows only the latest exclusion of an item excluded twice", async () => {
  const id = await discover();
  const at = (minutes: number) => new Date(Date.now() + minutes * 60_000);
  const excludeAt = (minutes: number, reason: string) =>
    transitionWorkItems({
      workItemIds: [id],
      to: "closed_no_action",
      actorEmail,
      now: at(minutes),
      eventDecision: {
        decision: "exclude",
        reasonCode: "other",
        operatorReason: reason,
        analysisSnapshots: new Map([[id, "automatic analysis"]]),
      },
    });
  assert.equal((await excludeAt(1, "first")).ok, true);
  assert.equal(
    (
      await transitionWorkItems({
        workItemIds: [id],
        to: "discovered",
        actorEmail,
        now: at(2),
        eventDecision: { decision: "reopen", operatorReason: "look again" },
      })
    ).ok,
    true
  );
  assert.equal((await excludeAt(3, "second")).ok, true);
  const view = await listModelDiscoveryQueue({ view: "excluded" });
  assert.deepEqual(
    view.items.map((row) => row.exclusion?.operatorReason),
    ["second"]
  );
});

test("an exclusion for another reason without that reason writes nothing", async () => {
  const id = await discover();
  const result = await exclude([id], "other");
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.code, "reason_required");
  const item = await prisma.modelLifecycleWorkItem.findUniqueOrThrow({ where: { id } });
  assert.equal(item.status, "discovered");
});

test("rejected and completed stay closed; only an exclusion reopens", async () => {
  const id = await discover();
  await prisma.modelLifecycleWorkItem.update({
    where: { id },
    data: {
      status: "rejected",
      closedAt: new Date(),
      decision: "reject",
      decisionReason: "fixture",
      decidedAt: new Date(),
    },
  });
  const result = await transitionWorkItems({
    workItemIds: [id],
    to: "discovered",
    actorEmail,
    eventDecision: { decision: "reopen", operatorReason: "try" },
  });
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.refusal.code, "terminal");
});

test("the history table refuses a decision without its record", async () => {
  const id = await discover();
  const refused = async (data: Record<string, unknown>) => {
    await assert.rejects(
      prisma.modelLifecycleWorkItemEvent.create({
        data: { workItemId: id, actorEmail, ...data } as never,
      }),
      /constraint/i
    );
  };
  await refused({ fromStatus: "discovered", toStatus: "closed_no_action", decision: "exclude" });
  await refused({ fromStatus: "discovered", toStatus: "closed_no_action", reasonCode: "other", decision: "exclude" });
  await refused({ fromStatus: "discovered", toStatus: "closed_no_action", reasonCode: "no_product_path" });
  await refused({ fromStatus: "closed_no_action", toStatus: "discovered", decision: "reopen" });
  await refused({ fromStatus: "discovered", toStatus: "awaiting_decision", decision: "exclude", reasonCode: "no_product_path" });
  await refused({ fromStatus: "discovered", toStatus: "closed_no_action", decision: "exclude", reasonCode: "because" });
  await refused({ fromStatus: "discovered", toStatus: "closed_no_action", decision: "archive" });
  await refused({ fromStatus: "closed_no_action", toStatus: "discovered", decision: "reopen", operatorReason: "   " });
  await refused({ fromStatus: "closed_no_action", toStatus: "discovered", decision: "reopen", operatorReason: "x".repeat(1_001) });
  await refused({ fromStatus: "validation_pending", toStatus: "validation_pending", decision: "adopt" });
  await refused({ fromStatus: "validation_pending", toStatus: "closed_no_action", decision: "exclude", reasonCode: "no_product_path", analysisSnapshot: "text" });
  await refused({ fromStatus: "completed", toStatus: "closed_no_action", decision: "exclude", reasonCode: "no_product_path", analysisSnapshot: "text" });
  await refused({ actorEmail: null, fromStatus: "discovered", toStatus: "closed_no_action", decision: "exclude", reasonCode: "no_product_path", analysisSnapshot: "text" });
  await refused({ fromStatus: "validation_pending", toStatus: "validation_pending", decision: "adopt", operatorReason: "ship it" });
  await refused({ fromStatus: "discovered", toStatus: "closed_no_action", decision: "exclude", reasonCode: "no_product_path" });
  await refused({ fromStatus: "discovered", toStatus: "closed_no_action", decision: "exclude", reasonCode: "no_product_path", analysisSnapshot: " " });
  await refused({ fromStatus: "closed_no_action", toStatus: "discovered", decision: "reopen", operatorReason: "why", analysisSnapshot: "text" });
  await refused({ fromStatus: "awaiting_decision", toStatus: "approved", decision: "adopt", operatorReason: "ship it" });
  await refused({ fromStatus: "discovered", toStatus: "validation_pending", decision: "adopt", operatorReason: "ship it" });
  await refused({ fromStatus: "discovered", toStatus: "awaiting_decision", operatorReason: "no decision" });
  await refused({ fromStatus: "discovered", toStatus: "awaiting_decision", analysisSnapshot: "no decision" });
});

test("an adoption is its own record, in the state the walk ended in, and moves nothing", async () => {
  const id = await discover();
  await prisma.modelLifecycleWorkItem.update({
    where: { id },
    data: { status: "validation_pending" },
  });
  const since = new Date(Date.now() - 1_000);
  const refusedEarly = await prisma.$transaction((tx) =>
    recordAdoptionDecision(tx, {
      workItemId: id,
      actorEmail,
      status: "discovered",
      operatorReason: "Worth it",
      analysisSnapshot: "automatic analysis",
      note: "Adopted into the registry as fixture.",
    })
  );
  assert.equal(refusedEarly.ok, false);

  const recorded = await prisma.$transaction((tx) =>
    recordAdoptionDecision(tx, {
      workItemId: id,
      actorEmail,
      status: "validation_pending",
      operatorReason: "Worth it",
      analysisSnapshot: "automatic analysis",
      note: "Adopted into the registry as fixture.",
      now: new Date(Date.now() + 60_000),
    })
  );
  assert.equal(recorded.ok, true);
  const event = await prisma.modelLifecycleWorkItemEvent.findFirstOrThrow({
    where: { workItemId: id, decision: "adopt" },
  });
  assert.equal(event.fromStatus, "validation_pending");
  assert.equal(event.toStatus, "validation_pending");
  assert.equal(event.operatorReason, "Worth it");
  assert.equal(event.analysisSnapshot, "automatic analysis");

  const summary = await summariseLifecycleChanges(since);
  assert.equal(summary.transitions, 0, "a record that moves nothing is not a transition");
});

test("the in-transaction recheck notices an undecided item the family check did not see", async () => {
  const id = await discover();
  const seen = new Set([id]);
  const undecided = ["discovered", "awaiting_decision", "deferred"] as const;
  assert.equal(
    await prisma.$transaction((tx) => queueStatusSetUnchanged(tx, undecided, seen)),
    true
  );
  await recordDiscoveredWorkItems({ observed: [{ provider: "anthropic", apiModel: "claude-orbit-2" }] });
  assert.equal(
    await prisma.$transaction((tx) => queueStatusSetUnchanged(tx, undecided, seen)),
    false
  );
});
