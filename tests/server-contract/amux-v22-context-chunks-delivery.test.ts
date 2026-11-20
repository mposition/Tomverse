import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { mock, test } from "node:test";

// Owner direction 2026-11-19 (docs/policy/amux-v22-result-transfer.md 10.1):
// a pull from a bridge that can fetch chunks (header context_chunks) names
// `prior.patch` and `prior-conclusions.md` as context parts and leaves them out
// of the prompt block; any other pull is exactly as before. The receipt's
// prior-conclusion digest does not change either way.

const root = resolve(import.meta.dirname, "..", "..");
const mod = (path: string) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-11-19T12:00:00.000Z");
const taskId = "c48886b9-86f8-4631-8db8-c0b288a707af";
const ideaId = "7a1d2c3b-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const assignmentId = "assignment-one";
const attemptId = "attempt-three";
const worker = "worker-one";
const instanceId = "instance-one";

process.env.TOMVERSE_AMUX_V22_CONCLUSION = "prompt";

let audits: Array<Record<string, unknown>> = [];
let deliveryRow: Record<string, unknown> = {};
let previousPatch: string | null = null;
let resumed = false;
let priorEntries: Array<Record<string, unknown>> = [];

const baseRow = () => ({
  runtimeLeaseExpiresAt: new Date("2026-11-19T12:01:00.000Z"),
  attemptLeaseExpiresAt: new Date("2026-11-19T12:01:00.000Z"),
  v22AssignmentId: assignmentId, attemptId, taskId, worker,
  workerInstanceId: instanceId, workerGeneration: 1, taskRevision: 6,
  prompt: "amux-v22:sealed-brief", status: "queued", receiptId: null,
  leasedAt: null, leaseExpiresAt: null, acknowledgedAt: null, cancelledAt: null,
  ...deliveryRow,
});

const tx = {
  $queryRaw: async (strings: TemplateStringsArray) => {
    const sql = strings.join("?");
    if (sql.includes('JOIN "AmuxWorkDelivery"')) return [baseRow()];
    if (sql.includes('FROM "AmuxWorkerRuntime"')) return [{ workerName: worker, instanceId,
      generation: 1, status: "busy", dispatchReady: false, protocolCapabilities: [],
      heartbeatAt: new Date("2026-11-19T11:59:30.000Z"),
      leaseExpiresAt: new Date("2026-11-19T12:01:00.000Z") }];
    throw new Error(`unexpected SQL: ${sql}`);
  },
  amuxWorkItem: {
    findUnique: async (input: { select: Record<string, unknown> }) => {
      if (input.select.sourceSnapshot) return { sourceSnapshot: { ideaId },
        v22AcceptedAssignment: { id: assignmentId, role: "implement",
          authorizationAuditLog: { action: "amux.v22.worker.assigned", targetId: assignmentId,
            metadata: { v52GradeRouting: false } } } };
      const sealed = Buffer.from("sealed");
      return { sourceSystem: "admin-idea-v4", cardType: "task",
        v4BriefCiphertext: sealed, v4BriefKeyId: "brief-key", v4BriefKeyVersion: 1,
        v4BriefDigest: "b".repeat(64), v4BriefDigestKeyId: "digest-key-one", v4BriefPurgedAt: null,
        v4TitleCiphertext: null, v4TitleKeyId: null, v4TitleKeyVersion: null,
        v4TitleDigest: null, v4TitleDigestKeyId: null,
        v4BodyCiphertext: null, v4BodyKeyId: null, v4BodyKeyVersion: null,
        v4BodyDigest: null, v4BodyDigestKeyId: null, v4BodyPurgedAt: null,
        v22AssignmentId: assignmentId };
    },
  },
  amuxV22TaskQuestion: { updateMany: async () => ({ count: 1 }) },
  amuxV52ReviewRecord: { findMany: async () => [] },
  amuxV22WorkerAssignment: { findUnique: async () => ({
    id: assignmentId, authorizationAuditLogId: "assignment-audit", workItemId: taskId,
    taskRevision: 6, workerName: worker, workerInstanceId: instanceId, workerGeneration: 1,
    modelId: "claude-opus-5-5", role: "implement", grade: "advanced", provider: "anthropic",
    routeId: "route", routePolicyDigest: "d".repeat(64), catalogApprovalId: "catalog-one",
    catalogVersion: "v1", costReceiptDigest: "e".repeat(64), recoveryApprovalId: null,
    perAttemptMicroUsd: BigInt("3400000"),
  }) },
  adminAuditLog: { findUnique: async () => ({ action: "amux.v22.worker.assigned",
    targetId: assignmentId, metadata: { v52GradeRouting: false } }) },
  amuxExecutionAttempt: { findUnique: async () => ({ v22AssignmentId: assignmentId }) },
  engineeringAgentRun: { findUnique: async () => null },
  amuxWorkDelivery: {
    findFirst: async () => ({ attemptId, taskId }),
    updateMany: async () => ({ count: 1 }),
  },
};

const boundaries = new Proxy({}, { get: () => ({ prismaCallCeiling: 10 }) });
mock.module(mod("lib/amux/dbBoundary.ts"), { namedExports: {
  AMUX_DB_BOUNDARIES: boundaries,
  AmuxDbBoundaryError: class extends Error {},
  amuxBoundaryWithAttachment: (value: unknown) => value,
  amuxRouteOrchestratorReceiptsMayHaveCommitted: () => false,
  withAmuxDbBoundary: async (_value: unknown,
    work: (client: unknown, context: unknown) => Promise<unknown>) => work(tx, {
      dbNow: now, attachedTransaction: tx, requireLeaseAt: () => undefined,
    }),
} });
mock.module(mod("lib/adminAudit.ts"), { namedExports: {
  takeAuditChainLock: async () => {},
  writeSystemAuditLog: async (input: Record<string, unknown>) => { audits.push(input); return "audit-one"; },
} });
mock.module(mod("lib/amux/incident.ts"), { namedExports: {
  lockAmuxAdmissionAndReadIncident: async () => ({ blocks_admission: false }),
} });
mock.module(mod("lib/amux/v22LegacySafeStopFence.ts"), { namedExports: {
  amuxV22WorkerSafeStopFenced: async () => false,
} });
mock.module(mod("lib/amux/v22TaskRecoveryService.ts"), { namedExports: {
  readAmuxV22RecoveryAuthority: async () => null,
} });
mock.module(mod("lib/amux/ideaKeyStore.ts"), { namedExports: {
  loadAmuxContentKeyRing: async () => ({}),
} });
mock.module(mod("lib/amux/ideaCrypto.ts"), { namedExports: {
  openAmuxContent: (_sealed: unknown, purpose: string) => {
    if (purpose === "card_brief") return Buffer.from("Approved brief: continue the change.");
    throw new Error(`unexpected purpose ${purpose}`);
  },
  verifyAmuxContentDigest: () => true,
} });
// The two sources of the chunked files are the seam: rows in, opened text out.
mock.module(mod("lib/amux/v22OwnerQuestionService.ts"), { namedExports: {
  AMUX_V22_RESUME_ROWS_PRISMA_CALLS: 3,
  readAmuxV22ResumeRows: async () => resumed ? { question: { id: "question-one",
    attemptId: "attempt-two", state: "resumed", answerText: "Use Postgres.",
    answerSource: "operator" }, result: {}, patch: null } : null,
  openAmuxV22ResumeContext: async () => ({ questionId: "question-one",
    question: { question: "Which store?", unblocks: "the migration", options: [] },
    answer: "Use Postgres.", answerSource: "operator", previousPatch }),
} });
mock.module(mod("lib/amux/v22PriorConclusionService.ts"), { namedExports: {
  AMUX_V22_PRIOR_CONCLUSION_ROWS_PRISMA_CALLS: 3,
  readAmuxV22PriorConclusionRows: async () => priorEntries.length > 0 ?
    { taskId, self: {}, rows: [] } : null,
  openAmuxV22PriorConclusions: async () => priorEntries,
} });

const delivery = import(mod("lib/amux/delivery.ts"));
const localCli = () => import(mod("lib/amux/v22LocalCliFlowCore.ts"));
const conclusions = () => import(mod("lib/amux/v22ConclusionCore.ts"));
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");

async function pull(contextChunks: boolean | undefined) {
  audits = [];
  const result = await (await delivery).pullAmuxWorkDelivery({ worker, instanceId,
    generation: 1, now, ...(contextChunks === undefined ? {} : { contextChunks }) });
  assert.equal(result.available, true, JSON.stringify(result));
  if (!result.available) throw new Error("unreachable");
  return result.delivery;
}

async function embedded(prompt: string) {
  const { amuxV22ExtractContextFiles } = await localCli();
  return amuxV22ExtractContextFiles(prompt).files as Array<{ name: string; text: string }>;
}

const seed = (patchText: string | null) => {
  resumed = true;
  previousPatch = patchText;
  priorEntries = [{ label: "T-1 (investigate)", findings: "The index is the cause.",
    note: null }];
};

const expectedPrior = async () => {
  const { buildAmuxV22PriorConclusionSection } = await conclusions();
  return buildAmuxV22PriorConclusionSection({ entries: priorEntries, budgetBytes: null });
};

test("a pull that asks for chunks names the previous change and the prior conclusions and leaves them out of the prompt block", async () => {
  deliveryRow = {};
  const patchText = "diff --git a/é.ts b/é.ts\n+한글\n";
  seed(patchText);
  const got = await pull(true);
  const files = await embedded(got.prompt);
  assert.deepEqual(files.map((file) => file.name), ["brief.md", "owner-answer.md"]);
  assert.equal(got.prompt.includes(patchText), false);
  const prior = (await expectedPrior())!;
  assert.equal(got.prompt.includes(prior.section), false);
  // The worker is still told about both files, and the answer file still points at the patch.
  assert.ok(got.prompt.includes("- .amux/context/prior.patch: your previous run's change"));
  assert.ok(got.prompt.includes("- .amux/context/prior-conclusions.md: conclusions of the finished Tasks"));
  assert.ok(files[1]!.text.includes(".amux/context/prior.patch"));
  assert.deepEqual(got.contextParts, [
    { name: "prior.patch", bytes: Buffer.byteLength(patchText, "utf8"), sha256: sha256(Buffer.from(patchText, "utf8")) },
    { name: "prior-conclusions.md", bytes: Buffer.byteLength(prior.section, "utf8"), sha256: sha256(Buffer.from(prior.section, "utf8")) },
  ]);
  const receipt = audits.find((audit) => audit.action === "amux.delivery.receipt_issued");
  assert.equal((receipt?.metadata as Record<string, unknown>).prior_conclusion_digest, prior.digest);
});

test("a pull without the feature carries both files in the prompt block as before, with no parts", async () => {
  deliveryRow = {};
  const patchText = "diff --git a/x b/x\n+one\n";
  seed(patchText);
  for (const flag of [undefined, false]) {
    const got = await pull(flag);
    const files = await embedded(got.prompt);
    assert.deepEqual(files.map((file) => file.name),
      ["brief.md", "owner-answer.md", "prior.patch", "prior-conclusions.md"]);
    assert.equal(files[2]!.text, patchText);
    assert.equal(files[3]!.text, (await expectedPrior())!.section);
    assert.equal("contextParts" in got, false);
    const receipt = audits.find((audit) => audit.action === "amux.delivery.receipt_issued");
    assert.equal((receipt?.metadata as Record<string, unknown>).prior_conclusion_digest,
      (await expectedPrior())!.digest, "the receipt names the same digest with or without chunks");
  }
});

test("only the files the delivery carries become parts", async () => {
  deliveryRow = {};
  // Conclusions only: no resumed question, so no previous change.
  resumed = false;
  previousPatch = null;
  priorEntries = [{ label: "T-1", findings: "ok", note: null }];
  let got = await pull(true);
  assert.deepEqual(got.contextParts?.map((part: { name: string }) => part.name), ["prior-conclusions.md"]);
  // A resumed question whose run left no change: the answer file says so and no patch part.
  seed(null);
  priorEntries = [];
  got = await pull(true);
  assert.equal("contextParts" in got, false);
  assert.deepEqual((await embedded(got.prompt)).map((file) => file.name), ["brief.md", "owner-answer.md"]);
  // Nothing but the brief.
  resumed = false;
  got = await pull(true);
  assert.equal("contextParts" in got, false);
  assert.deepEqual((await embedded(got.prompt)).map((file) => file.name), ["brief.md"]);
});

test("a previous change past the old 32 MiB backstop is named, not embedded, and the prompt stays small", async () => {
  deliveryRow = {};
  const patchText = "+" + "x".repeat(33 * 1024 * 1024) + "\n";
  seed(patchText);
  const got = await pull(true);
  assert.ok(Buffer.byteLength(got.prompt, "utf8") < 64 * 1024);
  const part = got.contextParts?.find((item: { name: string }) => item.name === "prior.patch");
  assert.equal(part?.bytes, Buffer.byteLength(patchText, "utf8"));
  assert.equal(part?.sha256, sha256(Buffer.from(patchText, "utf8")));
});

test("a pull of a delivery still on its receipt lease names the same parts", async () => {
  const patchText = "diff --git a/y b/y\n+two\n";
  seed(patchText);
  deliveryRow = {};
  const first = await pull(true);
  deliveryRow = { status: "leased", receiptId: first.receiptId,
    leaseExpiresAt: new Date("2026-11-19T12:00:30.000Z") };
  const again = await pull(true);
  assert.equal(again.receiptId, first.receiptId);
  assert.deepEqual(again.contextParts, first.contextParts);
  assert.ok(again.contextParts && again.contextParts.length === 2);
});
