import "server-only";

import { randomInt } from "node:crypto";

import { takeAuditChainLock, writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { findOpenAmuxOrchestratorHalt } from "@/lib/amux/orchestratorHaltStore";
import { AMUX_V22_ENGINEERING_PUBLICATION_ENV,
  amuxV22EngineeringPublicationEnabled } from "@/lib/amux/v22TaskExecutionCore";
import { readAmuxV22PublicPrConsent } from "@/lib/amux/v22PublicPrConsent";
import { decideAmuxV22KeptResult } from "@/lib/amux/v22KeptResultCore";
import { readAmuxV22KeptResultCandidates, type AmuxV22KeptResultCandidate } from "@/lib/amux/v22KeptResultRead";
import { ENGINEERING_AGENT_LEGACY_HALTS_ENV, ENGINEERING_AGENT_POLICY_VERSION, engineeringAgentLegacyHalts,
  v22RunOutcomeForProduct } from "@/lib/engineeringAgentCore";
import {
  EngineeringAgentStoreRefusedError,
  endEngineeringAgentRun,
  engineeringAgentTransactionInAmux,
  readEngineeringAgentSwitches,
  recordEngineeringAgentRunStart,
  requireEngineeringAgentRunAdmission,
} from "@/lib/engineeringAgentStore";
import { v22PublishPreflightEligible } from "@/lib/engineeringAgentV22PublicationDecision";
import { openEngineeringAgentV22Product } from "@/lib/engineeringAgentV22ProductStore";
import { loadEngineeringAgentV22SettlementPatch } from "@/lib/engineeringAgentV22SettlementPatch";

/**
 * Publishes kept v22 results (owner decision 2026-11-15,
 * lib/amux/v22KeptResultCore.ts). Each round -- the engineering runner's, on
 * the observer route -- takes a few Tasks whose reviewed patch never had its
 * publication and, each in a transaction of its own, does what the run's
 * start and settlement would have done had publication been open: admits a
 * run for that attempt (halt, card hold and owner queue judged as at a start),
 * opens the same publication product settlement opens (a T1 run's draft whose
 * tier the Publisher reads next, which becomes a pull request or the owner's
 * T2 draft), and ends the run with that outcome. A card blocked after its
 * budget ran out goes back to review, where its pull request is what it waits
 * on. A refusal before any write leaves the result kept for the next round;
 * one after rolls the whole transaction back.
 *
 * Nothing here runs the Task again, spends an attempt, or writes to GitHub:
 * the Publisher publishes the product as it does every other.
 */

export const AMUX_V22_KEPT_RESULT_ROUND_LIMIT = 3;
export const AMUX_V22_KEPT_RESULT_PUBLISHED_ACTION = "amux.v22.kept_result.published";
const RUN_LEASE_MS = 10 * 60 * 1000;
/** A Task whose publication threw this many times in this process goes behind the others. */
const FAILURES_BEFORE_BEHIND = 3;
const failures = new Map<string, number>();

export type AmuxV22KeptResultOutcome = {
  taskId: string;
  attemptId: string;
  outcome: "published" | "waiting" | "moved" | "failed";
  reason?: string;
};

export const amuxV22KeptResultPublicationEnabled = (env: Record<string, string | undefined> = process.env) =>
  !engineeringAgentLegacyHalts(env[ENGINEERING_AGENT_LEGACY_HALTS_ENV]) &&
  amuxV22EngineeringPublicationEnabled(env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]);

type Patch = NonNullable<Awaited<ReturnType<typeof loadEngineeringAgentV22SettlementPatch>>>;

async function publishOne(candidate: AmuxV22KeptResultCandidate, patch: Patch): Promise<AmuxV22KeptResultOutcome> {
  const { taskId, attemptId } = candidate;
  return withAmuxDbBoundary({ ...AMUX_DB_BOUNDARIES.executionRecoveryWrite,
    // The run's admission and start, its product, its end and their audit
    // entries: each as at an execution start and settlement.
    prismaCallCeiling: AMUX_DB_BOUNDARIES.executionRecoveryWrite.prismaCallCeiling + 60 },
  async (tx, context) => {
    // AMUX's lock order: the attempt (shared: the run row's foreign key reads
    // it), the audit chain, then the card -- as a state mismatch's resolution
    // takes them -- and the engineering locks after every AMUX row.
    await tx.$queryRaw`SELECT "id" FROM "AmuxExecutionAttempt" WHERE "id" = ${attemptId} FOR SHARE`;
    await takeAuditChainLock(tx);
    await tx.$queryRaw`SELECT "id" FROM "AmuxWorkItem" WHERE "id" = ${taskId} FOR UPDATE`;
    const [again] = await readAmuxV22KeptResultCandidates(tx, 1, taskId);
    if (!again || again.attemptId !== attemptId || again.baseSha !== patch.baseSha || patch.taskId !== taskId) {
      return { taskId, attemptId, outcome: "moved" as const };
    }
    const engineeringTx = engineeringAgentTransactionInAmux(context.attachedTransaction);
    const switches = await readEngineeringAgentSwitches(engineeringTx);
    const verdict = decideAmuxV22KeptResult({
      publicationEnabled: amuxV22KeptResultPublicationEnabled() && v22PublishPreflightEligible({
        policyVersion: ENGINEERING_AGENT_POLICY_VERSION, patchPresent: true,
        publicationEnabled: amuxV22EngineeringPublicationEnabled(process.env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]) }),
      legacy: false,
      orchestratorHalted: (await findOpenAmuxOrchestratorHalt(tx)) !== null,
      publishAllowed: switches.publishAllowed,
      mode: switches.mode,
      consent: await readAmuxV22PublicPrConsent(taskId, tx),
      taskStatus: again.taskStatus,
    });
    if (!verdict.publish) return { taskId, attemptId, outcome: "waiting" as const, reason: verdict.reason };
    try {
      // As at an execution start: the switches, every halt, this card's own
      // hold and both owner queues, before anything is written.
      await requireEngineeringAgentRunAdmission(engineeringTx, { cardId: taskId });
    } catch (error) {
      if (!(error instanceof EngineeringAgentStoreRefusedError)) throw error;
      return { taskId, attemptId, outcome: "waiting" as const, reason: `run_admission_${error.code}` };
    }
    if (verdict.moveToReview) {
      const moved = await tx.amuxWorkItem.updateMany({
        where: { id: taskId, status: "blocked", owner: null, archivedAt: null, v22AssignmentId: null },
        data: { status: "review", revision: { increment: 1 } },
      });
      if (moved.count !== 1) throw new Error("AMUX task changed while publishing its kept result");
    }
    const runId = String(randomInt(100_000_000_000, 1_000_000_000_000));
    const started = await recordEngineeringAgentRunStart(engineeringTx, {
      runId, amuxAttemptId: attemptId, cardId: taskId, cardKind: again.cardKind,
      baseSha: patch.baseSha, leaseMs: RUN_LEASE_MS,
    });
    // The database records the mode the run started under; it was read above
    // in this transaction, so a different one means the switches moved.
    if (started.modeAtStart !== switches.mode) throw new Error("engineering mode changed while publishing a kept result");
    const product = await openEngineeringAgentV22Product(engineeringTx, {
      runId, patch: { text: patch.text, sha256: patch.sha256, baseSha: patch.baseSha },
      tierPending: verdict.tierPending,
    });
    await endEngineeringAgentRun(engineeringTx, {
      runId, amuxAttemptId: attemptId,
      outcome: v22RunOutcomeForProduct({ taskOutcome: "succeeded", productKind: product.kind }),
      halt: "none",
    });
    await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: AMUX_V22_KEPT_RESULT_PUBLISHED_ACTION,
      targetType: "AmuxWorkItem", targetId: taskId,
      summary: "Put a kept AMUX v22 result on its publication path.",
      metadata: { attemptId, runId, productId: product.id, productKind: product.kind,
        patchDigest: patch.sha256, baseSha: patch.baseSha, tierPending: verdict.tierPending,
        fromStatus: again.taskStatus, toStatus: verdict.moveToReview ? "review" : again.taskStatus },
    });
    return { taskId, attemptId, outcome: "published" as const };
  });
}

/**
 * One round: up to AMUX_V22_KEPT_RESULT_ROUND_LIMIT kept results, oldest
 * first, each on its own so one that cannot be published never holds the
 * rest. Off with ENGINEERING_AGENT_LEGACY_HALTS or with v22 publication off.
 */
export async function publishAmuxV22KeptResults(
  limit = AMUX_V22_KEPT_RESULT_ROUND_LIMIT,
): Promise<AmuxV22KeptResultOutcome[]> {
  if (!amuxV22KeptResultPublicationEnabled()) return [];
  const behind = new Set([...failures].filter(([, count]) => count >= FAILURES_BEFORE_BEHIND).map(([id]) => id));
  let read: AmuxV22KeptResultCandidate[];
  try {
    read = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.executionRecoveryRead,
      (tx) => readAmuxV22KeptResultCandidates(tx, Math.min(Math.max(limit, 1), 10) + behind.size));
  } catch (error) {
    // The round that carries it goes on; the next one reads again.
    console.warn(JSON.stringify({ subsystem: "amux", event: "v22_kept_result_read_failed",
      code: error instanceof Error ? error.name : "unknown" }));
    return [];
  }
  const ordered = [...read.filter((row) => !behind.has(row.taskId)), ...read.filter((row) => behind.has(row.taskId))]
    .slice(0, Math.min(Math.max(limit, 1), 10));
  const outcomes: AmuxV22KeptResultOutcome[] = [];
  for (const candidate of ordered) {
    try {
      // Decrypted outside the transaction, as settlement does; the transaction reads the row again.
      const patch = await loadEngineeringAgentV22SettlementPatch(candidate.attemptId);
      if (!patch) {
        outcomes.push({ taskId: candidate.taskId, attemptId: candidate.attemptId, outcome: "moved" });
        continue;
      }
      const outcome = await publishOne(candidate, patch);
      if (outcome.outcome === "published") failures.delete(candidate.taskId);
      outcomes.push(outcome);
    } catch (error) {
      failures.set(candidate.taskId, (failures.get(candidate.taskId) ?? 0) + 1);
      const code = error instanceof EngineeringAgentStoreRefusedError ? error.code :
        error instanceof Error ? error.name : "unknown";
      // Ids and a code only: a patch never goes in a log.
      console.warn(JSON.stringify({ subsystem: "amux", event: "v22_kept_result_publication_failed",
        taskId: candidate.taskId, attemptId: candidate.attemptId, code }));
      outcomes.push({ taskId: candidate.taskId, attemptId: candidate.attemptId, outcome: "failed", reason: code });
    }
  }
  return outcomes;
}
