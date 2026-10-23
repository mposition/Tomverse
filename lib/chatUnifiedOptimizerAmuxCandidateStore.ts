import "server-only";

import { createHash } from "node:crypto";

import { z } from "zod";

import { AMUX_DELIVERY_COMPLETION_PRECEDENCE,
  AMUX_DELIVERY_COMPLETION_RULES, classifyApprovedExecutionBrief } from
  "@/lib/amux/deliveryPrompt";
import { openAmuxContent, verifyAmuxContentDigest } from
  "@/lib/amux/ideaCrypto";
import { loadAmuxContentUnitKeys } from "@/lib/amux/ideaKeyStore";
import { AMUX_V22_SEALED_DELIVERY_MARKER } from
  "@/lib/amux/v22TaskExecutionCore";
import { v22TaskResultIdeaId } from "@/lib/amux/v22TaskResultStore";
import { readChatUnifiedOptimizerAmuxSourcePin } from
  "@/lib/chatUnifiedOptimizerAmuxSourcePin";
import {
  acceptChatUnifiedOptimizerCandidateGenerationOutputForStore,
  prepareChatUnifiedOptimizerCandidateGenerationForStore,
  recordChatUnifiedOptimizerCandidateGeneration,
} from "@/lib/chatUnifiedOptimizerCandidateGenerationStore";
import { createChatUnifiedOptimizerPublicCollector } from
  "@/lib/chatUnifiedOptimizerPublicCollector";
import { CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH } from
  "@/lib/chatUnifiedOptimizerCandidateGeneration";
import { prisma } from "@/lib/prisma";

const VERSION = "chat-unified-optimizer-amux-candidate-v1";
const WORKER = "codex-impl";
const BRIEF_PREFIX = "CHAT-01 unified Router/Refiner candidate author v1.";
const V4_TASK_ID_ENV = "TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_V4_TASK_ID";
const TEST_TASK_ID_ENV = "TOMVERSE_CHAT_UNIFIED_OPTIMIZER_AMUX_TEST_TASK_ID";
const TEST_SOURCE_SYSTEM = "codex-conversation";
const CUID = /^c[a-z0-9]{24}$/;
type SourcePin = ReturnType<typeof readChatUnifiedOptimizerAmuxSourcePin>;
const inputSchema = z.object({
  attemptId: z.string().uuid(),
  worker: z.literal(WORKER),
  instanceId: z.string().uuid(),
  generation: z.number().int().positive(),
  taskRevision: z.number().int().nonnegative(),
  sourcePin: z.object({
    repositoryId: z.number().int().positive().safe(),
    commitSha: z.string().regex(/^[0-9a-f]{40}$/),
    blobSha: z.string().regex(/^[0-9a-f]{40}$/),
    sha256: z.string().regex(/^[0-9a-f]{64}$/),
  }).strict(),
  resultText: z.string().min(1).max(65_536),
  resultSha256: z.string().regex(/^[0-9a-f]{64}$/),
}).strict();

type Attempt = Readonly<{
  id: string;
  taskId: string;
  worker: string;
  workerInstanceId: string;
  workerGeneration: number;
  taskRevision: number;
  attemptNumber: number | null;
  v22AssignmentId: string | null;
  v22Assignment: Readonly<{
    workItemId: string;
    workerName: string;
    workerInstanceId: string;
    workerGeneration: number;
    role: string;
    recoveryApprovalId: string | null;
  }> | null;
  startedAt: Date;
  endedAt: Date | null;
  leaseExpiresAt: Date | null;
  outcome: string | null;
  toStatus: string | null;
  endedBy: string | null;
  delivery: Readonly<{
    attemptId: string;
    taskId: string;
    worker: string;
    workerInstanceId: string;
    workerGeneration: number;
    taskRevision: number;
    prompt: string;
    status: string;
    acknowledgedAt: Date | null;
  }> | null;
  task: Readonly<{
    title: string;
    description: string | null;
    kind: string;
    priority: string;
    sourceSystem: string | null;
    sourceKey: string | null;
    executionBrief: string | null;
    executionBriefDigest: string | null;
    cardType: string | null;
    taskRole: string | null;
    sourceSnapshot: unknown;
    v22AssignmentId: string | null;
    v4BriefCiphertext: Uint8Array | null;
    v4BriefKeyId: string | null;
    v4BriefKeyVersion: number | null;
    v4BriefDigest: string | null;
    v4BriefDigestKeyId: string | null;
    v4BriefPurgedAt: Date | null;
    status: string;
    owner: string | null;
    revision: number;
  }>;
}>;

const readAttempt = (attemptId: string): Promise<Attempt | null> =>
  prisma.amuxExecutionAttempt.findUnique({
    where: { id: attemptId },
    select: { id: true, taskId: true, worker: true, workerInstanceId: true,
      workerGeneration: true, taskRevision: true, startedAt: true,
      attemptNumber: true,
      v22AssignmentId: true,
      v22Assignment: { select: { workItemId: true, workerName: true,
        workerInstanceId: true, workerGeneration: true, role: true,
        recoveryApprovalId: true } },
      endedAt: true, leaseExpiresAt: true, outcome: true, toStatus: true,
      delivery: { select: { attemptId: true, taskId: true, worker: true,
        workerInstanceId: true, workerGeneration: true, taskRevision: true,
        prompt: true, status: true, acknowledgedAt: true } },
      endedBy: true, task: { select: { title: true, description: true,
        kind: true, priority: true, sourceSystem: true,
        sourceKey: true, executionBrief: true, executionBriefDigest: true,
        cardType: true, taskRole: true, sourceSnapshot: true,
        v22AssignmentId: true,
        v4BriefCiphertext: true, v4BriefKeyId: true,
        v4BriefKeyVersion: true, v4BriefDigest: true,
        v4BriefDigestKeyId: true, v4BriefPurgedAt: true,
        status: true, owner: true, revision: true } } },
  });

const hasSuccessorAttempt = async (taskId: string,
  taskRevision: number): Promise<boolean> =>
  !!(await prisma.amuxExecutionAttempt.findFirst({
    where: { taskId, taskRevision: { gt: taskRevision } },
    select: { id: true },
  }));

const unavailable = (): never => {
  throw new Error("optimizer_amux_candidate_unavailable");
};

/** The exact approved brief distinguishes candidate authorship from ordinary
 * CHAT-01 development. It includes only the pinned public development set.
 * Any wording change must bump the versioned prefix and requires a new card. */
export function chatUnifiedOptimizerAmuxCandidateBrief(pin: SourcePin): string {
  const parsed = inputSchema.shape.sourcePin.parse(pin);
  return [
    BRIEF_PREFIX,
    `Read only the public mposition/Tomverse file ${CHAT_UNIFIED_OPTIMIZER_PUBLIC_SET_PATH}.`,
    `Repository ID: ${parsed.repositoryId}.`,
    `Commit SHA: ${parsed.commitSha}.`,
    `Blob SHA: ${parsed.blobSha}.`,
    `Content SHA-256: ${parsed.sha256}.`,
    "Propose task guidance using only that public development set and its public fixture refs.",
    'Return exactly one JSON object with only "taskGuidance" (string) and "publicExampleRefs" (array of supplied public refs).',
    "Do not read or include hidden cases, judge reasons, private gates, budget data, model choices, prices, or credentials.",
    "A proposal grants no evaluation, promotion, product or payment authority.",
  ].join("\n");
}

const sourcePinMatches = (left: SourcePin, right: SourcePin) =>
  left.repositoryId === right.repositoryId &&
  left.commitSha === right.commitSha && left.blobSha === right.blobSha &&
  left.sha256 === right.sha256;

export const chatUnifiedOptimizerAmuxCandidateRequestId =
  (attemptId: string, stage: "generation" | "registration" | "claim" |
    "terminal"): string => {
  const hex = createHash("sha256").update(`${VERSION}:${stage}:${attemptId}`)
    .digest("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}` +
    `-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};

// Absence keeps the approved legacy CHAT-01 path available. A configured but
// invalid v4 pin is an unknown outcome: the bridge must halt settlement.
export const readChatUnifiedOptimizerAmuxV4TaskId = (): string | null => {
  const value = process.env[V4_TASK_ID_ENV];
  if (value === undefined) return null;
  if (!CUID.test(value))
    throw new Error("optimizer_amux_v4_task_pin_invalid");
  return value;
};

/** A separately sourced test card may replace the live CHAT-01 card only when
 * its exact AMUX CUID is pinned. It still requires the approved brief. */
export const readChatUnifiedOptimizerAmuxTestTaskId = (): string | null => {
  const value = process.env[TEST_TASK_ID_ENV];
  if (value === undefined) return null;
  if (!CUID.test(value))
    throw new Error("optimizer_amux_test_task_pin_invalid");
  return value;
};

const isV4Attempt = (attempt: Attempt, taskId: string | null): boolean =>
  !!taskId && attempt.taskId === taskId &&
  attempt.task.sourceSystem === "admin-idea-v4" &&
  attempt.task.cardType === "task";

const selectedV4TaskId = (ports: V4Ports): string | null =>
  ports.readV4TaskId ? ports.readV4TaskId() :
    readChatUnifiedOptimizerAmuxV4TaskId();

const selectedTestTaskId = (ports: V4Ports): string | null =>
  ports.readTestTaskId ? ports.readTestTaskId() :
    readChatUnifiedOptimizerAmuxTestTaskId();

type TaskSelection = Readonly<{ v4TaskId: string | null;
  testTaskId: string | null }>;
const selectedTask = (ports: V4Ports): TaskSelection => {
  const v4TaskId = selectedV4TaskId(ports);
  const testTaskId = selectedTestTaskId(ports);
  if (v4TaskId && testTaskId)
    throw new Error("optimizer_amux_task_pin_conflict");
  return Object.freeze({ v4TaskId, testTaskId });
};

const targetAttempt = (attempt: Attempt | null,
  selection: TaskSelection): attempt is Attempt =>
  !!attempt && attempt.worker === WORKER && (
    (selection.v4TaskId !== null &&
      isV4Attempt(attempt, selection.v4TaskId)) ||
    (selection.testTaskId !== null &&
      attempt.taskId === selection.testTaskId &&
      attempt.task.sourceSystem === TEST_SOURCE_SYSTEM &&
      /^[A-F0-9]{64}$/.test(attempt.task.sourceKey ?? "") &&
      !!attempt.task.sourceSnapshot &&
      typeof attempt.task.sourceSnapshot === "object" &&
      !Array.isArray(attempt.task.sourceSnapshot) &&
      (attempt.task.sourceSnapshot as Record<string, unknown>).agentId ===
        "amux-intake" &&
      attempt.task.kind === "code" &&
      !!attempt.task.executionBrief?.startsWith(BRIEF_PREFIX)) ||
    (selection.v4TaskId === null && selection.testTaskId === null &&
      attempt.task.sourceSystem === "tomverse_private_workboard" &&
      attempt.task.sourceKey === "CHAT-01" &&
      !!attempt.task.executionBrief?.startsWith(BRIEF_PREFIX)));

const readV4Brief = async (attempt: Attempt): Promise<string | null> => {
  const task = attempt.task;
  const ideaId = v22TaskResultIdeaId(task.sourceSnapshot);
  if (!ideaId || !task.v4BriefCiphertext || !task.v4BriefKeyId ||
      !task.v4BriefKeyVersion || !task.v4BriefDigest ||
      !task.v4BriefDigestKeyId || task.v4BriefPurgedAt !== null) return null;
  const keys = await loadAmuxContentUnitKeys({ ideaId,
    purpose: "card_brief", subjectId: attempt.taskId });
  let plain: Buffer | null = null;
  try {
    plain = openAmuxContent({ ciphertext: Buffer.from(task.v4BriefCiphertext),
      keyId: task.v4BriefKeyId, keyVersion: task.v4BriefKeyVersion },
      "card_brief", attempt.taskId, keys);
    return verifyAmuxContentDigest(plain, "card_brief", attempt.taskId,
      task.v4BriefDigest, task.v4BriefDigestKeyId, keys) ?
        plain.toString("utf8") : null;
  } finally { plain?.fill(0); keys.masterKey.fill(0); }
};

const readV4Result = async (attemptId: string): Promise<{
  taskId: string; sourceSha256: string; bodyPurgedAt: Date | null;
} | null> => prisma.amuxV22TaskResult.findUnique({ where: { attemptId },
  select: { taskId: true, sourceSha256: true, bodyPurgedAt: true } });

type V4Ports = Readonly<{ readV4TaskId?:
  typeof readChatUnifiedOptimizerAmuxV4TaskId;
  readTestTaskId?: typeof readChatUnifiedOptimizerAmuxTestTaskId;
  readV4Brief?: typeof readV4Brief; readV4Result?: typeof readV4Result }>;

const exactApprovedBrief = (attempt: Attempt,
  pin: SourcePin): boolean => {
  const approved = classifyApprovedExecutionBrief(
    attempt.task.executionBrief, attempt.task.executionBriefDigest);
  if (approved.state !== "verified" ||
      approved.brief !== chatUnifiedOptimizerAmuxCandidateBrief(pin))
    return false;
  const delivery = attempt.delivery;
  if (!delivery || delivery.attemptId !== attempt.id ||
      delivery.taskId !== attempt.taskId ||
      delivery.worker !== attempt.worker ||
      delivery.workerInstanceId !== attempt.workerInstanceId ||
      delivery.workerGeneration !== attempt.workerGeneration ||
      delivery.taskRevision !== attempt.taskRevision ||
      delivery.status !== "acknowledged" ||
      !(delivery.acknowledgedAt instanceof Date) ||
      !Number.isFinite(delivery.acknowledgedAt.getTime()) ||
      delivery.acknowledgedAt.getTime() < attempt.startedAt.getTime() ||
      (attempt.endedAt instanceof Date &&
        delivery.acknowledgedAt.getTime() > attempt.endedAt.getTime()))
    return false;
  if (!Number.isSafeInteger(attempt.attemptNumber) ||
      (attempt.attemptNumber ?? 0) <= 0) return false;
  const prefix = ["[Tomverse AMUX work]", `Task: ${attempt.taskId}`,
    `Title: ${attempt.task.title}`, `Kind: ${attempt.task.kind}`,
    `Priority: ${attempt.task.priority}`, `Worker: ${attempt.worker}`,
    `Execution attempt: ${attempt.id}`,
    `Attempt number: ${attempt.attemptNumber}`,
    `Task revision: ${attempt.taskRevision}`,
    `Approved execution brief digest: ${approved.digest}`, ""].join("\n");
  const suffix = ["", "", "Approved execution brief:", approved.brief, "",
    "Card description:", attempt.task.description?.trim() || "(no description)",
    "", AMUX_DELIVERY_COMPLETION_PRECEDENCE].join("\n");
  if (!delivery.prompt.startsWith(prefix) ||
      !delivery.prompt.endsWith(suffix)) return false;
  const middle = delivery.prompt.slice(prefix.length,
    delivery.prompt.length - suffix.length);
  const rules = `\n${AMUX_DELIVERY_COMPLETION_RULES.join("\n")}`;
  if (middle === rules) return true;
  if (!middle.endsWith(rules)) return false;
  return /^Previous outcome: (?:succeeded|failed|blocked|expired|unknown)\nPrevious status: (?:todo|review|done|blocked|cancelled|unknown)\n$/.test(
    middle.slice(0, -rules.length));
};

const approvedBrief = async (attempt: Attempt, pin: SourcePin,
  ports: V4Ports, selection: TaskSelection): Promise<boolean> => {
  if (!isV4Attempt(attempt, selection.v4TaskId))
    return exactApprovedBrief(attempt, pin);
  const delivery = attempt.delivery;
  if (attempt.task.executionBrief !== null ||
      attempt.task.executionBriefDigest !== null ||
      delivery?.prompt !== AMUX_V22_SEALED_DELIVERY_MARKER ||
      !attempt.v22AssignmentId ||
      attempt.v22AssignmentId !== attempt.task.v22AssignmentId ||
      !attempt.v22Assignment ||
      attempt.v22Assignment.workItemId !== attempt.taskId ||
      attempt.v22Assignment.workerName !== WORKER ||
      attempt.v22Assignment.workerInstanceId !== attempt.workerInstanceId ||
      attempt.v22Assignment.workerGeneration !== attempt.workerGeneration ||
      attempt.v22Assignment.role !== "implement" ||
      attempt.task.taskRole !== "implement" ||
      attempt.v22Assignment.recoveryApprovalId !== null ||
      delivery.attemptId !== attempt.id ||
      delivery.taskId !== attempt.taskId ||
      delivery.worker !== WORKER ||
      delivery.workerInstanceId !== attempt.workerInstanceId ||
      delivery.workerGeneration !== attempt.workerGeneration ||
      delivery.taskRevision !== attempt.taskRevision ||
      delivery.status !== "acknowledged" ||
      !(delivery.acknowledgedAt instanceof Date) ||
      !Number.isFinite(delivery.acknowledgedAt.getTime()) ||
      delivery.acknowledgedAt.getTime() < attempt.startedAt.getTime() ||
      (attempt.endedAt instanceof Date &&
        delivery.acknowledgedAt.getTime() > attempt.endedAt.getTime()))
    return false;
  try {
    return (await (ports.readV4Brief ?? readV4Brief)(attempt)) ===
      chatUnifiedOptimizerAmuxCandidateBrief(pin);
  } catch { return false; }
};

const activeAttempt = async (attempt: Attempt | null, now: Date,
  pin: SourcePin, ports: V4Ports, selection: TaskSelection): Promise<boolean> =>
  targetAttempt(attempt, selection) &&
  attempt.endedAt === null && !!attempt.leaseExpiresAt &&
  attempt.leaseExpiresAt.getTime() > now.getTime() &&
  attempt.task.status === "doing" &&
  attempt.task.owner === WORKER &&
  attempt.task.revision === attempt.taskRevision &&
  await approvedBrief(attempt, pin, ports, selection);

/** A finished or fenced candidate-author card remains a target. A normal
 * CHAT-01 development result is never interpreted as an optimizer proposal. */
export async function classifyChatUnifiedOptimizerAmuxCandidateAttempt(
  attemptId: string,
  ports: Readonly<{ readAttempt: typeof readAttempt; clock: () => Date;
    readPin: typeof readChatUnifiedOptimizerAmuxSourcePin }> & V4Ports =
    { readAttempt, clock: () => new Date(),
      readPin: readChatUnifiedOptimizerAmuxSourcePin },
): Promise<Readonly<{ target: boolean; eligible: boolean }>> {
  if (!z.string().uuid().safeParse(attemptId).success)
    return { target: false, eligible: false };
  const selection = selectedTask(ports);
  const attempt = await ports.readAttempt(attemptId);
  if (!targetAttempt(attempt, selection))
    return { target: false, eligible: false };
  let pin: SourcePin;
  try { pin = ports.readPin(); }
  catch { return { target: true, eligible: false }; }
  return { target: true,
    eligible: await activeAttempt(attempt, ports.clock(), pin, ports,
      selection) };
}

const acceptedAttempt = async (attempt: Attempt | null,
  input: z.infer<typeof inputSchema>, now: Date,
  pin: SourcePin, ports: V4Ports, selection: TaskSelection): Promise<boolean> =>
  sourcePinMatches(input.sourcePin, pin) &&
  await activeAttempt(attempt, now, pin, ports, selection) && !!attempt &&
  attempt.workerInstanceId === input.instanceId &&
  attempt.workerGeneration === input.generation &&
  attempt.taskRevision === input.taskRevision;

export async function readChatUnifiedOptimizerAmuxCandidateEligibility(
  attemptId: string,
): Promise<boolean> {
  return (await classifyChatUnifiedOptimizerAmuxCandidateAttempt(
    attemptId)).eligible;
}

/** The bridge writes a candidate before settling the AMUX card. A successor
 * cycle may start after its lease is gone, but only if the exact worker
 * attempt durably settled as successful review and was not requeued,
 * cancelled or reassigned. The coordinator re-reads this before every role. */
export async function readChatUnifiedOptimizerAmuxCandidateContinuation(
  attemptId: string,
  ports: Readonly<{ readAttempt: typeof readAttempt;
    hasSuccessorAttempt: typeof hasSuccessorAttempt;
    readPin: typeof readChatUnifiedOptimizerAmuxSourcePin }> & V4Ports =
    { readAttempt, hasSuccessorAttempt,
      readPin: readChatUnifiedOptimizerAmuxSourcePin },
): Promise<boolean> {
  if (!z.string().uuid().safeParse(attemptId).success) return false;
  const selection = selectedTask(ports);
  const attempt = await ports.readAttempt(attemptId);
  if (!targetAttempt(attempt, selection))
    return false;
  let pin: SourcePin;
  try { pin = ports.readPin(); }
  catch { return false; }
  if (!(await approvedBrief(attempt, pin, ports, selection) &&
    attempt.endedAt instanceof Date &&
    Number.isFinite(attempt.endedAt.getTime()) &&
    attempt.endedAt.getTime() >= attempt.startedAt.getTime() &&
    attempt.leaseExpiresAt === null && attempt.outcome === "succeeded" &&
    attempt.toStatus === "review" && attempt.endedBy === WORKER &&
    attempt.task.owner === null &&
    attempt.task.revision > attempt.taskRevision &&
    (attempt.task.status === "review" || attempt.task.status === "done")))
    return false;
  return !(await ports.hasSuccessorAttempt(attempt.taskId,
    attempt.taskRevision));
}

/** Receives only a JSON proposal from a live, fenced AMUX Codex author
 * attempt. IDs are derived from the attempt so a lost response cannot make
 * another cycle. This still records proposal validation, not verified worker
 * authorship: the AMUX result transport must supply that proof separately. */
export async function recordChatUnifiedOptimizerAmuxCandidate(
  raw: unknown,
  overrides: Readonly<Partial<{
    readAttempt: typeof readAttempt;
    collector: typeof createChatUnifiedOptimizerPublicCollector;
    clock: () => Date;
    readPin: typeof readChatUnifiedOptimizerAmuxSourcePin;
    record: typeof recordChatUnifiedOptimizerCandidateGeneration;
  }>> & V4Ports = {},
) {
  const ports = {
    readAttempt: overrides.readAttempt ?? readAttempt,
    collector: overrides.collector ?? createChatUnifiedOptimizerPublicCollector,
    clock: overrides.clock ?? (() => new Date()),
    readPin: overrides.readPin ?? readChatUnifiedOptimizerAmuxSourcePin,
    record: overrides.record ?? recordChatUnifiedOptimizerCandidateGeneration,
    readV4TaskId: overrides.readV4TaskId,
    readTestTaskId: overrides.readTestTaskId,
    readV4Brief: overrides.readV4Brief,
    readV4Result: overrides.readV4Result,
  };
  const parsed = inputSchema.safeParse(raw);
  if (!parsed.success) return unavailable();
  const input = parsed.data;
  const selection = selectedTask(ports);
  if (input.resultText.includes("\0") ||
      Buffer.byteLength(input.resultText, "utf8") > 65_536 ||
      createHash("sha256").update(input.resultText, "utf8").digest("hex") !==
        input.resultSha256) return unavailable();
  const initialPin = ports.readPin();
  const first = await ports.readAttempt(input.attemptId);
  if (!await acceptedAttempt(first, input, ports.clock(), initialPin, ports,
      selection))
    return unavailable();
  if (first && isV4Attempt(first, selection.v4TaskId)) {
    const result = await (ports.readV4Result ?? readV4Result)(first.id);
    if (!result || result.taskId !== first.taskId ||
        result.sourceSha256 !== input.resultSha256 ||
        result.bodyPurgedAt !== null) return unavailable();
  }
  const generationRequest =
    await prepareChatUnifiedOptimizerCandidateGenerationForStore({
      requestId: chatUnifiedOptimizerAmuxCandidateRequestId(input.attemptId,
        "generation"),
      authorTaskId: input.attemptId,
      sourcePin: input.sourcePin,
      collector: ports.collector({ repositoryId: input.sourcePin.repositoryId }),
    });
  const generation = acceptChatUnifiedOptimizerCandidateGenerationOutputForStore(
    generationRequest, input.resultText);
  const second = await ports.readAttempt(input.attemptId);
  const secondSelection = selectedTask(ports);
  if (!await acceptedAttempt(second, input, ports.clock(), ports.readPin(),
      ports, secondSelection) ||
      selection.v4TaskId !== secondSelection.v4TaskId ||
      selection.testTaskId !== secondSelection.testTaskId ||
      !first || !second ||
      second.taskId !== first.taskId ||
      second.startedAt.getTime() !== first.startedAt.getTime())
    return unavailable();
  if (isV4Attempt(second, selection.v4TaskId)) {
    const result = await (ports.readV4Result ?? readV4Result)(second.id);
    if (!result || result.taskId !== second.taskId ||
        result.sourceSha256 !== input.resultSha256 ||
        result.bodyPurgedAt !== null) return unavailable();
  }
  // AMUX heartbeats extend the lease. A cycle deadline derived from that
  // moving value would turn the same attempt into a conflicting registration.
  const deadlineAt = new Date(first.startedAt.getTime() + 24 * 60 * 60 * 1000);
  if (deadlineAt.getTime() <= ports.clock().getTime()) return unavailable();
  return ports.record({ generation,
    requestIds: { registration: chatUnifiedOptimizerAmuxCandidateRequestId(
      input.attemptId, "registration"),
      claim: chatUnifiedOptimizerAmuxCandidateRequestId(input.attemptId,
        "claim"),
      terminal: chatUnifiedOptimizerAmuxCandidateRequestId(input.attemptId,
        "terminal") },
    deadlineAt });
}
