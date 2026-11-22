import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { createResearchRun, extendResearchBudget, pauseResearchRun, readResearchRunDto, resumeResearchRun } from "@/lib/researchEngineService";
import { drainResearchWork, processOneResearchWorkItem } from "@/lib/researchEngineWorker";
import { claimNextResearchWorkItem, readResearchRunMoney, RESEARCH_ITEM_LEASE_MS } from "@/lib/researchEngineStore";
import { recoverResearchEngine } from "@/lib/researchEngineRecovery";
import { readResearchReport, exportResearchReport } from "@/lib/researchEngineReads";
import { createFakeModel, createFakeWeb, createUser, defaultResponse, fakeRequest, installFakes, users } from "./researchEngineHarness";

/**
 * Synthetic scale and durability fixtures. These check that the engine works
 * past every Preview bound; they are not production limits, latency or
 * throughput measurements, and they spend nothing.
 */

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

const brief = (question: string) => ({ question, deliverable: "report" as const, searchLanguages: [], regions: [],
  includeDomains: [], excludeDomains: [], constraints: [] });

const start = async (userId: string, question: string, options: { profile?: "standard" | "deep"; credits?: number; autoStart?: boolean } = {}) =>
  (await createResearchRun({ request: fakeRequest(), userId, payload: {
    userMessageId: randomUUID(), assistantMessageId: randomUUID(), brief: brief(question), sources: [],
    profile: options.profile ?? "standard", approvedCredits: options.credits ?? 5_000, autoStart: options.autoStart ?? true,
  } })).run;

test("one run passes every Preview bound: >=20 generations, >=500 candidates, >=100 reads, >=40 citations, a report past 4,096 output tokens", async () => {
  const model = createFakeModel({ delayMs: 80, respond: (call) => defaultResponse(call, { subquestions: 12, sections: 6, readsPerTurn: 10 }) });
  installFakes({ model });
  const web = createFakeWeb({ resultsPerQuery: 5, paywallEvery: 13, republishEvery: 5, linksPerPage: 3 });
  const user = await createUser("engine-scale");
  const run = await start(user.id, "Large synthetic comparison across many public sources", { profile: "deep", credits: 20_000 });
  await drainResearchWork("scale", 8, { limits: { global: 32, perAccount: 4, perRun: 4, perProvider: 16 } });
  const final = await readResearchRunDto(user.id, run.id);
  assert.equal(final.status, "completed");
  const generations = await prisma.researchPreviewGeneration.count({ where: { runId: run.id, kind: "model", status: "completed" } });
  const candidates = await prisma.researchSource.count({ where: { runId: run.id } });
  const reads = await prisma.researchSourceVersion.count({ where: { runId: run.id, readStatus: "read" } });
  const paywalled = await prisma.researchSourceVersion.count({ where: { runId: run.id, readStatus: "unavailable", failureReason: "login_or_paywall" } });
  const duplicates = await prisma.researchSource.count({ where: { runId: run.id, duplicateOfSourceId: { not: null } } });
  const report = await readResearchReport({ userId: user.id, runId: run.id });
  const writerOutput = await prisma.researchPreviewGeneration.aggregate({ where: { runId: run.id, kind: "model", workItem: { kind: { in: ["write_section", "synthesize"] } } }, _sum: { outputTokens: true } });
  console.log(JSON.stringify({ generations, candidates, reads, paywalled, duplicates, citations: report.document.bibliography.length,
    writerOutputTokens: writerOutput._sum.outputTokens, markdownChars: report.markdown.length, maxConcurrentModelCalls: model.maxActive(), searches: web.searches.length }));
  assert.ok(generations >= 20, `generations ${generations}`);
  assert.ok(candidates >= 500, `candidates ${candidates}`);
  assert.ok(reads >= 100, `reads ${reads}`);
  assert.ok(paywalled > 0, "paywalled pages are recorded as unavailable, never bypassed");
  assert.ok(duplicates > 0, "republished copies are identified");
  assert.ok(report.document.bibliography.length >= 40, `citations ${report.document.bibliography.length}`);
  assert.ok((writerOutput._sum.outputTokens ?? 0) > 4_096);
  assert.ok(report.markdown.length > 16_384);
  assert.ok(model.maxActive() >= 4, `independent items of one run ran concurrently (${model.maxActive()})`);
  const checkpoint = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id }, select: { checkpoint: true } });
  assert.equal(checkpoint.checkpoint, null, "no source text accumulates in a run checkpoint");
  const largestItem = await prisma.$queryRaw<Array<{ n: number }>>`SELECT max(octet_length("result"::text))::int AS n FROM "ResearchWorkItem" WHERE "runId" = ${run.id}`;
  assert.ok((largestItem[0]?.n ?? 0) < 131_072, "item results hold refs and spans, not page bodies");
  const money = await readResearchRunMoney(prisma, run.id);
  assert.equal(money.reservedCredits, 0);
  assert.ok(money.settledCredits <= money.approvedCredits);
  for (const format of ["pdf", "docx", "xlsx", "csv"] as const) {
    const file = await exportResearchReport({ userId: user.id, runId: run.id, format });
    assert.ok(file.bytes.byteLength > 200, format);
  }
});

test("20 concurrent runs from unbalanced accounts all finish inside per-account and global limits", async () => {
  const model = createFakeModel({ delayMs: 5, respond: (call) => defaultResponse(call, { subquestions: 2, sections: 1, readsPerTurn: 2 }) });
  installFakes({ model });
  createFakeWeb({ resultsPerQuery: 2 });
  const heavy = await createUser("engine-heavy");
  const light = await Promise.all(Array.from({ length: 4 }, (_, index) => createUser(`engine-light-${index}`)));
  const runs = [
    ...await Promise.all(Array.from({ length: 12 }, (_, index) => start(heavy.id, `Heavy account question ${index}`, { credits: 2_000 }))),
    ...(await Promise.all(light.flatMap((user, index) => [start(user.id, `Light ${index} a`, { credits: 2_000 }), start(user.id, `Light ${index} b`, { credits: 2_000 })]))),
  ];
  assert.equal(runs.length, 20);
  let sampling = true;
  const maxima = { global: 0, perUser: 0 };
  const sampler = (async () => {
    while (sampling) {
      const rows = await prisma.$queryRaw<Array<{ userId: string; n: number }>>`
        SELECT r."userId", count(*)::int AS n FROM "ResearchWorkItem" w JOIN "ResearchPreviewRun" r ON r."id" = w."runId" WHERE w."status" = 'running' GROUP BY r."userId"`;
      maxima.global = Math.max(maxima.global, rows.reduce((sum, row) => sum + row.n, 0));
      maxima.perUser = Math.max(maxima.perUser, ...rows.map((row) => row.n), 0);
      await new Promise((resolve) => setTimeout(resolve, 3));
    }
  })();
  await drainResearchWork("fleet", 16, { limits: { global: 12, perAccount: 3, perRun: 2, perProvider: 12 } });
  sampling = false;
  await sampler;
  const statuses = await prisma.researchPreviewRun.findMany({ where: { id: { in: runs.map((run) => run.id) } }, select: { id: true, status: true } });
  assert.ok(statuses.every((row) => row.status === "completed"), JSON.stringify(statuses.filter((row) => row.status !== "completed")));
  assert.ok(maxima.global <= 12, `global ${maxima.global}`);
  assert.ok(maxima.perUser <= 3, `per account ${maxima.perUser}`);
  for (const run of runs) {
    const money = await readResearchRunMoney(prisma, run.id);
    assert.equal(money.reservedCredits, 0);
    assert.ok(money.settledCredits <= money.approvedCredits);
  }
});

test("a 60-minute logical run survives worker replacement, pause/resume and a budget stop extended by the user", async () => {
  const fakes = installFakes({ model: createFakeModel({ respond: (call) => defaultResponse(call, { subquestions: 4, sections: 2, readsPerTurn: 2 }) }) });
  createFakeWeb({ resultsPerQuery: 2 });
  const user = await createUser("engine-long");
  // A small total: research stops for budget and waits for the user.
  const run = await start(user.id, "Long running question", { credits: 160 });
  const begun = fakes.clock.now().getTime();
  // Worker A claims one item and dies without finishing.
  const orphan = await claimNextResearchWorkItem("worker-a", { global: 8, perAccount: 8, perRun: 8, perProvider: 8 });
  assert.ok(orphan);
  fakes.clock.advance(RESEARCH_ITEM_LEASE_MS + 1_000);
  await recoverResearchEngine();
  const recovered = await prisma.researchWorkItem.findUniqueOrThrow({ where: { id: orphan!.id } });
  assert.equal(recovered.status, "queued", "a lease that expired before dispatch is requeued, not failed");
  // Worker B continues, a slice at a time, with the clock moving.
  for (let slice = 0; slice < 6; slice++) { await processOneResearchWorkItem("worker-b"); fakes.clock.advance(4 * 60_000); }
  await pauseResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  const paused = await readResearchRunDto(user.id, run.id);
  assert.ok(paused.pauseRequested);
  assert.equal(await processOneResearchWorkItem("worker-b"), false, "a paused run is not claimed");
  fakes.clock.advance(20 * 60_000);
  await resumeResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  await drainResearchWork("worker-c", 2);
  let state = await readResearchRunDto(user.id, run.id);
  // Research stopped at the approved total and waits; no paid call happens until the user acts.
  assert.equal(state.status, "awaiting_input");
  assert.equal(state.budgetReached, true);
  assert.ok(state.actions.canExtendBudget && state.actions.canFinish);
  const callsWhileWaiting = fakes.model.calls.length;
  await drainResearchWork("worker-idle", 2);
  assert.equal(fakes.model.calls.length, callsWhileWaiting, "a budget stop never dispatches on its own");
  const money = await readResearchRunMoney(prisma, run.id);
  assert.ok(money.committedCredits + money.unallocatedFinalizationCredits <= money.approvedCredits, "the finalization reserve was kept");
  fakes.clock.advance(15 * 60_000);
  await extendResearchBudget({ request: fakeRequest(), userId: user.id, runId: run.id, expectedApprovedCredits: 160, approvedCredits: 4_000 });
  // A lost response retried with the same expected value is a readback, not a second raise.
  await extendResearchBudget({ request: fakeRequest(), userId: user.id, runId: run.id, expectedApprovedCredits: 160, approvedCredits: 4_000 });
  await drainResearchWork("worker-d", 2);
  state = await readResearchRunDto(user.id, run.id);
  assert.equal(state.money.approvedCredits, 4_000);
  fakes.clock.advance(10 * 60_000);
  await recoverResearchEngine();
  state = await readResearchRunDto(user.id, run.id);
  assert.equal(state.status, "completed");
  assert.ok(fakes.clock.now().getTime() - begun >= 60 * 60_000, "at least 60 logical minutes elapsed");
  const settled = await readResearchRunMoney(prisma, run.id);
  assert.equal(settled.reservedCredits, 0);
  assert.ok(settled.settledCredits <= settled.approvedCredits);
  const duplicateDispatch = await prisma.$queryRaw<Array<{ n: number }>>`
    SELECT count(*)::int AS n FROM (SELECT "dispatchKey" FROM "ResearchPreviewGeneration" WHERE "runId" = ${run.id} GROUP BY "dispatchKey" HAVING count(*) > 1) d`;
  assert.equal(duplicateDispatch[0]?.n, 0);
});
