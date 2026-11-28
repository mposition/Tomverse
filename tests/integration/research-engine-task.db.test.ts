import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, mock, test } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { strFromU8, unzipSync } from "fflate";

// Generated files go to object storage; here it is a map. Every other edge is the Research harness's fake.
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const objects = new Map<string, Buffer>();
/** Storage faults a test can switch on: every write fails, or writes wait until released. */
const storage = { failWrites: false, hold: null as Promise<void> | null };
const unused = (name: string) => async () => { throw new Error(`${name} is not used by this suite`); };
mock.module(mod("lib/r2.ts"), { namedExports: {
  writeR2Object: async (key: string, bytes: Buffer) => {
    if (storage.hold) await storage.hold;
    if (storage.failWrites) throw new Error("storage unavailable");
    objects.set(key, Buffer.from(bytes));
  },
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
let researchTaskFileServable: typeof import("@/lib/researchEngineTaskFiles").researchTaskFileServable;
let retryWithheldResearchTaskFile: typeof import("@/lib/researchEngineTaskFiles").retryWithheldResearchTaskFile;
let readResearchReport: typeof import("@/lib/researchEngineReads").readResearchReport;
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
  ({ revalidateRunPrivateSources, readResearchReport } = await import("@/lib/researchEngineReads"));
  ({ researchTaskFileServable, retryWithheldResearchTaskFile } = await import("@/lib/researchEngineTaskFiles"));
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

const waitFor = async (check: () => Promise<boolean>) => {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not reached");
};
const memoryTask = async (label: string, statements: string[]) => {
  enable();
  installFakes();
  createFakeWeb();
  const user = await createUser(label);
  const memories = [];
  for (const statement of statements) {
    memories.push(await prisma.memoryItem.create({ data: { userId: user.id, kind: "project", statement, status: "active", confidence: 0.9 } }));
  }
  const run = await create(user.id, { sources: memories.map((item) => ({ type: "memory", memoryItemId: item.id })) });
  await drainResearchWork(label, 4);
  assert.equal((await service.readResearchRunDto(user.id, run.id)).status, "completed");
  return { user, run, memories, row: await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id } }) };
};

test("revoking a private source withholds the task file in the revoking commit: nothing is served while the rebuild is still writing", async () => {
  const { run, memories, row } = await memoryTask("task-revoke-hold", ["Held memory with a private budget detail"]);
  const [ready] = await answerFiles(run.id);
  assert.equal(ready!.status, "ready");
  let release!: () => void;
  storage.hold = new Promise<void>((resolve) => { release = resolve; });
  try {
    await prisma.memoryItem.delete({ where: { id: memories[0]!.id } });
    const revoking = revalidateRunPrivateSources(row);
    await waitFor(async () => (await answerFiles(run.id))[0]!.status !== "ready");
    // The rebuild is now waiting on storage; the revoking commit has already landed.
    const [withheld] = await answerFiles(run.id);
    assert.deepEqual([withheld!.id, withheld!.status, withheld!.failureCode, withheld!.objectKey, withheld!.byteSize], [ready!.id, "failed", "source_revoked", null, 0]);
    assert.equal((await prisma.researchSource.findFirstOrThrow({ where: { runId: run.id, visibility: "private" } })).status, "revoked");
    assert.equal((await prisma.messageArtifactCleanup.findUniqueOrThrow({ where: { objectKey: ready!.objectKey! } })).reason, "source_revoked");
    // A download with the old object (the route already 404s a row that is not ready) is refused by the re-check too.
    const download = researchTaskFileServable({ id: ready!.id, objectKey: ready!.objectKey! });
    storage.hold = null;
    release();
    assert.equal(await download, false);
    await revoking;
  } finally { storage.hold = null; release(); }
  const [rebuilt] = await answerFiles(run.id);
  assert.equal(rebuilt!.status, "ready");
  assert.equal(rebuilt!.failureCode, null);
  assert.notEqual(rebuilt!.objectKey, ready!.objectKey);
  assert.ok(!docxText(rebuilt!.objectKey).includes("Held memory with a private"));
});

test("a rebuild that fails stays withheld and is retried: by maintenance once storage is back, and by the next Research read", async () => {
  const { user, run, memories, row } = await memoryTask("task-revoke-retry", ["Retry memory one with a private note", "Retry memory two with a private note"]);
  const [original] = await answerFiles(run.id);
  const withheld = async () => {
    const [file] = await answerFiles(run.id);
    assert.deepEqual([file!.id, file!.status, file!.failureCode, file!.objectKey], [original!.id, "failed", "source_revoked", null]);
  };
  try {
    storage.failWrites = true;
    await prisma.memoryItem.delete({ where: { id: memories[0]!.id } });
    await revalidateRunPrivateSources(row);
    await withheld();
    await recoverResearchEngine();
    await withheld();
    storage.failWrites = false;
    assert.ok((await recoverResearchEngine()).rebuiltTaskFiles >= 1);
    const [byMaintenance] = await answerFiles(run.id);
    assert.equal(byMaintenance!.status, "ready");
    assert.ok(!docxText(byMaintenance!.objectKey).includes("Retry memory one"));

    storage.failWrites = true;
    await prisma.memoryItem.delete({ where: { id: memories[1]!.id } });
    await revalidateRunPrivateSources(row);
    await withheld();
    storage.failWrites = false;
    await readResearchReport({ userId: user.id, runId: run.id });
    const [byRead] = await answerFiles(run.id);
    assert.equal(byRead!.status, "ready");
    assert.ok(!docxText(byRead!.objectKey).includes("Retry memory"));
  } finally { storage.failWrites = false; }
});

test("a download re-checks the run's private sources first and refuses the old file once one is gone; other files skip the check", async () => {
  const { user, run, memories } = await memoryTask("task-download-check", ["Download memory with a private figure"]);
  const [file] = await answerFiles(run.id);
  assert.equal(await researchTaskFileServable({ id: file!.id, objectKey: file!.objectKey! }), true, "sources still granted: served");
  await prisma.memoryItem.delete({ where: { id: memories[0]!.id } });
  // Nothing has noticed yet: the row still points at the old bytes.
  assert.equal((await answerFiles(run.id))[0]!.objectKey, file!.objectKey);
  assert.equal(await researchTaskFileServable({ id: file!.id, objectKey: file!.objectKey! }), false, "the re-check finds the deletion and refuses");
  const [rebuilt] = await answerFiles(run.id);
  assert.equal(rebuilt!.status, "ready");
  assert.notEqual(rebuilt!.objectKey, file!.objectKey);
  assert.ok(!docxText(rebuilt!.objectKey).includes("Download memory"));
  assert.equal(await researchTaskFileServable({ id: rebuilt!.id, objectKey: rebuilt!.objectKey! }), true, "the rebuilt file is served");
  // A task without private sources is served with no source check.
  const publicRun = await create(user.id);
  await drainResearchWork("task-download-check", 4);
  const [publicFile] = await answerFiles(publicRun.id);
  assert.equal(await researchTaskFileServable({ id: publicFile!.id, objectKey: publicFile!.objectKey! }), true);
});

test("a large report keeps every table and every point: ten tables in the spreadsheet, and a deck past 100 slides laid out denser", async () => {
  enable();
  const points = 59;
  const respond = (call: { tool: string; text: string; callIndex: number }) => {
    if (call.tool === "submit_research_plan") return defaultResponse(call, { subquestions: 10, sections: 10 });
    if (call.tool !== "submit_research_section") return defaultResponse(call);
    const heading = /Section: ([^\n]+)/u.exec(call.text)?.[1] ?? "Section";
    const keys = [...call.text.matchAll(/^(C\d+) \[(supported|partial|conflicting|unverified)/gmu)].map((match) => match[1]!);
    if (!keys.length) return defaultResponse(call);
    return { heading, blocks: [
      ...Array.from({ length: points }, (_, index) => ({ type: "paragraph", text: `${heading} point ${index + 1}.`, claimKeys: [keys[0]!] })),
      { type: "table", caption: `${heading} table`, columns: ["Claim", "Section"], rows: keys.slice(0, 4).map((key) => [key, heading]), claimKeys: [keys[0]!] },
    ] };
  };
  const finished = async (label: string, taskOutput: "spreadsheet" | "presentation") => {
    installFakes({ model: createFakeModel({ respond }) });
    createFakeWeb();
    const user = await createUser(label);
    const run = await create(user.id, { profile: "deep", brief: brief("Compile everything about café hours near the station.", taskOutput) });
    await drainResearchWork(label, 4);
    assert.equal((await service.readResearchRunDto(user.id, run.id)).status, "completed");
    const report = await readResearchReport({ userId: user.id, runId: run.id });
    const [file] = await answerFiles(run.id);
    assert.equal(file!.status, "ready", `${taskOutput}: ${file!.failureCode}`);
    const parts = entries(file!.objectKey);
    return { report, parts: Object.keys(parts), xml: Object.entries(parts).filter(([name]) => name.endsWith(".xml")).map(([, bytes]) => strFromU8(bytes)).join("\n") };
  };
  const sheet = await finished("task-large-sheet", "spreadsheet");
  const tables = sheet.report.document.sections.flatMap((section) => section.blocks.filter((block) => block.type === "table"));
  assert.ok(tables.length >= 9, `the report has ${tables.length} tables`);
  assert.ok(sheet.parts.filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/u.test(name)).length <= 10);
  for (const block of tables) if (block.type === "table") for (const row of block.rows) for (const cell of row) assert.ok(sheet.xml.includes(`>${cell}<`), `cell ${cell}`);

  const deck = await finished("task-large-deck", "presentation");
  const paragraphs = deck.report.document.sections.flatMap((section) => section.blocks.flatMap((block) => block.type === "paragraph" ? [block.text] : []));
  const sections = deck.report.document.sections.filter((section) => section.blocks.length);
  const atSix = sections.reduce((sum, section) => sum + Math.ceil(section.blocks.filter((block) => block.type === "paragraph").length / 6) + 2, 2);
  assert.ok(atSix > 100, `six points a slide would need ${atSix} slides`);
  assert.ok(deck.parts.filter((name) => /^ppt\/slides\/slide\d+\.xml$/u.test(name)).length <= 100);
  for (const text of paragraphs) assert.ok(deck.xml.includes(text), text);
});

test("a file left withheld by a failed rebuild recovers on the next read or file request, with no new revocation", async () => {
  const { user, run, memories, row } = await memoryTask("task-withheld-no-revoke", ["Lingering memory one with a private note", "Lingering memory two with a private note"]);
  const [original] = await answerFiles(run.id);
  const state = async () => { const [file] = await answerFiles(run.id); return [file!.id, file!.status, file!.failureCode] as const; };
  try {
    storage.failWrites = true;
    await prisma.memoryItem.delete({ where: { id: memories[0]!.id } });
    await revalidateRunPrivateSources(row);
    assert.deepEqual(await state(), [original!.id, "failed", "source_revoked"]);
    storage.failWrites = false;
    // Nothing else is revoked now: the remaining source still grants, so this read finds no new revocation.
    const revokedBefore = await prisma.researchSource.count({ where: { runId: run.id, status: "revoked" } });
    await readResearchReport({ userId: user.id, runId: run.id });
    assert.equal(await prisma.researchSource.count({ where: { runId: run.id, status: "revoked" } }), revokedBefore);
    assert.deepEqual(await state(), [original!.id, "ready", null], "the read rebuilt it");

    // Again withheld by a failed rebuild; this time asking for the file itself (download, revision input, project save) rebuilds it.
    storage.failWrites = true;
    await prisma.memoryItem.delete({ where: { id: memories[1]!.id } });
    await revalidateRunPrivateSources(row);
    assert.deepEqual(await state(), [original!.id, "failed", "source_revoked"]);
    storage.failWrites = false;
    assert.equal(await retryWithheldResearchTaskFile(original!.id, "someone-else"), false, "only the owner's request rebuilds");
    assert.deepEqual(await state(), [original!.id, "failed", "source_revoked"]);
    assert.equal(await retryWithheldResearchTaskFile(original!.id, user.id), true);
    assert.deepEqual(await state(), [original!.id, "ready", null]);
    const [file] = await answerFiles(run.id);
    assert.ok(!docxText(file!.objectKey).includes("Lingering memory"));
  } finally { storage.failWrites = false; }
});

test("the version chain runs through files that could not be served: a revision's file is the next version of a failed one", async () => {
  enable();
  installFakes();
  createFakeWeb();
  const user = await createUser("task-chain");
  let run: Awaited<ReturnType<typeof create>>;
  storage.failWrites = true;
  try {
    run = await create(user.id);
    await drainResearchWork("task-chain", 4);
  } finally { storage.failWrites = false; }
  const first = { run, dto: await service.readResearchRunDto(user.id, run.id) };
  assert.equal(first.dto.status, "completed");
  const [failed] = await answerFiles(first.run.id);
  assert.deepEqual([failed!.status, failed!.failureCode, failed!.lineageId], ["failed", "storage_failed", failed!.id], "a failed first file still roots the chain");
  await service.requestResearchRevision({ request: fakeRequest(), userId: user.id, runId: first.run.id,
    revision: { expectedReportRevision: first.dto.currentReportRevision, kind: "format", sectionKeys: [], instruction: "Tighter, please." } });
  await drainResearchWork("task-chain", 4);
  const files = await answerFiles(first.run.id);
  assert.equal(files.length, 2);
  assert.equal(files[1]!.status, "ready");
  assert.equal(files[1]!.parentArtifactId, failed!.id, "the next version of the failed file");
  assert.equal(files[1]!.lineageId, failed!.id);
});
