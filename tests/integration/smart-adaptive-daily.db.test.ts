import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { prisma } from "@/lib/prisma";
import { observeSmartAdaptiveDaily, readSmartAdaptiveDaily } from "@/lib/dailyProductAgentSmartAdaptive";
import { actionableRecommendations, recommendationFindings } from "@/lib/autoRouterRecommendationsCore";
import { setRecommendationStatus } from "@/lib/autoRouterRecommendations";

test("daily observations preserve previous work and produce each scoped recommendation once", async () => {
  assert.equal(process.env.NODE_ENV, "test");
  assert.ok(process.env.TEST_DATABASE_URL);
  assert.equal(process.env.DATABASE_URL, process.env.TEST_DATABASE_URL);
  const prefix = "auto.smartAdaptiveDaily.";
  const tag = randomUUID();
  // Keep fixed windows independent of previously recorded telemetry in this test database.
  const day = (n: number) => new Date(Date.UTC(2040, 4, n, 23));
  const cycle = (n: number, summary: object, status = "passed") => prisma.autoRouterOptimizerCycle.create({
    data: { target: "routing", createdAt: day(n), status, optimizerModelId: tag, routerModelId: "test",
      incumbentGuidance: "", reservedMicroUsd: 0, summary },
  });
  const sample = (n: number, count: number, timings: { provider: number; first: number; done: number }) =>
    prisma.responseLatencySample.createMany({ data: Array.from({length: count}, (_, i) => {
      const base = { product: "chat", mode: "auto", outcome: "completed", createdAt: new Date(day(n).getTime() - 500) };
      const key = tag + "-" + n + "-" + i;
      return [
        { ...base, id: key + ":server", source: "server", timings: { presearchMs: 700, providerToContentMs: timings.provider } },
        { ...base, id: key + ":client", source: "client", timings: { firstContentMs: timings.first, completionMs: timings.done } },
      ];
    }).flat() });
  const summaryOf = async (id: string) => (await prisma.autoRouterOptimizerCycle.findUniqueOrThrow({where:{id}})).summary;
  const key = { startsWith: prefix };
  await prisma.appSetting.deleteMany({ where: { key } });
  try {
    const report = { findings: ["original finding"], recommendations: [{kind:"setting",text:"existing item"}] };
    const original = await cycle(1, { report, recommendationStatus: { "0": { status: "dismissed", at: day(1).toISOString(), by: "test" } } });
    const running = await cycle(2, {}, "running");
    const oldAudit = await prisma.adminAuditLog.count({where: { action: "daily_product_agent.smart_adaptive_observed" }});
    await Promise.all([observeSmartAdaptiveDaily(day(3)), observeSmartAdaptiveDaily(day(3))]);
    const saved = await summaryOf(original.id);
    assert.equal(actionableRecommendations(saved).length, 2);
    assert.equal(actionableRecommendations(saved)[0].status, "dismissed");
    assert.deepEqual(recommendationFindings(saved, 0), ["original finding"]);
    assert.match(recommendationFindings(saved, 1)[0], /QA.*807891839.*80a95b53e/);
    assert.deepEqual(await summaryOf(running.id), {});
    assert.equal(await prisma.adminAuditLog.count({where:{action:"daily_product_agent.smart_adaptive_observed"}}), oldAudit + 1);
    const operator = {
      session: { user: { id: tag, email: "qa@example.test" }, expires: day(31).toISOString() },
      request: new Request("https://tomverse.test/api/admin/auto-llm-router/optimizer"),
    };
    assert.deepEqual(await setRecommendationStatus(operator, {cycleId: original.id, index: 1, status: "dismissed"}), {ok:true, changed:true});

    const later = await cycle(4, { report: { findings: [], recommendations: [] } });
    await sample(4, 1, {provider: 3_000, first: 5_000, done: 12_000});
    await observeSmartAdaptiveDaily(day(4));
    const thin = await summaryOf(later.id);
    assert.equal(actionableRecommendations(thin).length, 1);
    assert.match(recommendationFindings(thin, 0)[0], /표본 1건.*QA/);
    // A later cycle must not revive a human dismissal or reclassify a single slow sample.
    const more = await cycle(5, { report: { findings: [], recommendations: [] } });
    await sample(5, 1, {provider: 4_000, first: 5_000, done: 12_500});
    await observeSmartAdaptiveDaily(day(5));
    assert.equal(actionableRecommendations(await summaryOf(more.id)).length, 0);
    const snapshot = await readSmartAdaptiveDaily();
    assert.equal(snapshot?.outcome, "already_listed");
    assert.equal((snapshot?.previousDay as { completionP95Ms: number }).completionP95Ms, 12_000);

    await sample(6, 30, {provider: 11_000, first: 12_000, done: 13_000});
    await observeSmartAdaptiveDaily(day(6));
    await sample(7, 30, {provider: 1_000, first: 3_000, done: 18_000});
    await observeSmartAdaptiveDaily(day(7));
    const shifted = await summaryOf(more.id);
    assert.deepEqual(actionableRecommendations(shifted).map(r => r.index), [0,1]);
    assert.match(recommendationFindings(shifted, 0)[0], /답변 모델 호출부터 첫 본문.*11000ms/);
    assert.match(recommendationFindings(shifted, 1)[0], /첫 본문부터 완료.*15000ms/);
    assert.equal(actionableRecommendations(await summaryOf(original.id)).length, 2);
    assert.equal(actionableRecommendations(await summaryOf(original.id))[1].status, "dismissed");
    await observeSmartAdaptiveDaily(day(3));
    assert.equal((await readSmartAdaptiveDaily())?.day, "2040-05-08");
  } finally {
    await prisma.responseLatencySample.deleteMany({where: {id:{startsWith:tag}}});
    await prisma.autoRouterOptimizerCycle.deleteMany({where:{optimizerModelId:tag}});
    await prisma.appSetting.deleteMany({where:{key}});
    await prisma.$disconnect();
  }
});
