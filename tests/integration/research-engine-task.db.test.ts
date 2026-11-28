import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";

// Generated files go to object storage; here it is a map. Every other edge is the Research harness's fake.
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const objects = new Map<string, Buffer>();
const unused = (name: string) => async () => { throw new Error(`${name} is not used by this suite`); };
mock.module(mod("lib/r2.ts"), { namedExports: {
  writeR2Object: async (key: string, bytes: Buffer) => { objects.set(key, Buffer.from(bytes)); },
  readOwnR2ObjectBytes: async (key: string, input: { maxBytes: number }) => {
    const bytes = objects.get(key);
    if (!bytes || bytes.length > input.maxBytes) throw new Error("Missing fixture object");
    return Buffer.from(bytes);
  },
  deleteR2Object: async (key: string) => { objects.delete(key); },
  listExpiredR2Objects: async () => [],
  createR2UploadUrl: unused("createR2UploadUrl"), createR2ReadUrl: unused("createR2ReadUrl"), readR2Object: unused("readR2Object"),
  validateR2ObjectMetadata: unused("validateR2ObjectMetadata"), measureR2Object: unused("measureR2Object"), hashR2Object: unused("hashR2Object"),
  copyR2Object: unused("copyR2Object"), probeR2Object: unused("probeR2Object"),
} });

let prisma: typeof import("@/lib/prisma").prisma;
let RESEARCH_MODEL_TOOL_NAMES: typeof import("@/lib/researchEngineContract").RESEARCH_MODEL_TOOL_NAMES;
let service: typeof import("@/lib/researchEngineService");
let drainResearchWork: typeof import("@/lib/researchEngineWorker").drainResearchWork;
let processOneResearchWorkItem: typeof import("@/lib/researchEngineWorker").processOneResearchWorkItem;
let readResearchRunMoney: typeof import("@/lib/researchEngineStore").readResearchRunMoney;
let revalidateRunPrivateSources: typeof import("@/lib/researchEngineReads").revalidateRunPrivateSources;
let readResearchPreviewRunDto: typeof import("@/lib/researchPreviewRunStore").readResearchPreviewRunDto;
let drainArtifactCleanupQueue: typeof import("@/lib/generatedArtifactStorage").drainArtifactCleanupQueue;
let recoverResearchEngine: typeof import("@/lib/researchEngineRecovery").recoverResearchEngine;
let harness: typeof import("./researchEngineHarness");
const createFakeFunding = (...args: Parameters<typeof harness.createFakeFunding>) => harness.createFakeFunding(...args);
const createFakeModel = (...args: Parameters<typeof harness.createFakeModel>) => harness.createFakeModel(...args);
const createFakeWeb = (...args: Parameters<typeof harness.createFakeWeb>) => harness.createFakeWeb(...args);
const createUser = (...args: Parameters<typeof harness.createUser>) => harness.createUser(...args);
const defaultResponse = (...args: Parameters<typeof harness.defaultResponse>) => harness.defaultResponse(...args);
const fakeRequest = (...args: Parameters<typeof harness.fakeRequest>) => harness.fakeRequest(...args);
const installFakes = (...args: Parameters<typeof harness.installFakes>) => harness.installFakes(...args);

// Loaded after the storage mock above is in place, so every module sees the in-memory store.
before(async () => {
  ({ prisma } = await import("@/lib/prisma"));
  ({ RESEARCH_MODEL_TOOL_NAMES } = await import("@/lib/researchEngineContract"));
  service = await import("@/lib/researchEngineService");
  ({ drainResearchWork, processOneResearchWorkItem } = await import("@/lib/researchEngineWorker"));
  ({ readResearchRunMoney } = await import("@/lib/researchEngineStore"));
  ({ revalidateRunPrivateSources } = await import("@/lib/researchEngineReads"));
  ({ readResearchPreviewRunDto } = await import("@/lib/researchPreviewRunStore"));
  ({ drainArtifactCleanupQueue } = await import("@/lib/generatedArtifactStorage"));
  ({ recoverResearchEngine } = await import("@/lib/researchEngineRecovery"));
  harness = await import("./researchEngineHarness");
  await prisma.researchPreviewRun.deleteMany({ where: { engineVersion: 2 } });
  await prisma.messageArtifactCleanup.deleteMany({});
});

after(async () => {
  delete process.env.CHAT_TASK_AGENT_ENABLED;
  await prisma.user.deleteMany({ where: { id: { in: harness.users } } });
  await prisma.$disconnect();
});

const brief = (question: string, taskOutput?: "document" | "spreadsheet" | "presentation") => ({ question, deliverable: "report" as const,
  searchLanguages: [], regions: [], includeDomains: [], excludeDomains: [], constraints: [], ...(taskOutput ? { taskOutput } : {}) });
const create = (userId: string, overrides: Record<string, unknown> = {}) => service.createResearchRun({ request: fakeRequest(), userId, payload: {
  userMessageId: randomUUID(), assistantMessageId: randomUUID(), brief: brief("Find cafés near the station and compare their hours.", "document"),
  sources: [], profile: "standard", approvedCredits: 3_000, autoStart: true, ...overrides,
} as never }).then((result) => result.run);
const rejects = async (promise: Promise<unknown>, code: string) => {
  await assert.rejects(promise, (error: { code?: string }) => { assert.equal(error.code, code); return true; });
};
const answerFiles = async (runId: string) => {
  const run = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: runId } });
  return prisma.messageArtifact.findMany({ where: { messageId: run.assistantMessageId }, orderBy: { ordinal: "asc" } });
};
const entries = (key: string | null) => unzipSync(new Uint8Array(objects.get(key!)!));
const docxText = (key: string | null) => strFromU8(entries(key)["word/document.xml"]!);
const enable = () => { process.env.CHAT_TASK_AGENT_ENABLED = "true"; };

test("a delegated task plans steps, waits for approval, works in the background and attaches the finished document", async () => {
  enable();
  const fakes = installFakes();
  createFakeWeb();
  const user = await createUser("task-document");
  const run = await create(user.id, { autoStart: false });
  assert.deepEqual(run.task, { output: "document" });
  await drainResearchWork("task-document", 2);
  const planned = await service.readResearchRunDto(user.id, run.id);
  assert.equal(planned.status, "awaiting_input");
  assert.ok(planned.actions.canApprovePlan && planned.plan);
  assert.equal((await answerFiles(run.id)).length, 0, "nothing is handed back before the plan is approved");
  const plannerCall = fakes.model.calls.find((call) => call.tool === "submit_research_plan")!;
  assert.match(plannerCall.text, /task the user delegated/u);
  assert.match(plannerCall.text, /Nothing can be sent, posted, bought, booked, signed in to or changed anywhere/u);
  assert.equal(fakes.model.calls.length, 1, "only the plan was paid for before approval");

  await service.approveResearchPlan({ request: fakeRequest(), userId: user.id, runId: run.id, planRevision: planned.planRevision });
  await drainResearchWork("task-document", 4);
  const done = await service.readResearchRunDto(user.id, run.id);
  assert.equal(done.status, "completed");
  assert.equal(done.money.reservedCredits, 0);
  assert.equal(done.money.settlement, "settled");
  const money = await readResearchRunMoney(prisma, run.id);
  assert.ok(money.settledCredits > 0 && money.settledCredits <= money.approvedCredits);

  const [file, ...more] = await answerFiles(run.id);
  assert.equal(more.length, 0);
  assert.equal(file!.format, "docx");
  assert.equal(file!.status, "ready");
  assert.equal(file!.ordinal, 0);
  assert.equal(file!.filename, "Synthetic research report.docx");
  assert.equal(file!.userId, user.id);
  assert.equal(file!.byteSize, objects.get(file!.objectKey!)!.byteLength);
  assert.ok(docxText(file!.objectKey).includes("Synthetic research report"), "the file is the written report");
  // The card the chat polls carries the file with the answer.
  const card = await readResearchPreviewRunDto(user.id, run.id);
  assert.deepEqual((card?.message?.artifacts as Array<{ id: string }> | undefined)?.map((entry) => entry.id), [file!.id]);
  // Every model request offered exactly one tool, from the fixed submission list.
  assert.ok(fakes.model.calls.length > 5);
  for (const call of fakes.model.calls) {
    assert.equal(call.tools?.length, 1, call.tool);
    assert.ok((RESEARCH_MODEL_TOOL_NAMES as readonly string[]).includes(call.tools![0]!), call.tools![0]);
  }
});

test("the file step costs nothing: a task and the same research settle the same credits from the same calls", async () => {
  enable();
  const settle = async (label: string, taskOutput?: "spreadsheet") => {
    const fakes = installFakes();
    createFakeWeb();
    const user = await createUser(label);
    const run = await create(user.id, { brief: brief("Compare opening hours of cafés near the station.", taskOutput) });
    await drainResearchWork(label, 1);
    assert.equal((await service.readResearchRunDto(user.id, run.id)).status, "completed");
    const money = await readResearchRunMoney(prisma, run.id);
    const ledger = [...fakes.funding.reservations.values()].filter((entry) => entry.userId === user.id).reduce((sum, entry) => sum + entry.settled, 0);
    assert.equal(money.settledCredits, ledger, "the run total is the Chat ledger total");
    return { settled: money.settledCredits, calls: fakes.model.calls.map((call) => call.tool).sort(), files: await answerFiles(run.id) };
  };
  const research = await settle("cost-research");
  const task = await settle("cost-task", "spreadsheet");
  assert.equal(research.files.length, 0, "plain research hands back no file");
  assert.deepEqual(task.files.map((file) => [file.format, file.status]), [["xlsx", "ready"]]);
  assert.deepEqual(task.calls, research.calls, "no extra model call for the file");
  assert.equal(task.settled, research.settled, "no extra credits for the file");
  // A spreadsheet task asks every section for a table.
  const sheet = entries(task.files[0]!.objectKey);
  assert.ok(sheet["xl/workbook.xml"] && Object.keys(sheet).some((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)));
});

test("a slide deck task attaches a pptx, and a format revision adds the next version of it", async () => {
  enable();
  installFakes();
  createFakeWeb();
  const user = await createUser("task-slides");
  const run = await create(user.id, { brief: brief("Prepare a short deck on café hours near the station.", "presentation") });
  await drainResearchWork("task-slides", 4);
  const first = await service.readResearchRunDto(user.id, run.id);
  assert.equal(first.status, "completed");
  const [deck] = await answerFiles(run.id);
  assert.equal(deck!.format, "pptx");
  assert.ok(Object.keys(entries(deck!.objectKey)).some((name) => name === "ppt/slides/slide1.xml"));
  await service.requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: run.id,
    revision: { expectedReportRevision: first.currentReportRevision, kind: "format", sectionKeys: [], instruction: "Shorter, please." } });
  await drainResearchWork("task-slides", 4);
  const second = await service.readResearchRunDto(user.id, run.id);
  assert.equal(second.status, "completed");
  const files = await answerFiles(run.id);
  assert.deepEqual(files.map((file) => [file.ordinal, file.format, file.status]), [[0, "pptx", "ready"], [second.currentReportRevision - 1, "pptx", "ready"]]);
  assert.equal(files[1]!.parentArtifactId, files[0]!.id, "the revision's file is the next version of the first");
  assert.equal(files[1]!.lineageId, files[0]!.lineageId ?? files[0]!.id);
});

test("a task that reaches its credit maximum stops, then finishing settles within the total and still hands back a file", async () => {
  enable();
  const fakes = installFakes();
  createFakeWeb();
  const user = await createUser("task-budget");
  const run = await create(user.id, { approvedCredits: 100 });
  await drainResearchWork("task-budget", 2);
  const waiting = await service.readResearchRunDto(user.id, run.id);
  assert.equal(waiting.status, "awaiting_input");
  assert.equal(waiting.budgetReached, true);
  assert.equal(waiting.money.reservedCredits, 0);
  const callsAtStop = fakes.model.calls.length;
  await drainResearchWork("task-budget", 2);
  assert.equal(fakes.model.calls.length, callsAtStop, "no paid call while waiting for the user");
  await service.finishResearchNow({ request: fakeRequest(), userId: user.id, runId: run.id });
  await drainResearchWork("task-budget", 2);
  const done = await service.readResearchRunDto(user.id, run.id);
  assert.equal(done.status, "completed");
  const money = await readResearchRunMoney(prisma, run.id);
  assert.equal(money.reservedCredits, 0);
  assert.ok(money.settledCredits + money.unknownCredits <= money.approvedCredits, JSON.stringify(money));
  const [file] = await answerFiles(run.id);
  assert.equal(file?.status, "ready", "the partial report still comes back as the file");
});

test("cancelling a task stops new work, settles what was sent and hands back no file", async () => {
  enable();
  installFakes();
  createFakeWeb();
  const user = await createUser("task-cancel");
  const run = await create(user.id);
  for (let index = 0; index < 4; index += 1) await processOneResearchWorkItem(`task-cancel:${index}`);
  await service.cancelResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  await drainResearchWork("task-cancel", 2);
  // Holds whose child searches were cancelled are settled by the maintenance pass, as in production.
  await recoverResearchEngine();
  const cancelled = await service.readResearchRunDto(user.id, run.id);
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.money.reservedCredits, 0);
  assert.equal(cancelled.money.settlement, "settled");
  assert.equal((await answerFiles(run.id)).length, 0);
});

test("a task dispatch whose outcome is unknown is never sent again; its cost stays held and the file still comes back", async () => {
  enable();
  let sections = 0;
  const model = createFakeModel({ respond: (call) => {
    if (call.tool === "submit_research_section" && sections++ === 0) return { usage: "unknown" };
    return defaultResponse(call);
  } });
  const fakes = installFakes({ model, funding: createFakeFunding() });
  createFakeWeb();
  const user = await createUser("task-unknown");
  const run = await create(user.id);
  await drainResearchWork("task-unknown", 1);
  await drainResearchWork("task-unknown", 1);
  const unknown = await prisma.researchPreviewGeneration.findMany({ where: { runId: run.id, status: "outcome_unknown" } });
  assert.equal(unknown.length, 1);
  const item = await prisma.researchWorkItem.findFirstOrThrow({ where: { runId: run.id, kind: "write_section", status: "attention" } });
  const sameKey = await prisma.researchPreviewGeneration.count({ where: { runId: run.id, dispatchKey: { startsWith: `${item.id}:` } } });
  assert.equal(sameKey, 1, "the unknown section dispatch was not repeated");
  assert.equal(fakes.model.calls.filter((call) => call.tool === "submit_research_section").length, sections);
  const done = await service.readResearchRunDto(user.id, run.id);
  assert.equal(done.money.settlement, "unknown");
  assert.ok(done.money.unknownCredits > 0, "the unknown request's hold is kept, not refunded");
  const money = await readResearchRunMoney(prisma, run.id);
  assert.ok(money.settledCredits + money.unknownCredits + money.reservedCredits <= money.approvedCredits);
  assert.equal(done.status, "completed");
  assert.equal((await answerFiles(run.id))[0]?.status, "ready");
});

test("a model call that names any tool outside the fixed submission list is refused before a hold or a request", async () => {
  enable();
  const fakes = installFakes();
  const { callResearchModel } = await import("@/lib/researchEngineModel");
  const { z } = await import("zod");
  for (const toolName of ["send_email", "create_document", "mcp__gmail__send", "browser_click"]) {
    await rejects(callResearchModel({ run: { id: "run-x", userId: "user-x", executionProfile: {} }, fence: { itemId: "item-x", ownerId: "owner-x", leaseEpoch: 1 },
      role: "writer", purpose: "finalization", dispatchKey: `x:${toolName}`, system: "s", prompt: "p", toolName, toolDescription: "d",
      schema: z.object({}), outputTokenCap: 100, signal: new AbortController().signal }), "RESEARCH_TOOL_NOT_ALLOWED");
  }
  assert.equal(fakes.funding.reservations.size, 0, "no credit hold");
  assert.equal(fakes.model.calls.length, 0, "no provider request");
});

test("delegated tasks are off by default; turning the switch off refuses new work but still allows cancelling", async () => {
  delete process.env.CHAT_TASK_AGENT_ENABLED;
  installFakes();
  createFakeWeb();
  const user = await createUser("task-switch");
  assert.equal((await service.researchEngineOffer(user.id)).features?.taskAgent, false);
  await rejects(create(user.id), "CHAT_TASK_AGENT_DISABLED");
  const research = await create(user.id, { brief: brief("Plain research still works.") });
  assert.equal(research.task, undefined);
  enable();
  assert.equal((await service.researchEngineOffer(user.id)).features?.taskAgent, true);
  const run = await create(user.id, { autoStart: false });
  await drainResearchWork("task-switch", 2);
  const planned = await service.readResearchRunDto(user.id, run.id);
  assert.equal(planned.status, "awaiting_input");
  delete process.env.CHAT_TASK_AGENT_ENABLED;
  await rejects(service.approveResearchPlan({ request: fakeRequest(), userId: user.id, runId: run.id, planRevision: planned.planRevision }), "CHAT_TASK_AGENT_DISABLED");
  await rejects(service.requestResearchPlan({ request: fakeRequest(), userId: user.id, runId: run.id, expectedPlanRevision: planned.planRevision }), "CHAT_TASK_AGENT_DISABLED");
  const cancelled = await service.cancelResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  assert.equal(cancelled.status, "cancelled");
  // The research engine's own switch also gates tasks.
  process.env.CHAT_TASK_AGENT_ENABLED = "true";
  process.env.RESEARCH_ENGINE_ENABLED = "false";
  await rejects(create(user.id), "RESEARCH_ENGINE_DISABLED");
  process.env.RESEARCH_ENGINE_ENABLED = "true";
});

test("a private source revoked after the task finished is withheld from its file too, and the old bytes are queued for deletion", async () => {
  enable();
  installFakes();
  createFakeWeb();
  const user = await createUser("task-revoke");
  const memory = await prisma.memoryItem.create({ data: { userId: user.id, kind: "project", statement: "Task memory with a private budget detail", status: "active", confidence: 0.9 } });
  const run = await create(user.id, { sources: [{ type: "memory", memoryItemId: memory.id }] });
  await drainResearchWork("task-revoke", 4);
  assert.equal((await service.readResearchRunDto(user.id, run.id)).status, "completed");
  const [before] = await answerFiles(run.id);
  assert.ok(docxText(before!.objectKey).includes("Task memory with a private"), "the file lists the private source by its copied label");
  await prisma.memoryItem.delete({ where: { id: memory.id } });
  const row = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } });
  await revalidateRunPrivateSources(row);
  const [afterRevoke] = await answerFiles(run.id);
  assert.equal(afterRevoke!.id, before!.id, "the same file keeps its card");
  assert.equal(afterRevoke!.status, "ready");
  assert.notEqual(afterRevoke!.objectKey, before!.objectKey);
  assert.ok(!docxText(afterRevoke!.objectKey).includes("Task memory with a private"), "the rebuilt file no longer carries the label");
  const tombstone = await prisma.messageArtifactCleanup.findUniqueOrThrow({ where: { objectKey: before!.objectKey! } });
  assert.equal(tombstone.reason, "source_revoked");
  await drainArtifactCleanupQueue();
  assert.equal(objects.has(before!.objectKey!), false, "the old bytes are deleted");
  assert.equal(objects.has(afterRevoke!.objectKey!), true);
  // A second revalidation changes nothing further.
  await revalidateRunPrivateSources(row);
  assert.equal((await answerFiles(run.id))[0]!.objectKey, afterRevoke!.objectKey);
});

test("deleting a finished task queues its file for deletion with the answer", async () => {
  enable();
  installFakes();
  createFakeWeb();
  const user = await createUser("task-delete");
  const run = await create(user.id);
  await drainResearchWork("task-delete", 4);
  const [file] = await answerFiles(run.id);
  assert.equal(file?.status, "ready");
  await service.deleteResearchRun({ request: fakeRequest(), userId: user.id, runId: run.id });
  assert.equal(await prisma.messageArtifact.count({ where: { id: file!.id } }), 0);
  assert.equal((await prisma.messageArtifactCleanup.findUniqueOrThrow({ where: { objectKey: file!.objectKey! } })).reason, "message_deleted");
});
