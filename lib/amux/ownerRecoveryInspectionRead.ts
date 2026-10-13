import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "./dbBoundary.ts";
import { AMUX_RECOVERY_USAGE_DISPLAY_LIMIT, summarizeAmuxRecoveryUsage,
  type AmuxOwnerRecoveryInspection, type AmuxRecoveryInspectionIdentity } from
  "./ownerRecoveryInspectionCore.ts";

/** The existing read boundary supplies RepeatableRead, database time and its
 * final read fence. Four Prisma calls: setup, task projection, runtime, fence.
 * No result body, ciphertext, delivery prompt, audit or mutation is read/written. */
export async function readAmuxOwnerRecoveryInspection(identity: AmuxRecoveryInspectionIdentity) {
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.executionRecoveryRead, async (tx, context) => {
    const task = await tx.amuxWorkItem.findUnique({ where: { id: identity.taskId },
      select: { id: true, revision: true, status: true, cardType: true,
        executionAttempts: { orderBy: [{ taskRevision: "desc" }, { startedAt: "desc" }, { id: "desc" }], take: 1,
          select: { id: true, taskRevision: true, worker: true, workerInstanceId: true,
            workerGeneration: true, outcome: true, endedAt: true, heartbeatAt: true,
            leaseExpiresAt: true, reservedCostMicrousd: true, costConfirmed: true,
            settledCostMicrousd: true,
            delivery: { select: { status: true } },
            v22TaskResult: { select: { sourceSha256: true, bodyPurgedAt: true } },
            cliUsageEvents: { orderBy: [{ createdAt: "desc" }, { id: "desc" }],
              take: AMUX_RECOVERY_USAGE_DISPLAY_LIMIT + 1,
              select: { completeness: true, inputTokens: true, outputTokens: true } } } } } });
    if (!task || task.cardType !== "task") return { state: "not_found" as const };
    const attempt = task.executionAttempts[0] ?? null;
    if (task.revision !== identity.taskRevision || (attempt?.id ?? null) !== identity.attemptId)
      return { state: "changed" as const };
    const runtime = attempt ? await tx.amuxWorkerRuntime.findUnique({
      where: { workerName: attempt.worker }, select: { instanceId: true, generation: true,
        status: true, heartbeatAt: true, leaseExpiresAt: true } }) : null;
    const result = attempt?.v22TaskResult;
    const confirmed = attempt?.costConfirmed === true &&
      attempt.settledCostMicrousd !== null && attempt.settledCostMicrousd >= BigInt(0);
    const inspection: AmuxOwnerRecoveryInspection = {
      schemaVersion: 1, checkedAt: context.dbNow.toISOString(),
      task: { id: task.id, revision: task.revision, status: task.status },
      attempt: attempt ? { id: attempt.id, taskRevision: attempt.taskRevision,
        worker: attempt.worker, outcome: attempt.outcome,
        endedAt: attempt.endedAt?.toISOString() ?? null,
        heartbeatAt: attempt.heartbeatAt.toISOString(),
        leaseExpiresAt: attempt.leaseExpiresAt?.toISOString() ?? null } : null,
      result: { state: !result ? "not_recorded" : result.bodyPurgedAt ? "purged" : "stored",
        sha256: result?.sourceSha256 ?? null, bodyVerified: false },
      usage: summarizeAmuxRecoveryUsage((attempt?.cliUsageEvents ?? []).map((row) => ({
        completeness: row.completeness, inputTokens: row.inputTokens?.toString() ?? null,
        outputTokens: row.outputTokens?.toString() ?? null }))),
      cost: { reservedMaximumMicrousd: attempt?.reservedCostMicrousd.toString() ?? null,
        confirmed, settledMicrousd: confirmed ? attempt!.settledCostMicrousd!.toString() : null },
      deliveryStatus: attempt?.delivery?.status ?? null,
      runtime: { state: !runtime ? "not_recorded" :
        runtime.instanceId === attempt?.workerInstanceId && runtime.generation === attempt.workerGeneration
          ? "same_instance" : "different_instance",
        status: runtime?.status ?? null, heartbeatAt: runtime?.heartbeatAt.toISOString() ?? null,
        leaseExpiresAt: runtime?.leaseExpiresAt.toISOString() ?? null },
      ubuntuProcessVerified: false, recoveryAuthorized: false,
    };
    return { state: "ready" as const, inspection };
  });
}
