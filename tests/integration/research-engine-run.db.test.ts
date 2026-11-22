import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { prisma } from "@/lib/prisma";
import { createResearchRun, readResearchRunDto } from "@/lib/researchEngineService";
import { drainResearchWork } from "@/lib/researchEngineWorker";
import { readResearchRunMoney } from "@/lib/researchEngineStore";
import { readResearchReport, exportResearchReport, listResearchSources } from "@/lib/researchEngineReads";
import { createFakeWeb, createUser, fakeRequest, installFakes, users } from "./researchEngineHarness";

after(async () => {
  await prisma.user.deleteMany({ where: { id: { in: users } } });
  await prisma.$disconnect();
});

const brief = (question: string) => ({ question, deliverable: "report" as const, searchLanguages: [], regions: [],
  includeDomains: [], excludeDomains: [], constraints: [] });

test("a small Deep Research run plans, searches, reads, verifies, writes and settles end to end", async () => {
  const fakes = installFakes();
  const web = createFakeWeb();
  const user = await createUser("engine-smoke");
  const { run } = await createResearchRun({ request: fakeRequest(), userId: user.id, payload: {
    userMessageId: randomUUID(), assistantMessageId: randomUUID(), brief: brief("How do public sources describe topic X in 2026?"),
    sources: [], profile: "standard", approvedCredits: 2_000, autoStart: true,
  } });
  assert.equal(run.status, "planning");
  await drainResearchWork("worker-smoke", 4);
  const final = await readResearchRunDto(user.id, run.id);
  assert.equal(final.status, "completed", JSON.stringify(await prisma.researchWorkItem.findMany({ where: { runId: run.id, status: { not: "completed" } }, select: { kind: true, status: true, errorCode: true } })));
  assert.ok(final.currentReportRevision >= 1);
  const debugClaims = await prisma.researchClaim.findMany({ where: { runId: run.id }, select: { verification: true, evidence: true, text: true } });
  const debugVersions = await prisma.researchSourceVersion.groupBy({ by: ["readStatus", "failureReason"], where: { runId: run.id }, _count: true });
  const debugItems = await prisma.researchWorkItem.findMany({ where: { runId: run.id, kind: "read" }, select: { result: true, status: true, errorCode: true } });
  assert.ok(["complete", "partial"].includes(final.qualityStatus ?? ""), JSON.stringify({ claims: debugClaims.slice(0, 6), versions: debugVersions, inv: debugItems.map((i) => JSON.stringify(i).slice(0, 400)) }));
  assert.equal(final.money.reservedCredits, 0);
  const money = await readResearchRunMoney(prisma, run.id);
  assert.ok(money.settledCredits > 0 && money.settledCredits <= money.approvedCredits);
  assert.ok(web.searches.length > 0 && web.fetched.length > 0);
  const report = await readResearchReport({ userId: user.id, runId: run.id });
  assert.ok(report.markdown.includes("Synthetic research report"));
  assert.ok(report.claims.some((claim) => claim.verification === "unsupported"), "the fabricated quote is not evidence");
  assert.ok(report.document.bibliography.length > 0);
  const message = await prisma.message.findUnique({ where: { id: run.assistantMessageId } });
  assert.equal(message?.researchRunId, run.id);
  const sources = await listResearchSources({ userId: user.id, runId: run.id });
  assert.ok(sources.sources.length > 0);
  const md = await exportResearchReport({ userId: user.id, runId: run.id, format: "md" });
  assert.ok(md.bytes.byteLength > 100);
  assert.ok(fakes.model.calls.some((call) => call.tool === "submit_research_plan"));
});
