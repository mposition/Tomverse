import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import { setRecommendationStatus } from "@/lib/autoRouterRecommendations";
import { actionableRecommendations } from "@/lib/autoRouterRecommendationsCore";

// An operator's status for a cycle's code and setting recommendations, on a
// real database: the status lands in the cycle's summary JSON with its audit
// entry in one transaction, and two operators marking different
// recommendations of one cycle never lose each other's change.

// The audit writer signs with the environment's key, as every other suite in
// this database does: a suite-only key would leave rows that a later
// whole-chain check (verifyAdminAuditIntegrity) cannot verify.

const session = {
  user: { id: `recommendation-${randomUUID()}`, email: "recommendation@example.test" },
  expires: new Date(Date.now() + 60 * 60 * 1_000).toISOString(),
} as Session;
const actor = { session, request: new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer") };

const REPORT = {
  findings: ["answer calls failed for two models"],
  recommendations: [
    { kind: "guidance", text: "Send translation to the light model." },
    { kind: "code", text: "Trace the failing answer calls and retry on a same-credit model." },
    { kind: "setting", text: "Exclude the repeatedly failing model for a day." },
  ],
};
const ACTION = "auto.llm_router_recommendation.status_changed";

const reset = async () => {
  await prisma.autoRouterOptimizerCycle.deleteMany({});
};
beforeEach(reset);
after(async () => {
  await reset();
  await prisma.$disconnect();
});

const seed = (data: { status?: string; summary?: object | null } = {}) =>
  prisma.autoRouterOptimizerCycle.create({
    data: {
      optimizerModelId: "optimizer-model",
      routerModelId: "router-model",
      incumbentGuidance: "guidance",
      reservedMicroUsd: 0,
      status: data.status ?? "passed",
      summary: data.summary === null ? undefined : (data.summary ?? { evaluated: 12, report: REPORT }),
    },
  });

const summaryOf = async (id: string) =>
  (await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({ where: { id } })).summary as Record<string, unknown>;

const auditRows = (cycleId: string) =>
  prisma.adminAuditLog.findMany({ where: { targetId: cycleId, action: ACTION }, orderBy: { createdAt: "asc" } });

test("a status is stored in the summary with its audit entry, and the rest of the summary is untouched", async () => {
  const cycle = await seed();
  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: cycle.id, index: 1, status: "done" }), {
    ok: true,
    changed: true,
  });

  const summary = await summaryOf(cycle.id);
  assert.equal(summary.evaluated, 12);
  assert.deepEqual(summary.report, REPORT);
  const stored = (summary.recommendationStatus as Record<string, { status: string; by: string; at: string }>)["1"];
  assert.equal(stored.status, "done");
  assert.equal(stored.by, session.user.id);
  assert.ok(Number.isFinite(Date.parse(stored.at)));
  assert.deepEqual(
    actionableRecommendations(summary).map((item) => [item.index, item.status]),
    [
      [1, "done"],
      [2, "open"],
    ]
  );

  const audit = await auditRows(cycle.id);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].actorUserId, session.user.id);
  assert.equal(audit[0].targetType, "AutoRouterOptimizerCycle");
  assert.ok(audit[0].entryHash, "the entry is chained");
  assert.deepEqual(audit[0].metadata, { index: 1, kind: "code", before: "open", after: "done" });
  // The recommendation's own text stays out of the audit chain.
  assert.ok(!JSON.stringify(audit[0]).includes(REPORT.recommendations[1].text));
});

test("the same status again changes nothing and leaves no second audit entry; reopening is audited", async () => {
  const cycle = await seed();
  await setRecommendationStatus(actor, { cycleId: cycle.id, index: 2, status: "dismissed" });
  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: cycle.id, index: 2, status: "dismissed" }), {
    ok: true,
    changed: false,
  });
  assert.equal((await auditRows(cycle.id)).length, 1);

  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: cycle.id, index: 2, status: "open" }), {
    ok: true,
    changed: true,
  });
  const audit = await auditRows(cycle.id);
  assert.equal(audit.length, 2);
  assert.deepEqual(audit[1].metadata, { index: 2, kind: "setting", before: "dismissed", after: "open" });
  assert.equal(actionableRecommendations(await summaryOf(cycle.id))[1].status, "open");
});

test("a guidance recommendation, an unknown index, a missing cycle and an unfinished cycle are refused without a write", async () => {
  const cycle = await seed();
  const running = await seed({ status: "running", summary: null });
  const noReport = await seed({ summary: { evaluated: 3 } });

  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: cycle.id, index: 0, status: "done" }), {
    refused: "no_such_recommendation",
  });
  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: cycle.id, index: 7, status: "done" }), {
    refused: "no_such_recommendation",
  });
  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: noReport.id, index: 1, status: "done" }), {
    refused: "no_such_recommendation",
  });
  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: "missing", index: 1, status: "done" }), {
    refused: "not_found",
  });
  assert.deepEqual(await setRecommendationStatus(actor, { cycleId: running.id, index: 1, status: "done" }), {
    refused: "not_found",
  });

  assert.equal((await summaryOf(cycle.id)).recommendationStatus, undefined);
  assert.equal(
    await prisma.adminAuditLog.count({
      where: { action: ACTION, targetId: { in: [cycle.id, running.id, noReport.id, "missing"] } },
    }),
    0
  );
});

test("two operators marking different recommendations of one cycle at once keep both", async () => {
  for (let round = 0; round < 5; round += 1) {
    await reset();
    const cycle = await seed();
    const [first, second] = await Promise.all([
      setRecommendationStatus(actor, { cycleId: cycle.id, index: 1, status: "done" }),
      setRecommendationStatus(actor, { cycleId: cycle.id, index: 2, status: "dismissed" }),
    ]);
    assert.deepEqual([first, second], [{ ok: true, changed: true }, { ok: true, changed: true }]);
    assert.deepEqual(
      actionableRecommendations(await summaryOf(cycle.id)).map((item) => [item.index, item.status]),
      [
        [1, "done"],
        [2, "dismissed"],
      ]
    );
    assert.equal((await auditRows(cycle.id)).length, 2);
  }
});
