import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// docs/policy/amux-v22-result-transfer.md 10.1: the chunk route rebuilds a
// context file from its source rows under the conditions the delivery used:
// the attempt's binding first, the rows read inside the DB boundary, the
// bodies opened outside it.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const attemptId = "00000000-0000-4000-8000-000000000001";
const taskId = "task-one";

let inside = false;
let boundaries: unknown[] = [];
const log: string[] = [];
const guarded = (name: string) => log.push(`${name}:${inside ? "inside" : "outside"}`);
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: { v22ContextRead: { operation: "v22_context_read" } },
  withAmuxDbBoundary: async (boundary: unknown, work: (tx: unknown) => Promise<unknown>) => {
    boundaries.push(boundary);
    inside = true;
    try { return await work({}); } finally { inside = false; }
  } } });
let binding: { taskId: string } | null = { taskId };
mock.module(mod("lib/amux/v22TransferStore.ts"), { namedExports: {
  readAmuxV22TransferBinding: async (_db: unknown, id: string, worker: string) => {
    guarded("binding");
    assert.equal(id, attemptId);
    assert.equal(worker, "worker-one");
    return binding;
  } } });
let resumeRows: unknown = null;
let previousPatch: string | null = null;
let openResumeFails = false;
mock.module(mod("lib/amux/v22OwnerQuestionService.ts"), { namedExports: {
  readAmuxV22ResumeRows: async (_tx: unknown, id: string) => {
    guarded("resumeRows"); assert.equal(id, taskId); return resumeRows; },
  openAmuxV22ResumeContext: async () => {
    guarded("openResume");
    if (openResumeFails) throw new Error("key store unavailable");
    return { previousPatch };
  } } });
let priorRows: unknown = null;
let priorEntries: Array<Record<string, unknown>> = [];
let openPriorFails = false;
mock.module(mod("lib/amux/v22PriorConclusionService.ts"), { namedExports: {
  readAmuxV22PriorConclusionRows: async (_tx: unknown, id: string) => {
    guarded("priorRows"); assert.equal(id, taskId); return priorRows; },
  openAmuxV22PriorConclusions: async () => {
    guarded("openPrior");
    if (openPriorFails) throw new Error("body purged");
    return priorEntries;
  } } });

const load = () => import(mod("lib/amux/v22ContextStore.ts"));
const section = async () => {
  const { buildAmuxV22PriorConclusionSection } = await import(mod("lib/amux/v22ConclusionCore.ts"));
  return buildAmuxV22PriorConclusionSection({ entries: priorEntries, budgetBytes: null }).section;
};
const read = async (name: "prior.patch" | "prior-conclusions.md") => {
  log.length = 0;
  return (await load()).readAmuxV22ContextPart({ attemptId, worker: "worker-one", name });
};
const reset = () => {
  binding = { taskId }; resumeRows = null; previousPatch = null; priorRows = null;
  priorEntries = []; openResumeFails = false; openPriorFails = false; boundaries = [];
  delete process.env.TOMVERSE_AMUX_V22_CONCLUSION;
};

test("an attempt that is not this worker's live one reads no rows", async () => {
  reset();
  binding = null;
  assert.deepEqual(await read("prior.patch"), { kind: "binding_mismatch" });
  assert.deepEqual(await read("prior-conclusions.md"), { kind: "binding_mismatch" });
  assert.deepEqual(log, ["binding:inside"]);
});

test("the previous change is the resumed run's patch, read inside the boundary and opened outside it", async () => {
  reset();
  resumeRows = { question: {}, result: {}, patch: {} };
  previousPatch = "diff --git a/é b/é\n+한글\n";
  assert.deepEqual(await read("prior.patch"), { kind: "text", text: previousPatch });
  assert.deepEqual(log, ["binding:inside", "resumeRows:inside", "openResume:outside"]);
  assert.equal(boundaries.length, 1);
  assert.deepEqual(boundaries[0], { operation: "v22_context_read" });
});

test("no resumed question, or a run that left no change, has no previous change", async () => {
  reset();
  assert.deepEqual(await read("prior.patch"), { kind: "absent" });
  assert.deepEqual(log, ["binding:inside", "resumeRows:inside"]);
  resumeRows = { question: {}, result: {}, patch: null };
  previousPatch = null;
  assert.deepEqual(await read("prior.patch"), { kind: "absent" });
  previousPatch = "";
  assert.deepEqual(await read("prior.patch"), { kind: "absent" }, "an empty patch is not a file");
});

test("a previous change that cannot be opened is an unknown outcome, not an absence", async () => {
  reset();
  resumeRows = { question: {}, result: {}, patch: {} };
  openResumeFails = true;
  await assert.rejects(read("prior.patch"), /key store unavailable/);
});

test("the prior conclusions are the delivery's section, built whole", async () => {
  reset();
  process.env.TOMVERSE_AMUX_V22_CONCLUSION = "prompt";
  priorRows = { taskId, self: {}, rows: [] };
  priorEntries = [{ label: "T-1 (investigate)", findings: "The index is the cause.", note: null },
    { label: "T-2", findings: "x".repeat(200_000), note: "Check the cache." }];
  const got = await read("prior-conclusions.md");
  assert.deepEqual(got, { kind: "text", text: await section() });
  assert.ok((got as { text: string }).text.includes("x".repeat(200_000)), "no entry is cut");
  assert.deepEqual(log, ["binding:inside", "priorRows:inside", "openPrior:outside"]);
});

test("with the conclusion switch off the delivery carries none, so the route reads none", async () => {
  reset();
  priorRows = { taskId, self: {}, rows: [] };
  priorEntries = [{ label: "T-1", findings: "ok", note: null }];
  assert.deepEqual(await read("prior-conclusions.md"), { kind: "absent" });
  assert.deepEqual(log, ["binding:inside"]);
  process.env.TOMVERSE_AMUX_V22_CONCLUSION = "auto";
  assert.equal((await read("prior-conclusions.md")).kind, "text");
});

test("no finished prerequisite, no readable body, or an unopenable one leaves the file absent", async () => {
  reset();
  process.env.TOMVERSE_AMUX_V22_CONCLUSION = "prompt";
  assert.deepEqual(await read("prior-conclusions.md"), { kind: "absent" });
  priorRows = { taskId, self: {}, rows: [] };
  priorEntries = [];
  assert.deepEqual(await read("prior-conclusions.md"), { kind: "absent" });
  priorEntries = [{ label: "T-1", findings: "ok", note: null }];
  openPriorFails = true;
  assert.deepEqual(await read("prior-conclusions.md"), { kind: "absent" },
    "the delivery leaves an unopenable body out the same way");
});

test("the boundary's call ceiling covers its widest read", () => {
  const source = readFileSync(resolve(root, "lib/amux/dbBoundary.ts"), "utf8");
  const block = source.slice(source.indexOf("v22ContextRead: {"));
  const ceiling = Number(/prismaCallCeiling: (\d+),/.exec(block)?.[1]);
  const calls = (path: string, name: string) => Number(new RegExp(`${name} = (\\d+);`)
    .exec(readFileSync(resolve(root, path), "utf8"))?.[1]);
  const widest = Math.max(
    calls("lib/amux/v22OwnerQuestionService.ts", "AMUX_V22_RESUME_ROWS_PRISMA_CALLS"),
    calls("lib/amux/v22PriorConclusionService.ts", "AMUX_V22_PRIOR_CONCLUSION_ROWS_PRISMA_CALLS"));
  // setup + the binding read + the rows + the read fence.
  assert.ok(widest >= 1);
  assert.ok(ceiling >= 2 + 1 + widest, `ceiling ${ceiling} for ${widest} row reads`);
  assert.match(block, /isolation: "read"/);
});
