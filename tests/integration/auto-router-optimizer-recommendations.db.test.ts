import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, beforeEach, test } from "node:test";
import type { Session } from "next-auth";

import { prisma } from "@/lib/prisma";
import {
  markRecommendationSentToAmux,
  readRecommendationForSend,
  reserveRecommendationForAmux,
  setRecommendationStatus,
} from "@/lib/autoRouterRecommendations";
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

// The coding agent's claim and result (lib/autoRouterRecAgent.ts), on a real
// database: off by default, one claim per open code recommendation with the
// agent's own audit entry, and a result only over a claim.
const AGENT_SWITCH = "auto.llmRouterRecAgent";

test("the coding agent claims nothing while its switch is off", async () => {
  const { claimNextRecommendation } = await import("@/lib/autoRouterRecAgent");
  await prisma.appSetting.deleteMany({ where: { key: AGENT_SWITCH } });
  await seed();
  assert.equal(await claimNextRecommendation({ origin: "https://tomverse.test" }), null);
});

test("the coding agent claims the open code recommendation once, then reports a PR over its claim", async () => {
  const { claimNextRecommendation, recordRecommendationResult } = await import("@/lib/autoRouterRecAgent");
  await prisma.appSetting.upsert({
    where: { key: AGENT_SWITCH },
    create: { key: AGENT_SWITCH, value: JSON.stringify({ enabled: true }) },
    update: { value: JSON.stringify({ enabled: true }) },
  });
  try {
    const cycle = await seed();
    const claimed = await claimNextRecommendation({ origin: "https://tomverse.test" });
    assert.ok(claimed);
    assert.equal(claimed.cycleId, cycle.id);
    assert.equal(claimed.index, 1);
    assert.equal(claimed.id, `${cycle.id}:1`);
    assert.match(claimed.instruction, /retry on a same-credit model/);
    assert.match(claimed.instruction, new RegExp(`https://tomverse.test/admin/routing#optimizer-cycle-${cycle.id}`));
    // Only one code recommendation: the second claim finds nothing.
    assert.equal(await claimNextRecommendation({ origin: "https://tomverse.test" }), null);

    const claimAudit = await prisma.adminAuditLog.findMany({
      where: { targetId: cycle.id, action: "auto.llm_router_recommendation.claimed" },
    });
    assert.equal(claimAudit.length, 1);
    assert.equal((claimAudit[0].metadata as Record<string, unknown>).index, 1);

    const prUrl = "https://github.com/mposition/Tomverse/pull/9999";
    const result = { claimId: claimed.claimId, outcome: "pr_opened" as const, prUrl };
    // A result naming another claim is refused and changes nothing.
    assert.deepEqual(
      await recordRecommendationResult({
        cycleId: cycle.id,
        index: 1,
        result: { ...result, claimId: "00000000-0000-4000-8000-000000000000" },
      }),
      { refused: "not_claimed" }
    );
    assert.deepEqual(await recordRecommendationResult({ cycleId: cycle.id, index: 1, result }), {
      ok: true,
      changed: true,
    });
    // The same result again changes nothing and adds no audit entry.
    assert.deepEqual(await recordRecommendationResult({ cycleId: cycle.id, index: 1, result }), {
      ok: true,
      changed: false,
    });
    assert.equal(
      (await prisma.adminAuditLog.findMany({
        where: { targetId: cycle.id, action: "auto.llm_router_recommendation.result_recorded" },
      })).length,
      1
    );
    const item = actionableRecommendations(await summaryOf(cycle.id)).find((entry) => entry.index === 1);
    assert.equal(item?.status, "pr_opened");
    assert.equal(item?.prUrl, prUrl);
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: AGENT_SWITCH } });
  }
});

test("a result for a recommendation an operator reopened is refused and changes nothing", async () => {
  const { recordRecommendationResult } = await import("@/lib/autoRouterRecAgent");
  const cycle = await seed();
  assert.deepEqual(
    await recordRecommendationResult({
      cycleId: cycle.id,
      index: 1,
      result: { claimId: "00000000-0000-4000-8000-000000000000", outcome: "failed", reason: "tests" },
    }),
    { refused: "not_claimed" }
  );
  // A setting recommendation is never the agent's.
  assert.deepEqual(
    await recordRecommendationResult({
      cycleId: cycle.id,
      index: 2,
      result: { claimId: "00000000-0000-4000-8000-000000000000", outcome: "failed", reason: "tests" },
    }),
    { refused: "not_found" }
  );
  assert.equal((await summaryOf(cycle.id)).recommendationStatus, undefined);
});

test("a recommendation sent to AMUX records its idea with an audit entry, once, and only while sendable", async () => {
  const cycle = await seed();
  const sentRows = () =>
    prisma.adminAuditLog.findMany({ where: { targetId: cycle.id, action: "auto.llm_router_recommendation.sent_to_amux" } });

  const found = await readRecommendationForSend({ cycleId: cycle.id, index: 1 });
  assert.equal(found?.recommendation.status, "open");
  assert.deepEqual(found?.findings, REPORT.findings);

  assert.equal(await markRecommendationSentToAmux(actor, { cycleId: cycle.id, index: 1, ideaId: "idea-1" }), true);
  const item = actionableRecommendations(await summaryOf(cycle.id)).find((entry) => entry.index === 1);
  assert.equal(item?.status, "sent_to_amux");
  assert.equal(item?.amuxIdeaId, "idea-1");
  assert.equal((await sentRows()).length, 1);

  // A second send, or one that finds another status, changes nothing.
  assert.equal(await reserveRecommendationForAmux(actor, { cycleId: cycle.id, index: 1 }), false);
  assert.equal(await markRecommendationSentToAmux(actor, { cycleId: cycle.id, index: 1, ideaId: "idea-2" }), false);
  await setRecommendationStatus(actor, { cycleId: cycle.id, index: 2, status: "dismissed" });
  assert.equal(await markRecommendationSentToAmux(actor, { cycleId: cycle.id, index: 2, ideaId: "idea-3" }), false);
  assert.equal((await sentRows()).length, 1);

  // A guidance recommendation, an unknown cycle and a running cycle have nothing to send.
  assert.equal(await readRecommendationForSend({ cycleId: cycle.id, index: 0 }), null);
  assert.equal(await readRecommendationForSend({ cycleId: "missing", index: 1 }), null);
  const running = await seed({ status: "running" });
  assert.equal(await readRecommendationForSend({ cycleId: running.id, index: 1 }), null);
});

test("a send reserves the recommendation before AMUX: once, retryable, and a person can reopen it", async () => {
  const cycle = await seed();
  const startedRows = () =>
    prisma.adminAuditLog.findMany({ where: { targetId: cycle.id, action: "auto.llm_router_recommendation.send_started" } });
  const status = async () => actionableRecommendations(await summaryOf(cycle.id)).find((entry) => entry.index === 1)?.status;

  assert.equal(await reserveRecommendationForAmux(actor, { cycleId: cycle.id, index: 1 }), true);
  assert.equal(await status(), "sending_to_amux");
  // A retry of a send that stopped midway holds it too, with no second audit entry.
  assert.equal(await reserveRecommendationForAmux(actor, { cycleId: cycle.id, index: 1 }), true);
  assert.equal((await startedRows()).length, 1);

  await setRecommendationStatus(actor, { cycleId: cycle.id, index: 1, status: "open" });
  assert.equal(await status(), "open");

  assert.equal(await reserveRecommendationForAmux(actor, { cycleId: cycle.id, index: 1 }), true);
  assert.equal(await markRecommendationSentToAmux(actor, { cycleId: cycle.id, index: 1, ideaId: "idea-1" }), true);
  assert.equal(await status(), "sent_to_amux");
});

test("a send and the coding agent's claim never both hold a recommendation", async () => {
  const { claimNextRecommendation } = await import("@/lib/autoRouterRecAgent");
  await prisma.appSetting.upsert({
    where: { key: AGENT_SWITCH },
    create: { key: AGENT_SWITCH, value: JSON.stringify({ enabled: true }) },
    update: { value: JSON.stringify({ enabled: true }) },
  });
  try {
    // Reserved first: the agent finds nothing to claim.
    const reserved = await seed();
    assert.equal(await reserveRecommendationForAmux(actor, { cycleId: reserved.id, index: 1 }), true);
    assert.equal(await claimNextRecommendation({ origin: "https://tomverse.test" }), null);
    await reset();

    // Claimed first: the send is refused.
    const claimed = await seed();
    assert.ok(await claimNextRecommendation({ origin: "https://tomverse.test" }));
    assert.equal(await reserveRecommendationForAmux(actor, { cycleId: claimed.id, index: 1 }), false);
    await reset();

    // At once, repeatedly: exactly one of the two gets it, whichever runs first.
    for (let round = 0; round < 8; round += 1) {
      const raced = await seed();
      const [held, claim] = await Promise.all([
        reserveRecommendationForAmux(actor, { cycleId: raced.id, index: 1 }),
        claimNextRecommendation({ origin: "https://tomverse.test" }),
      ]);
      assert.equal(Number(held) + Number(Boolean(claim)), 1, `round ${round}`);
      await reset();
    }
  } finally {
    await prisma.appSetting.deleteMany({ where: { key: AGENT_SWITCH } });
  }
});
