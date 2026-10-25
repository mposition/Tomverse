import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { lockAmuxAdmissionAndReadIncident } from "@/lib/amux/incident";
import { loadAmuxContentKeyRing } from "@/lib/amux/ideaKeyStore";
import { openAmuxContent, verifyAmuxContentDigest,
  type AmuxContentKeys } from "@/lib/amux/ideaCrypto";
import { AMUX_V22_TASK_EXECUTION_ENV,
  AMUX_V22_SEALED_DELIVERY_MARKER,
  amuxV22TaskExecutionEnabled } from
  "@/lib/amux/v22TaskExecutionCore";
import { AMUX_V22_WORKER_AUTHORITY_NOTICE } from
  "@/lib/amux/v22ExternalAuthorityCore";
import { amuxV22WorkerSafeStopFenced } from
  "@/lib/amux/v22LegacySafeStopFence";
import { readAmuxV22RecoveryAuthority } from
  "@/lib/amux/v22TaskRecoveryService";
import { amuxV22ReadOnlyLaunchProofScope,
  amuxV22ReadOnlyLaunchScopeMatchesIntent,
  amuxV22ReadOnlyLaunchScopeSchema,
  currentAmuxV22ReadOnlyApiExecutionFrame } from
  "@/lib/amux/v22TaskRecoveryCore";
import { validateAmuxV22ReadOnlyRetryBinding,
  type AmuxV22ReadOnlyRetryBinding } from
  "@/lib/amux/v22ReadOnlyRetryProtocol.mjs";
import { AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
  amuxV22ReadOnlyApiExecutionFrameDigest,
  type AmuxV22ReadOnlyApiExecutionFrame } from
  "@/lib/amux/v22ReadOnlyApiProtocol.mjs";
import { amuxWorkerRuntimeHasExactCapability,
  amuxWorkerRuntimeUsesReadOnlyApi } from "@/lib/amux/workerRuntime";
import { formatAmuxV52ReviewScope } from "@/lib/amux/v52ReviewCore";
import { AMUX_TASK_ATTEMPT_BUDGET_MAX_MICROUSD } from "@/lib/amux/v4TaskCostAutoCatalogCore";

export const AMUX_DELIVERY_RECEIPT_LEASE_MS = 30_000;

type RuntimeLockRow = {
  workerName: string;
  instanceId: string;
  generation: number;
  status: string;
  dispatchReady: boolean;
  protocolCapabilities: string[];
  leaseExpiresAt: Date;
};

type AttemptLockRow = {
  id: string;
  taskId: string;
  worker: string;
  workerInstanceId: string;
  workerGeneration: number;
  taskRevision: number;
  leaseExpiresAt: Date | null;
  endedAt: Date | null;
};

type TaskLockRow = {
  id: string;
  owner: string | null;
  status: string;
  revision: number;
  archivedAt: Date | null;
};

type DeliveryLockRow = {
  runtimeLeaseExpiresAt: Date;
  attemptLeaseExpiresAt: Date;
  attemptId: string;
  v22AssignmentId: string | null;
  taskId: string;
  worker: string;
  workerInstanceId: string;
  workerGeneration: number;
  taskRevision: number;
  prompt: string;
  status: string;
  receiptId: string | null;
  leasedAt: Date | null;
  leaseExpiresAt: Date | null;
  acknowledgedAt: Date | null;
  cancelledAt: Date | null;
};

export type AmuxV22ReadOnlyApiRetryBinding = {
  version: 1;
  executorKind: "read_only_api_retry_v1";
  launchBindingId: string;
  riskAcceptanceDigest: string;
  safeStopEvidenceDigest: string;
  launchProofDigest: string;
  launchScopeDigest: string;
  launcherConfigDigest: string;
  apiExecutionFrame: AmuxV22ReadOnlyApiExecutionFrame;
  apiExecutionFrameDigest: string;
  briefDigest: string;
  provider: string;
  modelId: string;
  routeId: string;
  routePolicyDigest: string;
  catalogApprovalId: string;
  catalogVersion: string;
  pricingVersion: string;
  costReceiptDigest: string;
  additionalCapMicroUsd: string;
  worstExposureMicroUsd: string;
  role: "investigate";
};

export type AmuxV22ReadOnlyDeliveryBinding =
  | AmuxV22ReadOnlyRetryBinding
  | AmuxV22ReadOnlyApiRetryBinding;

const lockRuntime = async (
  tx: Prisma.TransactionClient,
  worker: string,
): Promise<RuntimeLockRow | null> => {
  const rows = await tx.$queryRaw<RuntimeLockRow[]>`
    SELECT
      "workerName",
      "instanceId",
      "generation",
      "status",
      "dispatchReady",
      "protocolCapabilities",
      "leaseExpiresAt"
    FROM "AmuxWorkerRuntime"
    WHERE "workerName" = ${worker}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const lockAttempt = async (
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<AttemptLockRow | null> => {
  const rows = await tx.$queryRaw<AttemptLockRow[]>`
    SELECT
      "id",
      "taskId",
      "worker",
      "workerInstanceId",
      "workerGeneration",
      "taskRevision",
      "leaseExpiresAt",
      "endedAt"
    FROM "AmuxExecutionAttempt"
    WHERE "id" = ${attemptId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const lockTask = async (
  tx: Prisma.TransactionClient,
  taskId: string,
): Promise<TaskLockRow | null> => {
  const rows = await tx.$queryRaw<TaskLockRow[]>`
    SELECT
      "id",
      "owner",
      "status",
      "revision",
      "archivedAt"
    FROM "AmuxWorkItem"
    WHERE "id" = ${taskId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const lockDelivery = async (
  tx: Prisma.TransactionClient,
  attemptId: string,
): Promise<DeliveryLockRow | null> => {
  const rows = await tx.$queryRaw<DeliveryLockRow[]>`
    SELECT
      "attemptId",
      "taskId",
      "worker",
      "workerInstanceId",
      "workerGeneration",
      "taskRevision",
      "prompt",
      "status",
      "receiptId",
      "leasedAt",
      "leaseExpiresAt",
      "acknowledgedAt",
      "cancelledAt"
    FROM "AmuxWorkDelivery"
    WHERE "attemptId" = ${attemptId}
    FOR UPDATE
  `;

  return rows[0] ?? null;
};

const runtimeMatches = (
  runtime: RuntimeLockRow | null,
  input: {
    worker: string;
    instanceId: string;
    generation: number;
  },
  now: Date,
) =>
  runtime !== null &&
  runtime.workerName === input.worker &&
  runtime.instanceId === input.instanceId &&
  runtime.generation === input.generation &&
  runtime.status === "busy" &&
  runtime.leaseExpiresAt.getTime() > now.getTime();

const attemptMatches = (
  attempt: AttemptLockRow | null,
  input: {
    attemptId: string;
    worker: string;
    instanceId: string;
    generation: number;
    taskRevision: number;
  },
  now: Date,
): attempt is AttemptLockRow =>
  attempt !== null &&
  attempt.id === input.attemptId &&
  attempt.worker === input.worker &&
  attempt.workerInstanceId === input.instanceId &&
  attempt.workerGeneration === input.generation &&
  attempt.taskRevision === input.taskRevision &&
  attempt.endedAt === null &&
  attempt.leaseExpiresAt !== null &&
  attempt.leaseExpiresAt.getTime() > now.getTime();

const taskMatches = (task: TaskLockRow | null, attempt: AttemptLockRow) =>
  task !== null &&
  task.id === attempt.taskId &&
  task.owner === attempt.worker &&
  task.status === "doing" &&
  task.revision === attempt.taskRevision &&
  task.archivedAt === null;

export type AmuxPulledDelivery =
  | {
      available: true;
      delivery: {
        attemptId: string;
        assignmentId: string | null;
        recoveryApprovalId?: string;
        taskId: string;
        worker: string;
        taskRevision: number;
        prompt: string;
        v22Execution: {
          modelId: string;
          role: string;
          budgetMicrousd: number;
          gradeGuard?: true;
          executionGrade?: string;
          reviewAuthor?: "claude";
          reviewAuthorVendor?: string;
          reviewScope?: string;
          reviewFeedbackJobId?: string;
          readOnlyRetry?: AmuxV22ReadOnlyDeliveryBinding;
        } | null;
        receiptId: string;
        leaseExpiresAt: Date;
      };
    }
  | {
      available: false;
      reason: "none" | "runtime_not_ready" | "worker_safe_stop_fenced";
    };

export async function pullAmuxWorkDelivery(input: {
  worker: string;
  instanceId: string;
  generation: number;
  now?: Date;
}): Promise<AmuxPulledDelivery> {
  // Key-store I/O is outside the DB transaction. The locked row below must
  // still match this candidate; a race refuses delivery rather than opening
  // another Task's sealed brief with stale keys.
  const v22Enabled = amuxV22TaskExecutionEnabled(
    process.env[AMUX_V22_TASK_EXECUTION_ENV]);
  const { sealedCandidate, candidateCard } = v22Enabled ?
    await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.deliveryKeyRead, async (tx) => {
      const sealedCandidate = await tx.amuxWorkDelivery.findFirst({
        where: { worker: input.worker, prompt: AMUX_V22_SEALED_DELIVERY_MARKER,
          status: { in: ["queued", "leased"] }, acknowledgedAt: null,
          cancelledAt: null },
        orderBy: [{ createdAt: "asc" }, { attemptId: "asc" }],
        select: { attemptId: true, taskId: true },
      });
      const candidateCard = sealedCandidate ? await tx.amuxWorkItem.findUnique({
        where: { id: sealedCandidate.taskId },
        select: { sourceSnapshot: true,
          v22AcceptedAssignment: { select: { id: true, role: true,
            authorizationAuditLog: { select: { action: true, targetId: true,
              metadata: true } } } } },
      }) : null;
      return { sealedCandidate, candidateCard };
    }) : { sealedCandidate: null, candidateCard: null };
  const snapshot = candidateCard?.sourceSnapshot;
  const ideaId = snapshot && typeof snapshot === "object" &&
    !Array.isArray(snapshot) && typeof snapshot.ideaId === "string" ?
      snapshot.ideaId : null;
  const candidateAssignment = candidateCard?.v22AcceptedAssignment;
  const candidateAudit = candidateAssignment?.authorizationAuditLog;
  const needReviewKeys = candidateAssignment?.role === "implement" &&
    candidateAudit?.action === "amux.v22.worker.assigned" &&
    candidateAudit.targetId === candidateAssignment.id &&
    !!candidateAudit.metadata && typeof candidateAudit.metadata === "object" &&
    !Array.isArray(candidateAudit.metadata) &&
    (candidateAudit.metadata as Record<string, unknown>).v52GradeRouting === true;
  const briefKeys = sealedCandidate && ideaId ?
    await loadAmuxContentKeyRing([
      { ideaId, purpose: "card_brief", subjectId: sealedCandidate.taskId },
      ...(needReviewKeys ? [
        { ideaId, purpose: "card_title" as const,
          subjectId: sealedCandidate.taskId },
        { ideaId, purpose: "card_body" as const,
          subjectId: sealedCandidate.taskId },
      ] : []),
    ]) : null;
  const deliveryContent = async (tx: Prisma.TransactionClient,
    delivery: DeliveryLockRow, now: Date,
    protocolCapabilities: readonly string[]) => {
    if (delivery.prompt !== AMUX_V22_SEALED_DELIVERY_MARKER) {
      if (amuxWorkerRuntimeUsesReadOnlyApi(protocolCapabilities))
        throw new Error("ordinary delivery cannot use a read-only API runtime");
      return { prompt: delivery.prompt, v22Execution: null };
    }
    if (!v22Enabled) throw new Error("v22 sealed delivery is disabled");
    if (!briefKeys || sealedCandidate?.attemptId !== delivery.attemptId ||
        sealedCandidate.taskId !== delivery.taskId)
      throw new Error("v22 sealed delivery key binding changed");
    const card = await tx.amuxWorkItem.findUnique({
      where: { id: delivery.taskId },
      select: { sourceSystem: true, cardType: true,
        v4TitleCiphertext: true, v4TitleKeyId: true,
        v4TitleKeyVersion: true, v4TitleDigest: true,
        v4TitleDigestKeyId: true,
        v4BodyCiphertext: true, v4BodyKeyId: true,
        v4BodyKeyVersion: true, v4BodyDigest: true,
        v4BodyDigestKeyId: true, v4BodyPurgedAt: true,
        v4BriefCiphertext: true, v4BriefKeyId: true,
        v4BriefKeyVersion: true, v4BriefDigest: true,
        v4BriefDigestKeyId: true, v4BriefPurgedAt: true,
        v22AssignmentId: true },
    });
    const attempt = await tx.amuxExecutionAttempt.findUnique({
      where: { id: delivery.attemptId },
      select: { v22AssignmentId: true },
    });
    if (card?.sourceSystem !== "admin-idea-v4" ||
        card.cardType !== "task" || !card.v4BriefCiphertext ||
        !card.v4BriefKeyId || !card.v4BriefKeyVersion ||
        !card.v4BriefDigest || !card.v4BriefDigestKeyId ||
        card.v4BriefPurgedAt !== null ||
        !card.v22AssignmentId ||
        attempt?.v22AssignmentId !== card.v22AssignmentId)
      throw new Error("v22 sealed delivery is not assignment-bound");
    const assignment = await tx.amuxV22WorkerAssignment.findUnique({
      where: { id: card.v22AssignmentId },
      select: { id: true, workItemId: true, workerName: true,
        workerInstanceId: true, workerGeneration: true,
        modelId: true, role: true, grade: true, provider: true, routeId: true,
        routePolicyDigest: true, catalogApprovalId: true, catalogVersion: true,
        costReceiptDigest: true, recoveryApprovalId: true, taskRevision: true,
        authorizationAuditLogId: true,
        perAttemptMicroUsd: true },
    });
    const budgetMicrousd = Number(assignment?.perAttemptMicroUsd);
    if (assignment?.workItemId !== delivery.taskId ||
        assignment?.workerName !== delivery.worker ||
        assignment?.workerInstanceId !== delivery.workerInstanceId ||
        assignment?.workerGeneration !== delivery.workerGeneration ||
        !Number.isSafeInteger(budgetMicrousd) ||
        budgetMicrousd < 1 || budgetMicrousd > AMUX_TASK_ATTEMPT_BUDGET_MAX_MICROUSD)
      throw new Error("v22 delivery assignment profile is invalid");
    const assignmentAudit = await tx.adminAuditLog.findUnique({
      where: { id: assignment.authorizationAuditLogId },
      select: { action: true, targetId: true, metadata: true },
    });
    if (assignmentAudit?.action !== "amux.v22.worker.assigned" ||
        assignmentAudit.targetId !== assignment.id)
      throw new Error("v22 delivery assignment audit is invalid");
    const gradeGuard = !!assignmentAudit.metadata &&
      typeof assignmentAudit.metadata === "object" &&
      !Array.isArray(assignmentAudit.metadata) &&
      (assignmentAudit.metadata as Record<string, unknown>).v52GradeRouting === true;
    const recovery = assignment.recoveryApprovalId ?
      await readAmuxV22RecoveryAuthority(tx, delivery.taskId,
        assignment.taskRevision, assignment.recoveryApprovalId, now) : null;
    if (assignment.recoveryApprovalId && !recovery)
      throw new Error("v22 recovery delivery authority is unavailable");
    if (recovery?.riskAcceptanceId) {
      if (!amuxWorkerRuntimeHasExactCapability(protocolCapabilities,
        recovery.readOnlyExecutorKind))
        throw new Error("v22 recovery delivery runtime capability is invalid");
    } else if (amuxWorkerRuntimeUsesReadOnlyApi(protocolCapabilities)) {
      throw new Error("v22 ordinary delivery cannot use a read-only API runtime");
    }
    let readOnlyRetry: AmuxV22ReadOnlyDeliveryBinding | undefined;
    let recoveryApprovalId: string | undefined;
    if (recovery?.riskAcceptanceId) {
      const proof = recovery.launchProofId ? await tx.amuxV22ReadOnlyLaunchProof.findUnique({
        where: { id: recovery.launchProofId } }) : null;
      const check = proof ? await tx.amuxV22ReadOnlyLaunchCheck.findUnique({
        where: { id: proof.launchCheckId } }) : null;
      const scope = proof ? amuxV22ReadOnlyLaunchProofScope(proof.report) : null;
      const nominalScope = check ?
        amuxV22ReadOnlyLaunchScopeSchema.safeParse(check.launchScope) : null;
      if (!check || !scope || !nominalScope?.success ||
          !amuxV22ReadOnlyLaunchScopeMatchesIntent(
            nominalScope.data, scope.launchScope) ||
          scope.launchScopeDigest !== recovery.launchScopeDigest ||
          recovery.id !== assignment.recoveryApprovalId ||
          recovery.workerName !== assignment.workerName ||
          recovery.provider !== assignment.provider || recovery.modelId !== assignment.modelId ||
          recovery.routeId !== assignment.routeId ||
          recovery.routePolicyDigest !== assignment.routePolicyDigest ||
          recovery.catalogApprovalId !== assignment.catalogApprovalId ||
          recovery.catalogVersion !== assignment.catalogVersion ||
          recovery.costReceiptDigest !== assignment.costReceiptDigest ||
          recovery.briefDigest !== card.v4BriefDigest ||
          recovery.additionalCapMicroUsd !== assignment.perAttemptMicroUsd)
        throw new Error("v22 read-only retry delivery binding is invalid");
      const common = {
        version: 1 as const, launchBindingId: recovery.launchBindingId!,
        riskAcceptanceDigest: recovery.riskAcceptanceDigest!,
        safeStopEvidenceDigest: recovery.evidenceDigest,
        launchProofDigest: recovery.launchProofDigest!,
        launchScopeDigest: recovery.launchScopeDigest!,
        launcherConfigDigest: scope.launchScope.launcherConfigDigest,
        briefDigest: recovery.briefDigest!, provider: recovery.provider!,
        modelId: recovery.modelId!, routeId: recovery.routeId!,
        routePolicyDigest: recovery.routePolicyDigest!,
        catalogApprovalId: recovery.catalogApprovalId,
        catalogVersion: recovery.catalogVersion,
        pricingVersion: recovery.pricingVersion,
        costReceiptDigest: recovery.costReceiptDigest,
        additionalCapMicroUsd: recovery.additionalCapMicroUsd.toString(),
        worstExposureMicroUsd: recovery.worstExposureMicroUsd.toString(),
        role: "investigate" as const,
      };
      if (recovery.readOnlyExecutorKind === AMUX_V22_READ_ONLY_API_EXECUTOR_KIND) {
        const frame = currentAmuxV22ReadOnlyApiExecutionFrame(
          recovery.apiExecutionFrame, { now });
        const frameDigest = frame ?
          amuxV22ReadOnlyApiExecutionFrameDigest(frame) : null;
        if (!("executorKind" in scope.launchScope) || !frame ||
            frameDigest !== scope.launchScope.apiExecutionFrameDigest ||
            recovery.launcherConfigDigest !== scope.launchScope.launcherConfigDigest)
          throw new Error("v22 read-only API delivery binding is invalid");
        readOnlyRetry = { ...common,
          executorKind: AMUX_V22_READ_ONLY_API_EXECUTOR_KIND,
          apiExecutionFrame: frame, apiExecutionFrameDigest: frameDigest };
      } else {
        if ("executorKind" in scope.launchScope)
          throw new Error("v22 read-only retry protocol binding is invalid");
        readOnlyRetry = { ...common,
          launcherPolicyVersion: scope.launchScope.launcherPolicyVersion,
          fixedArgvDigest: scope.launchScope.fixedArgvDigest,
          toolPolicyDigest: scope.launchScope.toolPolicyDigest,
          profileConfigDigest: scope.launchScope.profileConfigDigest };
        if (!validateAmuxV22ReadOnlyRetryBinding(readOnlyRetry).ok)
          throw new Error("v22 read-only retry protocol binding is invalid");
      }
      recoveryApprovalId = recovery.id;
    }
    let plain: Buffer | null = null;
    let title: Buffer | null = null;
    let body: Buffer | null = null;
    try {
      plain = openAmuxContent({
        ciphertext: Buffer.from(card.v4BriefCiphertext),
        keyId: card.v4BriefKeyId,
        keyVersion: card.v4BriefKeyVersion,
      }, "card_brief", delivery.taskId, briefKeys as AmuxContentKeys);
      if (!verifyAmuxContentDigest(plain, "card_brief", delivery.taskId,
        card.v4BriefDigest, card.v4BriefDigestKeyId, briefKeys as AmuxContentKeys))
        throw new Error("v22 sealed delivery digest mismatch");
      let reviewScope: string | undefined;
      let reviewFeedbackJobId: string | undefined;
      if (gradeGuard && assignment.role === "implement") {
        if (!card.v4TitleCiphertext || !card.v4TitleKeyId ||
            !card.v4TitleKeyVersion || !card.v4TitleDigest ||
            !card.v4TitleDigestKeyId || !card.v4BodyCiphertext ||
            !card.v4BodyKeyId || !card.v4BodyKeyVersion ||
            !card.v4BodyDigest || !card.v4BodyDigestKeyId ||
            card.v4BodyPurgedAt !== null)
          throw new Error("v52 review scope unavailable");
        title = openAmuxContent({ ciphertext: Buffer.from(card.v4TitleCiphertext),
          keyId: card.v4TitleKeyId, keyVersion: card.v4TitleKeyVersion },
          "card_title", delivery.taskId, briefKeys as AmuxContentKeys);
        body = openAmuxContent({ ciphertext: Buffer.from(card.v4BodyCiphertext),
          keyId: card.v4BodyKeyId, keyVersion: card.v4BodyKeyVersion },
          "card_body", delivery.taskId, briefKeys as AmuxContentKeys);
        if (!verifyAmuxContentDigest(title, "card_title", delivery.taskId,
          card.v4TitleDigest, card.v4TitleDigestKeyId, briefKeys as AmuxContentKeys) ||
            !verifyAmuxContentDigest(body, "card_body", delivery.taskId,
              card.v4BodyDigest, card.v4BodyDigestKeyId, briefKeys as AmuxContentKeys))
          throw new Error("v52 review scope digest mismatch");
        const decoded = JSON.parse(body.toString("utf8")) as
          { completionCriteria?: unknown };
        const titleText = title.toString("utf8").trim();
        const criteria = decoded?.completionCriteria;
        if (!titleText || titleText.length > 500 ||
            /[\u0000-\u001f]/.test(titleText) ||
            !Array.isArray(criteria) || criteria.length < 1 ||
            criteria.length > 12 || criteria.some((item) =>
              typeof item !== "string" || !item.trim() ||
              item.length > 500))
          throw new Error("v52 review scope invalid");
        reviewScope = formatAmuxV52ReviewScope(titleText, criteria);
        const prior = await tx.amuxV52ReviewRecord.findFirst({
          where: { taskId: delivery.taskId },
          orderBy: [{ createdAt: "desc" }, { attemptId: "desc" }],
          select: { jobId: true, verdict: true },
        });
        reviewFeedbackJobId = prior?.verdict === "reject" ?
          prior.jobId ?? undefined : undefined;
      }
      return {
        prompt: `Task: ${delivery.taskId}\nExecution attempt: ${delivery.attemptId}\n` +
          `${AMUX_V22_WORKER_AUTHORITY_NOTICE}\n` +
          `Approved execution brief:\n${plain.toString("utf8")}\n\n` +
          AMUX_V22_WORKER_AUTHORITY_NOTICE,
        v22Execution: { modelId: assignment.modelId, role: assignment.role,
          budgetMicrousd, ...(gradeGuard ? { gradeGuard: true as const,
            executionGrade: assignment.grade,
            ...(reviewScope ? {
              // The approved v22 one-shot catalog uses the fixed Claude CLI.
              reviewAuthor: "claude" as const,
              reviewAuthorVendor: assignment.provider,
              reviewScope,
              ...(reviewFeedbackJobId ? { reviewFeedbackJobId } : {}) } : {}),
          } : {}),
          ...(readOnlyRetry ? { readOnlyRetry } : {}) },
        recoveryApprovalId,
      };
    } finally { plain?.fill(0); title?.fill(0); body?.fill(0); }
  };
  return withAmuxDbBoundary(
    { ...AMUX_DB_BOUNDARIES.deliveryPull,
      // + 3: the admission lock and incident read, and the safe-stop fence.
      // + 7: an approved recovery delivery re-reads its authority (approval,
      // approval audit, risk acceptance, launch proof and launch check) and
      // the proof and check it binds into the delivery.
      // + 3: the base counts the canonical audit as one call, but appending it
      // takes four (chain lock, clock, previous entry, insert). A recovery
      // delivery makes 22 calls; 19 refused it on 2026-10-15 at the 20th.
      prismaCallCeiling: AMUX_DB_BOUNDARIES.deliveryPull.prismaCallCeiling + 3 + 7 + 3 + 1 },
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      // Safe-stop request and all ownership/start/delivery writers share this
      // global-first order. An existing row cannot be re-leased after its
      // physical profile has been permanently fenced.
      await lockAmuxAdmissionAndReadIncident(tx, now);
      if (await amuxV22WorkerSafeStopFenced(tx, input.worker)) {
        return { available: false as const,
          reason: "worker_safe_stop_fenced" as const };
      }
      const runtime = await lockRuntime(tx, input.worker);
      if (!runtimeMatches(runtime, input, now)) {
        return {
          available: false as const,
          reason: "runtime_not_ready" as const,
        };
      }

      const rows = await tx.$queryRaw<DeliveryLockRow[]>`
      SELECT
        r."leaseExpiresAt" AS "runtimeLeaseExpiresAt",
        a."leaseExpiresAt" AS "attemptLeaseExpiresAt",
        a."v22AssignmentId",
        d."attemptId",
        d."taskId",
        d."worker",
        d."workerInstanceId",
        d."workerGeneration",
        d."taskRevision",
        d."prompt",
        d."status",
        d."receiptId",
        d."leasedAt",
        d."leaseExpiresAt",
        d."acknowledgedAt",
        d."cancelledAt"
      FROM "AmuxWorkerRuntime" r
      JOIN "AmuxWorkDelivery" d
        ON d."worker" = r."workerName"
       AND d."workerInstanceId" = r."instanceId"
       AND d."workerGeneration" = r."generation"
      JOIN "AmuxExecutionAttempt" a
        ON a."id" = d."attemptId"
       AND a."taskId" = d."taskId"
       AND a."worker" = d."worker"
       AND a."workerInstanceId" = d."workerInstanceId"
       AND a."workerGeneration" = d."workerGeneration"
       AND a."taskRevision" = d."taskRevision"
      JOIN "AmuxWorkItem" t
        ON t."id" = d."taskId"
       AND t."owner" = d."worker"
       AND t."revision" = d."taskRevision"
      WHERE r."workerName" = ${input.worker}
        AND r."instanceId" = ${input.instanceId}
        AND r."generation" = ${input.generation}
        AND r."status" = 'busy'
        AND r."leaseExpiresAt" > ${now}
        AND a."endedAt" IS NULL
        AND a."leaseExpiresAt" > ${now}
        AND t."status" = 'doing'
        AND t."archivedAt" IS NULL
        AND d."status" IN ('queued', 'leased')
        AND d."acknowledgedAt" IS NULL
        AND d."cancelledAt" IS NULL
      ORDER BY d."createdAt" ASC, d."attemptId" ASC
      LIMIT 1
      FOR UPDATE OF r, d, a, t SKIP LOCKED
    `;
      const delivery = rows[0] ?? null;

      if (!delivery) {
        return {
          available: false as const,
          reason: "none" as const,
        };
      }
      const content = await deliveryContent(tx, delivery, now,
        runtime?.protocolCapabilities ?? []);

      /*
       * A retry while the receipt lease is still live is idempotent: return
       * exactly the same receipt and deadline without mutating the row.
       *
       * Keep the guards directly on the branch so TypeScript preserves the
       * non-null receipt/deadline narrowing in the returned delivery.
       */
      if (
        delivery.status === "leased" &&
        delivery.receiptId !== null &&
        delivery.leaseExpiresAt !== null &&
        delivery.leaseExpiresAt.getTime() > now.getTime()
      ) {
        context.requireLeaseAt(delivery.runtimeLeaseExpiresAt);
        context.requireLeaseAt(delivery.attemptLeaseExpiresAt);
        context.requireLeaseAt(delivery.leaseExpiresAt);
        const receiptId = delivery.receiptId;
        const leaseExpiresAt = delivery.leaseExpiresAt;

        return {
          available: true as const,
          delivery: {
            attemptId: delivery.attemptId,
            assignmentId: delivery.v22AssignmentId,
            ...(content.recoveryApprovalId ?
              { recoveryApprovalId: content.recoveryApprovalId } : {}),
            taskId: delivery.taskId,
            worker: delivery.worker,
            taskRevision: delivery.taskRevision,
            prompt: content.prompt,
            v22Execution: content.v22Execution,
            receiptId,
            leaseExpiresAt,
          },
        };
      }

      /*
       * Queued work, or an expired receipt lease, gets a fresh receipt.
       * The old receipt must never become valid again.
       */
      const receiptId = randomUUID();
      const deliveryLeaseExpiresAt = new Date(
        now.getTime() + AMUX_DELIVERY_RECEIPT_LEASE_MS,
      );

      const leased = await tx.amuxWorkDelivery.updateMany({
        where: {
          attemptId: delivery.attemptId,
          status: delivery.status,
          receiptId: delivery.receiptId,
          leaseExpiresAt: delivery.leaseExpiresAt,
        },
        data: {
          status: "leased",
          receiptId,
          leasedAt: now,
          leaseExpiresAt: deliveryLeaseExpiresAt,
        },
      });

      if (leased.count !== 1) {
        return {
          available: false as const,
          reason: "none" as const,
        };
      }

      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.delivery.receipt_issued",
        targetType: "AmuxWorkItem",
        targetId: delivery.taskId,
        summary: "Issued a fenced AMUX delivery receipt.",
        metadata: {
          attempt_id: delivery.attemptId,
          receipt_id: receiptId,
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: delivery.taskRevision,
        },
        tx,
      });

      context.requireLeaseAt(delivery.runtimeLeaseExpiresAt);
      context.requireLeaseAt(delivery.attemptLeaseExpiresAt);
      return {
        available: true as const,
        delivery: {
          attemptId: delivery.attemptId,
          assignmentId: delivery.v22AssignmentId,
          ...(content.recoveryApprovalId ?
            { recoveryApprovalId: content.recoveryApprovalId } : {}),
          taskId: delivery.taskId,
          worker: delivery.worker,
          taskRevision: delivery.taskRevision,
          prompt: content.prompt,
          v22Execution: content.v22Execution,
          receiptId,
          leaseExpiresAt: deliveryLeaseExpiresAt,
        },
      };
    },
  );
}
export async function acknowledgeAmuxWorkDelivery(input: {
  attemptId: string;
  receiptId: string;
  worker: string;
  instanceId: string;
  generation: number;
  taskRevision: number;
  now?: Date;
}): Promise<
  | {
      acknowledged: true;
      idempotent: boolean;
    }
  | {
      acknowledged: false;
      reason: "fenced_out";
    }
> {
  return withAmuxDbBoundary(
    AMUX_DB_BOUNDARIES.deliveryAck,
    async (tx, context) => {
      const now = input.now ?? context.dbNow;
      const runtime = await lockRuntime(tx, input.worker);

      if (!runtimeMatches(runtime, input, now)) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const attempt = await lockAttempt(tx, input.attemptId);

      if (!attemptMatches(attempt, input, now)) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const task = await lockTask(tx, attempt.taskId);

      if (!taskMatches(task, attempt)) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const delivery = await lockDelivery(tx, input.attemptId);

      if (
        !delivery ||
        delivery.worker !== input.worker ||
        delivery.workerInstanceId !== input.instanceId ||
        delivery.workerGeneration !== input.generation ||
        delivery.taskRevision !== input.taskRevision ||
        delivery.receiptId !== input.receiptId
      ) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      if (delivery.status === "acknowledged") {
        return {
          acknowledged: true as const,
          idempotent: true,
        };
      }

      if (
        delivery.status !== "leased" ||
        delivery.leaseExpiresAt === null ||
        delivery.leaseExpiresAt.getTime() <= now.getTime()
      ) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      const receiptLeaseExpiresAt = delivery.leaseExpiresAt;

      const acknowledged = await tx.amuxWorkDelivery.updateMany({
        where: {
          attemptId: input.attemptId,
          status: "leased",
          receiptId: input.receiptId,
          leaseExpiresAt: receiptLeaseExpiresAt,
        },
        data: {
          status: "acknowledged",
          leaseExpiresAt: null,
          acknowledgedAt: now,
        },
      });

      if (acknowledged.count !== 1) {
        return {
          acknowledged: false as const,
          reason: "fenced_out" as const,
        };
      }

      await writeSystemAuditLog({
        systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
        action: "amux.delivery.acknowledged",
        targetType: "AmuxWorkItem",
        targetId: attempt.taskId,
        summary: `Acknowledged durable AMUX delivery ${input.attemptId}.`,
        metadata: {
          attempt_id: input.attemptId,
          receipt_id: input.receiptId,
          worker: input.worker,
          worker_instance_id: input.instanceId,
          worker_generation: input.generation,
          task_revision: input.taskRevision,
        },
        tx,
      });

      if (runtime === null || attempt.leaseExpiresAt === null) {
        throw new Error("AMUX delivery acknowledgement lease invariant lost");
      }
      context.requireLeaseAt(runtime.leaseExpiresAt);
      context.requireLeaseAt(attempt.leaseExpiresAt);
      context.requireLeaseAt(receiptLeaseExpiresAt);
      return {
        acknowledged: true as const,
        idempotent: false,
      };
    },
  );
}

export async function cancelPendingAmuxWorkDelivery(
  tx: Prisma.TransactionClient,
  attemptId: string,
  now: Date,
): Promise<number> {
  const cancelled = await tx.amuxWorkDelivery.updateMany({
    where: {
      attemptId,
      status: {
        in: ["queued", "leased"],
      },
    },
    data: {
      status: "cancelled",
      leaseExpiresAt: null,
      cancelledAt: now,
    },
  });

  return cancelled.count;
}
