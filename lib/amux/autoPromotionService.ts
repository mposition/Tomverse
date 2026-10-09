import "server-only";

import { randomUUID } from "node:crypto";
import type { Session } from "next-auth";
import type { Prisma } from "@prisma/client";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { adminAuditIntegrityKeys } from "@/lib/adminAuditIntegrityCore";
import {
  AMUX_AUTO_PROMOTER_AUDIT_ACTOR,
  SYSTEM_AUDIT_ACTOR_METADATA_KEY,
  auditRowActorKind,
} from "@/lib/adminAuditSystemActors";
import {
  BOARD_IMPORT_STATEMENT_TIMEOUT,
  BoardImportError,
  boardImportAuditEntryHashMatches,
  boardImportAuditKeysPresent,
} from "@/lib/amux/boardImportCore";
import {
  AmuxDbBoundaryError,
  amuxRouteHasBudgetForMs,
  anchorAmuxRouteDeadline,
  fenceAmuxRouteDeadline,
  lockAmuxRouteOrchestratorAdmission,
  markAmuxRouteOrchestratorReceiptsCommitting,
  type AmuxOrchestratorReceipt,
  type AmuxOrchestratorReceiptRecorder,
} from "@/lib/amux/dbBoundary";
import { isAmuxLateCommitError } from "@/lib/amux/commitDeadlineCore";
import {
  boardPromotionCardWrite,
  boardPromotionExecutionBriefDigest,
  boardPromotionItemBindingsDigest,
  type BoardPromotionItem,
} from "@/lib/amux/boardPromotionCore";
import { AMUX_INCIDENT_SETTING_KEY, parseAmuxIncidentSetting } from "@/lib/amux/incidentCore";
import {
  AUTO_AUDIT_KEYS,
  AUTO_COST_24H_MS,
  AUTO_COST_30D_MS,
  AUTO_EXPIRE_BATCH,
  AUTO_PROMOTION_APPLY_ENV,
  AUTO_PROMOTION_CODE_LATCH,
  AUTO_PROMOTION_POLICY_VERSION,
  AUTO_SYSTEM_ACTOR_ROW_ID,
  AUTO_UNKNOWN_BURST_MS,
  type AutoBoundConsumeRequest,
  type AutoConsumeRequest,
  type AutoGrantRequest,
  autoAuditMetadata,
  autoBoundItem,
  autoConsumeBindingAccepted,
  autoConsumeRequestIsBound,
  autoCostAccepted,
  autoGlobalWipAccepted,
  autoGraduationAccepted,
  autoGrantExpiresAt,
  autoGrantUsable,
  autoHaltRequired,
  autoPromotionApplyPermitted,
  autoReadbackCritical,
  autoSystemConsumeDigest,
  autoUnknownEvents,
  autoWorkerAdmitted,
  parseAutoConsumeRequest,
  parseAutoGrantRequest,
  parseAutoResumeRequest,
  AUTO_TICK_GRANT_ATTEMPTS,
  AUTO_TICK_SEQUENTIAL_TRANSACTIONS,
  AUTO_TICK_STATEMENT_TIMEOUT_MS,
  AUTO_TICK_TRANSACTION_MAX_MS,
  AUTO_TICK_TRANSACTION_MAX_WAIT_MS,
  AUTO_TICK_TRANSACTION_TIMEOUT_MS,
  AUTO_TRANSACTION_COMMIT_RESERVE_MS,
  autoTickCardSpecificRefusal,
  autoTransactionFailure,
  type AutoTransactionPhase,
} from "@/lib/amux/autoPromotionCore";
import { writeAutoPromoterAudit } from "@/lib/amux/autoPromotionSystemAudit";
import {
  RECOMMENDATION_EXPIRY_MS,
  RECOMMENDATION_LOCK_NAME,
  RECOMMENDATION_SCORING_VERSION,
  recommendationRowsDigest,
  type RecommendationRow,
} from "@/lib/amux/recommendationPoolCore";
import { recommendationSelectionLocked } from "@/lib/amux/recommendationPoolService";
import { prisma } from "@/lib/prisma";

/**
 * Limited automatic promotion writer.
 *
 * docs/policy/development-agent-orchestration.md: version 8 ("Limited
 * automatic promotion"), version 9 (code latch), version 15 ("자동 승격
 * 개정"). The owner route and the internal tick share one consume function, so
 * the halt, graduation, grant, card, filter, lifecycle, incident, dependency,
 * capacity, cost and global-cap checks are the same code on both paths.
 *
 * Grant and consume throw before a transaction unless the environment value
 * is exactly `enabled` and the code latch is true. Expiry and the owner's
 * resume only narrow or clear a stop, and are not behind that switch.
 * Nothing here reads an execution switch, starts a worker, or spends credits.
 */

const SHA256 = /^[a-f0-9]{64}$/;

const summaries: Record<string, string> = {
  "amux.auto_grant.prepared": "Recorded an AMUX auto-promotion grant.",
  "amux.auto_grant.expired": "Expired an AMUX auto-promotion grant.",
  "amux.auto_promotion.consumed": "Consumed an AMUX auto-promotion grant.",
  "amux.auto_promotion.outcome_unknown": "Recorded an unknown AMUX auto-promotion outcome.",
  "amux.auto_promotion.halted": "Halted AMUX auto-promotion.",
  "amux.auto_promotion.resumed": "Resumed AMUX auto-promotion.",
};

/** Who is acting. The system actor has no session and no request. */
export type AutoActor =
  | { kind: "human"; session: Session; request: Request }
  | { kind: "system" };

export const AUTO_SYSTEM_ACTOR: AutoActor = { kind: "system" };

export const autoHumanActor = (session: Session, request: Request): AutoActor => ({
  kind: "human",
  session,
  request,
});

const actorId = (session: Session): string => {
  const id = session.user?.id;
  if (!id) throw new BoardImportError("forbidden", 403);
  return id;
};

/** The value an actor column stores for this actor. */
const actorRowId = (actor: AutoActor): string =>
  actor.kind === "system" ? AUTO_SYSTEM_ACTOR_ROW_ID : actorId(actor.session);

const applyOpen = (): boolean =>
  autoPromotionApplyPermitted({
    envValue: process.env[AUTO_PROMOTION_APPLY_ENV],
    codeLatch: AUTO_PROMOTION_CODE_LATCH,
  });

const refuseClosed = () => {
  if (!applyOpen()) throw new BoardImportError("apply_disabled", 409);
};

const databaseNow = async (tx: Prisma.TransactionClient): Promise<Date> => {
  const rows = await tx.$queryRaw<Array<{ now: Date }>>`
    SELECT (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "now"
  `;
  const now = rows[0]?.now;
  const parsed = now instanceof Date ? now : new Date(now ?? Number.NaN);
  if (Number.isNaN(parsed.getTime())) throw new BoardImportError("audit_unbound", 500);
  return parsed;
};

/** The operation name a deadline refusal from this module carries. */
const AUTO_PROMOTION_DB_OPERATION = "auto_promotion";

type AutoTransactionLimits = { maxWaitMs: number; timeoutMs: number; statementTimeoutMs: number };

/** The owner's routes, as since version 8. They run outside any route budget. */
export const OWNER_TRANSACTION_LIMITS: AutoTransactionLimits = {
  maxWaitMs: 5_000,
  timeoutMs: 20_000,
  statementTimeoutMs: Number(BOARD_IMPORT_STATEMENT_TIMEOUT),
};

/** The system actor runs only from the internal tick, inside its route budget. */
export const TICK_TRANSACTION_LIMITS: AutoTransactionLimits = {
  maxWaitMs: AUTO_TICK_TRANSACTION_MAX_WAIT_MS,
  timeoutMs: AUTO_TICK_TRANSACTION_TIMEOUT_MS,
  statementTimeoutMs: AUTO_TICK_STATEMENT_TIMEOUT_MS,
};

const limitsFor = (actor: AutoActor): AutoTransactionLimits =>
  actor.kind === "system" ? TICK_TRANSACTION_LIMITS : OWNER_TRANSACTION_LIMITS;

/** The application per-transaction maximum. Not a database bound. */
const transactionMaxMs = (limits: AutoTransactionLimits): number =>
  limits.maxWaitMs + limits.timeoutMs + AUTO_TRANSACTION_COMMIT_RESERVE_MS;

/**
 * Whether the tick's route budget still covers `transactions` more tick
 * transactions: the next one and those it has to leave room for. Always true
 * outside a route budget.
 */
const tickHasRoomFor = (transactions: number): boolean =>
  amuxRouteHasBudgetForMs(transactions * AUTO_TICK_TRANSACTION_MAX_MS);

/**
 * One auto-promotion transaction under the queue lock.
 *
 * Inside a route budget (the internal tick) a transaction whose
 * per-transaction maximum no longer fits does not start, its first statement
 * after the timeout anchors the route's database-clock deadline, and its last
 * statement fences on it: one whose fence finds the deadline passed rolls back
 * (docs/policy/development-agent-orchestration.md, Phase A). The fence also
 * records the commit deadline, so a COMMIT that a stall pushes past it is
 * refused by the database with SQLSTATE AX001, which is a known rollback here
 * (`autoTransactionFailure` reads it before the phase). These transactions set
 * no idle-in-transaction timeout, so the gap before COMMIT is bounded only by
 * the transaction timeout, and what the check cannot cover is the commit
 * record's own write and flush after it. The owner's transactions carry no
 * route deadline and get no commit deadline.
 *
 * A failure is classified by where the transaction was
 * (`autoTransactionFailure`), not by its message: only a failure after the
 * callback returned, when the COMMIT may or may not have taken effect, is
 * `outcome_unknown`. Anything earlier rolled back, so a statement timeout is a
 * deadline refusal the caller may meet again next time, not a lost outcome that
 * refuses its grant for good and counts toward the halt rule.
 */
export const withAutoTransaction = async <T>(
  targetId: string | null,
  limits: AutoTransactionLimits,
  run: (
    tx: Prisma.TransactionClient,
    now: Date,
    recordReceipt: AmuxOrchestratorReceiptRecorder,
  ) => Promise<T>,
): Promise<T> => {
  if (!boardImportAuditKeysPresent(adminAuditIntegrityKeys(process.env).length)) {
    throw new BoardImportError("audit_key_missing", 503, targetId);
  }
  const maxMs = transactionMaxMs(limits);
  if (!amuxRouteHasBudgetForMs(maxMs)) {
    throw new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", AUTO_PROMOTION_DB_OPERATION);
  }
  let phase: AutoTransactionPhase = "starting";
  let forgetReceiptCommit: () => void = () => {};
  try {
    return await prisma.$transaction(
      async (tx) => {
        phase = "running";
        await tx.$executeRaw`SELECT set_config('statement_timeout', ${String(limits.statementTimeoutMs)}, true)`;
        const routeDeadlineAt = await anchorAmuxRouteDeadline(tx, maxMs, AUTO_PROMOTION_DB_OPERATION);
        // Orchestration policy version 20, section 4: inside the admitted
        // tick every transaction locks the admission row before it changes
        // anything, and refuses if the admission is already closed. The
        // owner's routes have no admission and lock nothing here.
        const admitted = await lockAmuxRouteOrchestratorAdmission(tx, AUTO_PROMOTION_DB_OPERATION);
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${RECOMMENDATION_LOCK_NAME}))`;
        const receipts: AmuxOrchestratorReceipt[] = [];
        const recordReceipt: AmuxOrchestratorReceiptRecorder = (targetKind, targetId, rowCount) => {
          if (admitted) receipts.push({ targetKind, targetId, rowCount });
        };
        const result = await run(tx, await databaseNow(tx), recordReceipt);
        // From the fence on, the receipts may reach COMMIT; the catch below
        // takes the mark back for every failure that proves they did not.
        if (receipts.length > 0) forgetReceiptCommit = markAmuxRouteOrchestratorReceiptsCommitting();
        await fenceAmuxRouteDeadline(tx, routeDeadlineAt, AUTO_PROMOTION_DB_OPERATION, receipts);
        // Nothing may run after this line inside the callback: from here on a
        // failure can only come from the COMMIT itself.
        phase = "committing";
        return result;
      },
      { maxWait: limits.maxWaitMs, timeout: limits.timeoutMs },
    );
  } catch (error) {
    // Receipts of a transaction that failed before COMMIT, or whose COMMIT the
    // commit deadline trigger refused, rolled back with the rest; any other
    // COMMIT failure may have committed them.
    // (`phase` is set inside the callback, which control-flow narrowing here
    // does not see.)
    if ((phase as AutoTransactionPhase) !== "committing" || isAmuxLateCommitError(error)) {
      forgetReceiptCommit();
    }
    // Refusals are thrown by the callback, so the transaction rolled back.
    if (error instanceof BoardImportError || error instanceof AmuxDbBoundaryError) throw error;
    switch (autoTransactionFailure(phase, error)) {
      case "outcome_unknown":
        throw new BoardImportError("outcome_unknown", 409, targetId);
      case "conflict":
        throw new BoardImportError("conflict", 409, targetId);
      case "deadline_exceeded":
        throw new AmuxDbBoundaryError("AMUX_DB_DEADLINE_EXCEEDED", AUTO_PROMOTION_DB_OPERATION);
      default:
        throw error;
    }
  }
};

/**
 * Reads back the entry just written and rolls the whole change back unless it
 * is bound: the action, target, actor, allowed metadata keys and a hash one
 * configured key reproduces. A human entry carries the session's id and no
 * system marker; a system entry carries no session field and the listed
 * `amux-auto-promoter` marker.
 */
const requireBoundAudit = async (
  tx: Prisma.TransactionClient,
  auditId: string,
  actor: AutoActor,
  expected: { action: string; targetType: string; targetId: string },
) => {
  const row = await tx.adminAuditLog.findUnique({
    where: { id: auditId },
    select: {
      actorUserId: true,
      actorEmail: true,
      action: true,
      targetType: true,
      targetId: true,
      summary: true,
      metadata: true,
      ipAddress: true,
      userAgent: true,
      previousHash: true,
      entryHash: true,
      createdAt: true,
    },
  });
  if (
    !row ||
    row.action !== expected.action ||
    row.targetType !== expected.targetType ||
    row.targetId !== expected.targetId ||
    typeof row.entryHash !== "string" ||
    !SHA256.test(row.entryHash) ||
    !(row.createdAt instanceof Date)
  ) {
    throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
  const metadataRow = row.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
    ? (row.metadata as Record<string, unknown>)
    : {};
  const marker = metadataRow[SYSTEM_AUDIT_ACTOR_METADATA_KEY];
  if (actor.kind === "human") {
    if (row.actorUserId !== actorId(actor.session) || marker !== undefined) {
      throw new BoardImportError("audit_unbound", 500, expected.targetId);
    }
  } else if (auditRowActorKind(row) !== "system" || marker !== AMUX_AUTO_PROMOTER_AUDIT_ACTOR) {
    throw new BoardImportError("audit_unbound", 500, expected.targetId);
  }
  for (const key of Object.keys(metadataRow)) {
    if (actor.kind === "system" && key === SYSTEM_AUDIT_ACTOR_METADATA_KEY) continue;
    if (!(AUTO_AUDIT_KEYS as readonly string[]).includes(key)) {
      throw new BoardImportError("audit_unbound", 500, expected.targetId);
    }
  }
  const hashMatches = boardImportAuditEntryHashMatches(
    {
      previousHash: row.previousHash,
      actorUserId: row.actorUserId,
      actorEmail: row.actorEmail,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId,
      summary: row.summary,
      metadata: row.metadata ?? null,
      ipAddress: row.ipAddress,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    },
    row.entryHash,
    adminAuditIntegrityKeys(process.env),
  );
  if (!hashMatches) throw new BoardImportError("audit_unbound", 500, expected.targetId);
};

const writeAutoAudit = async (
  tx: Prisma.TransactionClient,
  actor: AutoActor,
  action: string,
  targetType: string,
  targetId: string,
  metadata: Record<string, string | number | null>,
): Promise<string> => {
  const summary = summaries[action] ?? "Recorded an AMUX auto-promotion fact.";
  const auditId = actor.kind === "human"
    ? await writeAdminAuditLog({
      session: actor.session,
      request: actor.request,
      action,
      targetType,
      targetId,
      summary,
      metadata,
      tx,
    })
    : await writeAutoPromoterAudit(tx, { action, targetType, targetId, summary, metadata });
  await requireBoundAudit(tx, auditId, actor, { action, targetType, targetId });
  return auditId;
};

const humanDecisions = async (tx: Prisma.TransactionClient) =>
  tx.amuxRecommendationDecision.findMany({
    where: { decision: "approve", status: "consumed" },
    select: { createdAt: true },
  });

const costEntries = async (tx: Prisma.TransactionClient) =>
  tx.amuxRecommendationAutoCostEntry.findMany({ select: { amountCents: true, recordedAt: true } });

const openHalt = async (tx: Prisma.TransactionClient) =>
  tx.amuxRecommendationAutoHalt.findFirst({ where: { clearedAt: null }, select: { id: true } });

/** Halt first, then graduation: the two refusals that apply to every card. */
const requireAutoOpen = async (tx: Prisma.TransactionClient, targetId: string) => {
  const halted = await openHalt(tx);
  if (halted) throw new BoardImportError("auto_halted", 409, targetId);
  const graduation = autoGraduationAccepted(await humanDecisions(tx));
  if (!graduation.ok) throw new BoardImportError(graduation.code, 409, targetId);
};

type GrantRow = {
  id: string;
  workItemId: string;
  status: string;
  expiresAt: Date;
  itemBindings: Prisma.JsonValue | null;
  itemBindingsDigest: string | null;
  amountCents: number | null;
};

const GRANT_SELECT = {
  id: true,
  workItemId: true,
  status: true,
  expiresAt: true,
  itemBindings: true,
  itemBindingsDigest: true,
  amountCents: true,
} as const;

/**
 * Expires one due grant and records who did it. Writes the audit only when
 * the row actually moved, so an entry never claims an expiry that did not
 * happen.
 */
const expireGrantLocked = async (
  tx: Prisma.TransactionClient,
  now: Date,
  actor: AutoActor,
  grantId: string,
): Promise<boolean> => {
  const updated = await tx.amuxRecommendationAutoGrant.updateMany({
    where: { id: grantId, status: "active", expiresAt: { lte: now } },
    data: { status: "expired" },
  });
  if (updated.count !== 1) return false;
  await writeAutoAudit(
    tx,
    actor,
    "amux.auto_grant.expired",
    "AmuxRecommendationAutoGrant",
    grantId,
    autoAuditMetadata({ grantId }),
  );
  return true;
};

type ConsumeLockedInput = {
  actor: AutoActor;
  grant: GrantRow;
  item: BoardPromotionItem;
  amountCents: number;
  requireBound: boolean;
  consumptionId: string;
  requestDigest: string;
  /** `stored`: an owner's prepared snapshot. `system`: built here, in this transaction. */
  snapshot: { kind: "stored" | "system"; snapshotId: string };
};

/**
 * The one consume, after `requireAutoOpen`. Every refusal throws, so the
 * transaction rolls back and no card, grant, consumption or cost row moves.
 */
const consumeGrantLocked = async (tx: Prisma.TransactionClient, now: Date, input: ConsumeLockedInput) => {
  const { grant, item, consumptionId } = input;
  const snapshotId = input.snapshot.snapshotId;
  if (grant.workItemId !== item.cardId) throw new BoardImportError("grant_missing", 409, consumptionId);
  const usable = autoGrantUsable({ status: grant.status, expiresAt: grant.expiresAt, now });
  if (!usable.ok) throw new BoardImportError(usable.code, 409, consumptionId);
  const binding = autoConsumeBindingAccepted({
    binding: grant,
    item,
    amountCents: input.amountCents,
    requireBound: input.requireBound,
  });
  if (!binding.ok) throw new BoardImportError(binding.code, 409, consumptionId);
  // A lost outcome on this grant is read back, never tried again.
  const unknown = await tx.amuxRecommendationAutoUnknown.count({ where: { grantId: grant.id } });
  if (unknown > 0) throw new BoardImportError("grant_outcome_unknown", 409, consumptionId);
  const card = await tx.amuxWorkItem.findUnique({
    where: { id: item.cardId },
    select: {
      id: true,
      status: true,
      owner: true,
      claimedAt: true,
      archivedAt: true,
      revision: true,
      sourceDigest: true,
      executionBriefDigest: true,
    },
  });
  if (!card || card.status !== "backlog" || card.owner || card.claimedAt || card.archivedAt) {
    throw new BoardImportError("not_backlog", 409, consumptionId);
  }
  if (card.revision !== item.expectedRevision || card.sourceDigest !== item.sourceDigest) {
    throw new BoardImportError("conflict", 409, consumptionId);
  }
  const briefDigest = boardPromotionExecutionBriefDigest(item.executionBrief);
  let systemSelection: Awaited<ReturnType<typeof recommendationSelectionLocked>> | null = null;
  let systemRow: RecommendationRow | null = null;
  if (input.snapshot.kind === "stored") {
    const snapshotItem = await tx.amuxRecommendationSnapshotItem.findUnique({
      where: { snapshotId_workItemId: { snapshotId, workItemId: card.id } },
      select: { disposition: true, executionBriefDigest: true, sourceDigest: true },
    });
    if (!snapshotItem || snapshotItem.disposition !== "included" || snapshotItem.sourceDigest !== card.sourceDigest) {
      throw new BoardImportError("not_included", 409, consumptionId);
    }
    if (snapshotItem.executionBriefDigest !== card.executionBriefDigest) {
      throw new BoardImportError("brief_digest_changed", 409, consumptionId);
    }
  } else {
    // The version 7 filter, computed now under the same advisory lock. The
    // card has to be an included row of that selection, as it would have to
    // be in an owner's snapshot.
    systemSelection = await recommendationSelectionLocked(tx, now);
    systemRow = systemSelection.rows.find((row) => row.cardId === card.id) ?? null;
    if (!systemRow) throw new BoardImportError("not_included", 409, consumptionId);
    if (systemRow.disposition !== "included") {
      throw new BoardImportError(systemRow.exclusionCode ?? "not_included", 409, consumptionId);
    }
  }
  if (card.executionBriefDigest && card.executionBriefDigest !== briefDigest) {
    throw new BoardImportError("brief_digest_changed", 409, consumptionId);
  }
  const attempts = await tx.amuxExecutionAttempt.count({ where: { taskId: card.id } });
  const deliveries = await tx.amuxWorkDelivery.count({ where: { taskId: card.id } });
  const routes = await tx.amuxRouteDecision.count({ where: { taskId: card.id } });
  if (attempts > 0 || deliveries > 0 || routes > 0) throw new BoardImportError("lifecycle_present", 409, consumptionId);
  const incident = await tx.appSetting.findUnique({ where: { key: AMUX_INCIDENT_SETTING_KEY }, select: { value: true } });
  if (parseAmuxIncidentSetting(incident?.value).blocks_admission) {
    throw new BoardImportError("incident_blocked", 409, consumptionId);
  }
  const openDependency = await tx.amuxWorkDependency.count({
    where: {
      taskId: card.id,
      dependency: { OR: [{ status: { not: "done" } }, { archivedAt: { not: null } }] },
    },
  });
  if (openDependency > 0) throw new BoardImportError("dependency_open", 409, consumptionId);
  const capacity = await tx.amuxRecommendationCapacity.findUnique({ where: { id: "queue" } });
  const occupied = await tx.amuxWorkItem.count({
    where: { archivedAt: null, status: { in: ["todo", "doing"] } },
  });
  if (!capacity || !capacity.active || capacity.wipLimit === null) {
    throw new BoardImportError("capacity_unconfigured", 409, consumptionId);
  }
  if (occupied + 1 > capacity.wipLimit) throw new BoardImportError("capacity_full", 409, consumptionId);
  const entries = await costEntries(tx);
  const cost = autoCostAccepted({ proposedCents: input.amountCents, entries, now });
  if (!cost.ok) throw new BoardImportError(cost.code, 409, consumptionId);
  const active = await tx.amuxRecommendationAutoConsumption.count({
    where: { status: "consumed", workItem: { archivedAt: null, status: { in: ["todo", "doing"] } } },
  });
  const wip = autoGlobalWipAccepted(active);
  if (!wip.ok) throw new BoardImportError(wip.code, 409, consumptionId);

  const write = boardPromotionCardWrite(item);
  const updated = await tx.amuxWorkItem.updateMany({ where: write.where, data: write.data });
  if (updated.count !== 1) throw new BoardImportError("conflict", 409, consumptionId);
  const grantUpdate = await tx.amuxRecommendationAutoGrant.updateMany({
    where: { id: grant.id, status: "active" },
    data: { status: "consumed" },
  });
  if (grantUpdate.count !== 1) throw new BoardImportError("conflict", 409, consumptionId);
  const auditId = await writeAutoAudit(
    tx,
    input.actor,
    "amux.auto_promotion.consumed",
    "AmuxRecommendationAutoConsumption",
    consumptionId,
    autoAuditMetadata({
      grantId: grant.id,
      consumptionId,
      snapshotId,
      digest: input.requestDigest,
      amountCents: input.amountCents,
      rowCount: 1,
    }),
  );
  if (systemSelection && systemRow) {
    await tx.amuxRecommendationSnapshot.create({
      data: {
        id: snapshotId,
        status: "prepared",
        actorUserId: AUTO_SYSTEM_ACTOR_ROW_ID,
        authorizationAuditLogId: auditId,
        scoringVersion: RECOMMENDATION_SCORING_VERSION,
        capacityConfigured: systemSelection.configured,
        capacityLimit: systemSelection.wipLimit,
        capacityOccupied: systemSelection.occupied,
        workerCapacity: "closed",
        classificationCapacity: "closed",
        itemBindingsDigest: recommendationRowsDigest([systemRow]),
        rowCount: 1,
        includedCount: 1,
        policyVersion: AUTO_PROMOTION_POLICY_VERSION,
        preparedAt: now,
        expiresAt: new Date(now.getTime() + RECOMMENDATION_EXPIRY_MS),
      },
    });
    await tx.amuxRecommendationSnapshotItem.create({
      data: {
        snapshotId,
        workItemId: card.id,
        ordinal: 0,
        expectedRevision: systemRow.expectedRevision,
        sourceDigest: systemRow.sourceDigest,
        executionBriefDigest: systemRow.executionBriefDigest,
        scoreTotal: systemRow.scoreTotal,
        disposition: "included",
        exclusionCode: null,
      },
    });
  }
  await tx.amuxRecommendationAutoConsumption.create({
    data: {
      id: consumptionId,
      grantId: grant.id,
      workItemId: card.id,
      snapshotId,
      status: "consumed",
      actorUserId: actorRowId(input.actor),
      authorizationAuditLogId: auditId,
      requestDigest: input.requestDigest,
    },
  });
  await tx.amuxRecommendationAutoCostEntry.create({
    data: {
      id: randomUUID(),
      consumptionId,
      amountCents: input.amountCents,
      recordedAt: now,
    },
  });
  return { consumptionId, snapshotId, status: "consumed" as const, replayed: false as const };
};

export async function previewAutoPromotion() {
  const decisions = await prisma.amuxRecommendationDecision.findMany({
    where: { decision: "approve", status: "consumed" },
    select: { createdAt: true },
  });
  const graduation = autoGraduationAccepted(decisions);
  const halt = await prisma.amuxRecommendationAutoHalt.findFirst({
    where: { clearedAt: null },
    orderBy: [{ openedAt: "asc" }, { id: "asc" }],
    select: { id: true, reason: true, violationCode: true, openedAt: true },
  });
  const activeGrants = await prisma.amuxRecommendationAutoGrant.count({ where: { status: "active" } });
  const open = applyOpen();
  return {
    applyPermitted: open,
    refusal: !open ? "apply_disabled" : halt ? "auto_halted" : graduation.ok ? null : graduation.code,
    humanDecisions: graduation.count,
    spanMs: graduation.spanMs,
    graduated: graduation.ok,
    openHalt: halt
      ? { haltId: halt.id, reason: halt.reason, violationCode: halt.violationCode, openedAt: halt.openedAt.toISOString() }
      : null,
    activeGrants,
  };
}

export async function grantAutoPromotion(input: { session: Session; request: Request; raw: string }) {
  refuseClosed();
  const parsed = parseAutoGrantRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, parsed.code === "one_card" ? 409 : 400);
  return commitAutoGrant(input.session, input.request, parsed.request, parsed.requestDigest);
}

export async function consumeAutoPromotion(input: { session: Session; request: Request; raw: string }) {
  refuseClosed();
  const parsed = parseAutoConsumeRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, parsed.code === "one_card" ? 409 : 400);
  try {
    return await commitAutoPromotion(input.session, input.request, parsed.request, parsed.requestDigest);
  } catch (error) {
    if (error instanceof BoardImportError && error.code === "outcome_unknown") {
      await recordAutoOutcomeUnknownSafely({
        actor: autoHumanActor(input.session, input.request),
        consumptionId: parsed.request.consumptionId,
        grantId: parsed.request.grantId,
      });
    }
    throw error;
  }
}

/**
 * Version 15 grant: the owner binds one item and one cent amount. The card
 * has to be an unowned backlog card at the item's revision and source digest.
 * The grant changes no card.
 */
export async function commitAutoGrant(
  session: Session,
  request: Request,
  grant: AutoGrantRequest,
  requestDigest: string,
) {
  const itemBindingsDigest = boardPromotionItemBindingsDigest([grant.item]);
  return withAutoTransaction(grant.grantId, OWNER_TRANSACTION_LIMITS, async (tx, now) => {
    const existing = await tx.amuxRecommendationAutoGrant.findUnique({ where: { id: grant.grantId } });
    if (existing) {
      if (existing.workItemId !== grant.item.cardId || existing.requestDigest !== requestDigest) {
        throw new BoardImportError("conflict", 409, grant.grantId);
      }
      return {
        grantId: existing.id,
        status: existing.status,
        itemBindingsDigest: existing.itemBindingsDigest,
        amountCents: existing.amountCents,
        replayed: true as const,
      };
    }
    const card = await tx.amuxWorkItem.findUnique({
      where: { id: grant.item.cardId },
      select: { id: true, status: true, owner: true, claimedAt: true, archivedAt: true, revision: true, sourceDigest: true },
    });
    if (!card || card.status !== "backlog" || card.owner || card.claimedAt || card.archivedAt) {
      throw new BoardImportError("not_backlog", 409, grant.grantId);
    }
    if (card.revision !== grant.item.expectedRevision || card.sourceDigest !== grant.item.sourceDigest) {
      throw new BoardImportError("conflict", 409, grant.grantId);
    }
    const active = await tx.amuxRecommendationAutoGrant.findFirst({
      where: { workItemId: grant.item.cardId, status: "active" },
      select: { id: true },
    });
    if (active) throw new BoardImportError("conflict", 409, grant.grantId);
    const auditId = await writeAutoAudit(
      tx,
      autoHumanActor(session, request),
      "amux.auto_grant.prepared",
      "AmuxRecommendationAutoGrant",
      grant.grantId,
      autoAuditMetadata({ grantId: grant.grantId, digest: requestDigest, amountCents: grant.amountCents }),
    );
    await tx.amuxRecommendationAutoGrant.create({
      data: {
        id: grant.grantId,
        workItemId: grant.item.cardId,
        status: "active",
        actorUserId: actorId(session),
        authorizationAuditLogId: auditId,
        requestDigest,
        grantedAt: now,
        expiresAt: autoGrantExpiresAt(now),
        itemBindings: [grant.item],
        itemBindingsDigest,
        amountCents: grant.amountCents,
      },
    });
    const after = await tx.amuxWorkItem.findUnique({ where: { id: grant.item.cardId }, select: { status: true } });
    if (after?.status !== "backlog") throw new BoardImportError("unapproved_todo", 409, grant.grantId);
    return {
      grantId: grant.grantId,
      status: "active" as const,
      itemBindingsDigest,
      amountCents: grant.amountCents,
      replayed: false as const,
    };
  });
}

/**
 * The owner's consume. A version 15 request takes the item and amount from
 * the bound grant; a version 8 request repeats them and, on a bound grant,
 * has to repeat the bound ones. A due grant is expired and refused in a
 * committed transaction, so the expiry is recorded even though the consume is
 * not.
 */
export async function commitAutoPromotion(
  session: Session,
  request: Request,
  body: AutoConsumeRequest | AutoBoundConsumeRequest,
  requestDigest: string,
) {
  const worker = autoWorkerAdmitted(body.workerId);
  if (!worker.ok) throw new BoardImportError(worker.code, 409, body.consumptionId);
  const actor = autoHumanActor(session, request);
  const outcome = await withAutoTransaction(body.consumptionId, OWNER_TRANSACTION_LIMITS, async (tx, now) => {
    const existing = await tx.amuxRecommendationAutoConsumption.findUnique({ where: { id: body.consumptionId } });
    if (existing) {
      if (
        existing.grantId !== body.grantId ||
        (!autoConsumeRequestIsBound(body) && existing.workItemId !== body.item.cardId)
      ) {
        throw new BoardImportError("conflict", 409, body.consumptionId);
      }
      return {
        kind: "done" as const,
        value: { consumptionId: existing.id, snapshotId: existing.snapshotId, status: existing.status, replayed: true as const },
      };
    }
    const lost = await tx.amuxRecommendationAutoUnknown.findUnique({
      where: { id: body.consumptionId },
      select: { id: true, grantId: true },
    });
    if (lost) {
      if (lost.grantId !== null && lost.grantId !== body.grantId) {
        throw new BoardImportError("conflict", 409, body.consumptionId);
      }
      return {
        kind: "done" as const,
        value: { consumptionId: lost.id, snapshotId: body.snapshotId, status: "outcome_unknown" as const, replayed: true as const },
      };
    }
    const grant = await tx.amuxRecommendationAutoGrant.findUnique({ where: { id: body.grantId }, select: GRANT_SELECT });
    if (grant && grant.status === "active" && grant.expiresAt.getTime() <= now.getTime()) {
      await expireGrantLocked(tx, now, actor, grant.id);
      return { kind: "refused" as const, code: "grant_missing" };
    }
    await requireAutoOpen(tx, body.consumptionId);
    if (!grant) throw new BoardImportError("grant_missing", 409, body.consumptionId);
    let item: BoardPromotionItem;
    let amountCents: number;
    if (autoConsumeRequestIsBound(body)) {
      const bound = autoBoundItem(grant);
      if (!bound.ok) throw new BoardImportError(bound.code, 409, body.consumptionId);
      item = bound.item;
      amountCents = bound.amountCents;
    } else {
      item = body.item;
      amountCents = body.amountCents;
    }
    const value = await consumeGrantLocked(tx, now, {
      actor,
      grant,
      item,
      amountCents,
      requireBound: autoConsumeRequestIsBound(body),
      consumptionId: body.consumptionId,
      requestDigest,
      snapshot: { kind: "stored", snapshotId: body.snapshotId },
    });
    return { kind: "done" as const, value };
  });
  if (outcome.kind === "refused") throw new BoardImportError(outcome.code, 409, body.consumptionId);
  return outcome.value;
}

/**
 * The system consume for one tick: the oldest active, unexpired, bound grant
 * that has neither a consumption nor a lost outcome. The grant is chosen
 * under the queue lock, inside the consume transaction.
 */
export async function commitSystemAutoPromotion(input: {
  consumptionId: string;
  snapshotId: string;
  onGrantPicked?: (grantId: string) => void;
  /** Grants this tick already found refused for a card-specific reason. */
  skipGrantIds?: readonly string[];
}): Promise<
  | { promoted: true; consumptionId: string; grantId: string; snapshotId: string }
  | { promoted: false; reason: "no_grant" }
> {
  return withAutoTransaction(input.consumptionId, TICK_TRANSACTION_LIMITS, async (tx, now, recordReceipt) => {
    await requireAutoOpen(tx, input.consumptionId);
    const grant = await tx.amuxRecommendationAutoGrant.findFirst({
      where: {
        status: "active",
        expiresAt: { gt: now },
        itemBindingsDigest: { not: null },
        consumptions: { none: {} },
        unknowns: { none: {} },
        ...(input.skipGrantIds && input.skipGrantIds.length > 0
          ? { id: { notIn: [...input.skipGrantIds] } }
          : {}),
      },
      orderBy: [{ grantedAt: "asc" }, { id: "asc" }],
      select: GRANT_SELECT,
    });
    if (!grant) return { promoted: false as const, reason: "no_grant" as const };
    input.onGrantPicked?.(grant.id);
    const bound = autoBoundItem(grant);
    if (!bound.ok) throw new BoardImportError(bound.code, 409, input.consumptionId);
    const requestDigest = autoSystemConsumeDigest({
      grantId: grant.id,
      consumptionId: input.consumptionId,
      snapshotId: input.snapshotId,
      itemBindingsDigest: bound.itemBindingsDigest,
      amountCents: bound.amountCents,
    });
    const value = await consumeGrantLocked(tx, now, {
      actor: AUTO_SYSTEM_ACTOR,
      grant,
      item: bound.item,
      amountCents: bound.amountCents,
      requireBound: true,
      consumptionId: input.consumptionId,
      requestDigest,
      snapshot: { kind: "system", snapshotId: input.snapshotId },
    });
    // Policy version 20, section 4: the card, the grant and the consumption
    // (its snapshot and cost entry commit with it), as receipts of an
    // admitted tick.
    recordReceipt("work_item", bound.item.cardId, 1);
    recordReceipt("auto_promotion_grant", grant.id, 1);
    recordReceipt("auto_promotion_consumption", value.consumptionId, 1);
    return { promoted: true as const, consumptionId: value.consumptionId, grantId: grant.id, snapshotId: value.snapshotId };
  });
}

/**
 * Expires up to `AUTO_EXPIRE_BATCH` due grants, oldest expiry first, one grant
 * and its audit per transaction.
 *
 * The audit chain's advisory lock is transaction scoped, so it is held from a
 * transaction's first entry until its COMMIT. A whole batch in one transaction
 * held it across every later expiry and entry, and every other audit writer
 * queued behind it -- the AMUX lifecycle writers among them, whose 200 ms
 * statement timeout turns that wait into a 503. One grant per transaction
 * holds it for one append.
 *
 * `counter` advances as each transaction commits, so a caller stopped by a
 * later failure still knows how many committed. `hasRoom` is asked before each
 * transaction; when it says no, the rest wait for the next call.
 */
const expireDueGrantsOneByOne = async (
  actor: AutoActor,
  counter: { expired: number },
  hasRoom: () => boolean = () => true,
): Promise<void> => {
  for (let index = 0; index < AUTO_EXPIRE_BATCH; index += 1) {
    if (!hasRoom()) return;
    const moved = await withAutoTransaction(null, limitsFor(actor), async (tx, now, recordReceipt) => {
      const due = await tx.amuxRecommendationAutoGrant.findFirst({
        where: { status: "active", expiresAt: { lte: now } },
        orderBy: [{ expiresAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      if (!due) return false;
      const expired = await expireGrantLocked(tx, now, actor, due.id);
      // Policy version 20, section 4: the grant's status, as a receipt of an
      // admitted tick.
      if (expired) recordReceipt("auto_promotion_grant", due.id, 1);
      return expired;
    });
    if (!moved) return;
    counter.expired += 1;
  }
};

export async function expireDueAutoGrants(actor: AutoActor): Promise<{ expired: number }> {
  const counter = { expired: 0 };
  await expireDueGrantsOneByOne(actor, counter);
  return { expired: counter.expired };
}

export type AutoTickResult = {
  promoted: boolean;
  reason?: string;
  consumption_id?: string;
  expired: number;
};

/**
 * One tick without the switch check; the route and `tickAutoPromotion` check
 * it first. Expiry is its own transaction and commits even when the consume
 * is refused. At most one card moves. A lost consume outcome is read back and
 * recorded, the halt rule is evaluated, and nothing is tried again.
 *
 * Inside the route budget no transaction starts unless the time left also
 * covers what it must leave room for: an expiry leaves room for a consume and
 * the record of its lost outcome, and a consume for that record. Grants still
 * due when the budget runs short expire on the next tick; a consume that no
 * longer fits ends the tick with `route_budget_exhausted` and moves nothing.
 */
export async function runAutoPromotionTick(): Promise<AutoTickResult> {
  const expiry = { expired: 0 };
  try {
    await expireDueGrantsOneByOne(AUTO_SYSTEM_ACTOR, expiry, () =>
      tickHasRoomFor(AUTO_TICK_SEQUENTIAL_TRANSACTIONS),
    );
  } catch (error) {
    if (!(error instanceof BoardImportError)) throw error;
    // No consume was attempted, so this is not a lost consume outcome and is
    // not counted toward the halt rule. The next tick expires again. Expiries
    // that committed before the failure are counted.
    const reason = error.code === "outcome_unknown" ? "expiry_outcome_unknown" : error.code;
    return { promoted: false, reason, expired: expiry.expired };
  }
  const expired = expiry.expired;
  // A grant refused for a reason that belongs to its own card (the card
  // moved, a dependency is open, it fell out of the ranking cut) must not
  // hold every later grant until it expires. Those are skipped for this tick
  // and the next grant is tried, each in its own transaction; any other
  // refusal, a lost outcome, or a promotion ends the tick. At most one card
  // moves per tick.
  const skipGrantIds: string[] = [];
  let lastReason: string | undefined;
  for (let attempt = 0; attempt < AUTO_TICK_GRANT_ATTEMPTS; attempt += 1) {
    if (!tickHasRoomFor(AUTO_TICK_SEQUENTIAL_TRANSACTIONS - 1)) {
      return { promoted: false, reason: "route_budget_exhausted", expired };
    }
    const consumptionId = randomUUID();
    const snapshotId = randomUUID();
    let pickedGrantId: string | null = null;
    try {
      const result = await commitSystemAutoPromotion({
        consumptionId,
        snapshotId,
        skipGrantIds,
        onGrantPicked: (grantId) => {
          pickedGrantId = grantId;
        },
      });
      if (!result.promoted) return { promoted: false, reason: lastReason ?? result.reason, expired };
      return { promoted: true, consumption_id: result.consumptionId, expired };
    } catch (error) {
      if (!(error instanceof BoardImportError)) throw error;
      if (error.code === "outcome_unknown") {
        await recordAutoOutcomeUnknownSafely({ actor: AUTO_SYSTEM_ACTOR, consumptionId, grantId: pickedGrantId });
        return { promoted: false, reason: error.code, expired };
      }
      if (pickedGrantId === null || !autoTickCardSpecificRefusal(error.code)) {
        return { promoted: false, reason: error.code, expired };
      }
      skipGrantIds.push(pickedGrantId);
      lastReason = error.code;
    }
  }
  return { promoted: false, reason: lastReason, expired };
}

export async function tickAutoPromotion(): Promise<AutoTickResult> {
  if (!applyOpen()) return { promoted: false, reason: "apply_disabled", expired: 0 };
  return runAutoPromotionTick();
}

/**
 * What recording one lost consume outcome will write, read under the queue
 * lock so the original transaction has ended and the read-back is final: a
 * consumption row with this id either exists or never will. Writes nothing.
 */
type AutoUnknownMark =
  | { kind: "recorded"; consumptionFound: boolean }
  | {
    kind: "record";
    consumption: { id: string; outcomeUnknownAt: Date | null } | null;
    grantId: string | null;
  };

const readAutoOutcomeUnknownLocked = async (
  tx: Prisma.TransactionClient,
  input: { consumptionId: string; grantId: string | null },
): Promise<AutoUnknownMark> => {
  const recorded = await tx.amuxRecommendationAutoUnknown.findUnique({
    where: { id: input.consumptionId },
    select: { consumptionFound: true },
  });
  if (recorded) return { kind: "recorded", consumptionFound: recorded.consumptionFound };
  const consumption = await tx.amuxRecommendationAutoConsumption.findUnique({
    where: { id: input.consumptionId },
    select: { id: true, grantId: true, outcomeUnknownAt: true },
  });
  let grantId = consumption?.grantId ?? null;
  if (!grantId && input.grantId) {
    const grant = await tx.amuxRecommendationAutoGrant.findUnique({ where: { id: input.grantId }, select: { id: true } });
    grantId = grant?.id ?? null;
  }
  return {
    kind: "record",
    consumption: consumption ? { id: consumption.id, outcomeUnknownAt: consumption.outcomeUnknownAt } : null,
    grantId,
  };
};

/**
 * Writes one `AmuxRecommendationAutoUnknown` row and its audit, and marks an
 * existing consumption row with `outcomeUnknownAt`. The row lock comes before
 * the audit entry, and only the row that names the entry comes after it.
 */
const writeAutoOutcomeUnknownLocked = async (
  tx: Prisma.TransactionClient,
  now: Date,
  actor: AutoActor,
  consumptionId: string,
  mark: AutoUnknownMark,
) => {
  if (mark.kind === "recorded") return { recorded: false as const, consumptionFound: mark.consumptionFound };
  if (mark.consumption && !mark.consumption.outcomeUnknownAt) {
    await tx.amuxRecommendationAutoConsumption.updateMany({
      where: { id: mark.consumption.id, outcomeUnknownAt: null },
      data: { outcomeUnknownAt: now },
    });
  }
  const auditId = await writeAutoAudit(
    tx,
    actor,
    "amux.auto_promotion.outcome_unknown",
    "AmuxRecommendationAutoUnknown",
    consumptionId,
    autoAuditMetadata({ consumptionId, grantId: mark.grantId }),
  );
  await tx.amuxRecommendationAutoUnknown.create({
    data: {
      id: consumptionId,
      grantId: mark.grantId,
      consumptionFound: mark.consumption !== null,
      authorizationAuditLogId: auditId,
      recordedAt: now,
    },
  });
  return { recorded: true as const, consumptionFound: mark.consumption !== null };
};

type AutoHaltOpening = Extract<ReturnType<typeof autoHaltRequired>, { halt: true }>;

type AutoHaltDecision =
  | { kind: "already_open"; haltId: string }
  | { kind: "clear" }
  | { kind: "halt"; reason: AutoHaltOpening["reason"]; violationCode: AutoHaltOpening["violationCode"] };

/**
 * The version 8 halt rule, read back. One stored critical violation, or two
 * lost outcomes within 15 minutes of the transaction clock, opens one halt.
 * Writes nothing: every scan here happens before the transaction's first
 * audit entry, so the audit chain's lock is never held across them.
 *
 * `pendingUnknown` is a lost outcome this transaction is about to record. It
 * counts as it will once written, so reading first changes no decision.
 */
const readAutoHaltLocked = async (
  tx: Prisma.TransactionClient,
  now: Date,
  pendingUnknown: { id: string; recordedAt: Date } | null,
): Promise<AutoHaltDecision> => {
  const existing = await openHalt(tx);
  if (existing) return { kind: "already_open", haltId: existing.id };
  const entries = await costEntries(tx);
  const inWindow = (windowMs: number) =>
    entries.filter((entry) => {
      const time = entry.recordedAt.getTime();
      return time >= now.getTime() - windowMs && time <= now.getTime();
    });
  const sum = (rows: typeof entries) => rows.reduce((total, row) => total + row.amountCents, 0);
  const consumptions = await tx.amuxRecommendationAutoConsumption.findMany({
    select: {
      id: true,
      workItemId: true,
      status: true,
      workItem: { select: { status: true, archivedAt: true, owner: true } },
      outcomeUnknownAt: true,
    },
  });
  const consumed = consumptions.filter((row) => row.status === "consumed");
  const activeCards = consumed.filter(
    (row) => row.workItem.archivedAt === null && (row.workItem.status === "todo" || row.workItem.status === "doing"),
  );
  const ownerCounts = new Map<string, number>();
  for (const row of activeCards) {
    if (!row.workItem.owner) continue;
    ownerCounts.set(row.workItem.owner, (ownerCounts.get(row.workItem.owner) ?? 0) + 1);
  }
  // Policy version 15. The automatic path writes todo only in the consume
  // transaction, together with a consumed row. A card it touched that is
  // todo or doing without one is the violation. A card a person promoted
  // while a stale grant was still active never had an automatic consumption
  // and is not counted.
  const unapprovedTodo = await tx.amuxWorkItem.count({
    where: {
      archivedAt: null,
      status: { in: ["todo", "doing"] },
      autoConsumptions: { some: {}, none: { status: "consumed" } },
    },
  });
  // Only rows the consume itself could have written count. Their createdAt
  // is the consume transaction's start (now()), so a claim, execution start
  // or delivery that runs later on a promoted card (policy version 15
  // execution) is not a lifecycle write by this path.
  const lifecycleCounts = await tx.$queryRaw<Array<{ writes: bigint }>>`
    SELECT
      (SELECT count(*) FROM "AmuxExecutionAttempt" a
         JOIN "AmuxRecommendationAutoConsumption" c ON c."workItemId" = a."taskId"
         WHERE c."status" = 'consumed' AND a."createdAt" <= c."createdAt")
    + (SELECT count(*) FROM "AmuxWorkDelivery" d
         JOIN "AmuxRecommendationAutoConsumption" c ON c."workItemId" = d."taskId"
         WHERE c."status" = 'consumed' AND d."createdAt" <= c."createdAt")
    + (SELECT count(*) FROM "AmuxRouteDecision" r
         JOIN "AmuxRecommendationAutoConsumption" c ON c."workItemId" = r."taskId"
         WHERE c."status" = 'consumed' AND r."createdAt" <= c."createdAt")
      AS "writes"
  `;
  const lifecycleWrites = Number(lifecycleCounts[0]?.writes ?? BigInt(0));
  const readback = autoReadbackCritical({
    activeCount: activeCards.length,
    ownerCounts: [...ownerCounts.values()],
    costCents24h: sum(inWindow(AUTO_COST_24H_MS)),
    costCents30d: sum(inWindow(AUTO_COST_30D_MS)),
    unapprovedTodo,
    lifecycleWrites,
  });
  const unknowns = await tx.amuxRecommendationAutoUnknown.findMany({
    where: { recordedAt: { gte: new Date(now.getTime() - AUTO_UNKNOWN_BURST_MS) } },
    select: { id: true, recordedAt: true },
  });
  const decision = autoHaltRequired({
    criticalCodes: readback,
    unknownAt: autoUnknownEvents({
      consumptions,
      unknowns: pendingUnknown ? [...unknowns, pendingUnknown] : unknowns,
    }),
    now,
  });
  if (!decision.halt) return { kind: "clear" };
  return { kind: "halt", reason: decision.reason, violationCode: decision.violationCode };
};

/** Opens the halt a read-back decided on: its audit entry, then the row that names it. */
const writeAutoHaltLocked = async (
  tx: Prisma.TransactionClient,
  now: Date,
  actor: AutoActor,
  haltId: string,
  decision: AutoHaltDecision,
) => {
  if (decision.kind === "already_open") {
    return { haltId: decision.haltId, halted: true as const, replayed: true as const };
  }
  if (decision.kind === "clear") return { haltId: null, halted: false as const, replayed: false as const };
  const auditId = await writeAutoAudit(
    tx,
    actor,
    "amux.auto_promotion.halted",
    "AmuxRecommendationAutoHalt",
    haltId,
    autoAuditMetadata({ violationCode: decision.violationCode }),
  );
  await tx.amuxRecommendationAutoHalt.create({
    data: {
      id: haltId,
      reason: decision.reason,
      violationCode: decision.violationCode,
      actorUserId: actorRowId(actor),
      authorizationAuditLogId: auditId,
      openedAt: now,
    },
  });
  return { haltId, halted: true as const, replayed: false as const };
};

export async function commitAutoHaltFromReadback(input: { actor: AutoActor; haltId: string }) {
  return withAutoTransaction(input.haltId, limitsFor(input.actor), async (tx, now) => {
    const decision = await readAutoHaltLocked(tx, now, null);
    return writeAutoHaltLocked(tx, now, input.actor, input.haltId, decision);
  });
}

/**
 * Records one lost consume outcome and evaluates the halt rule, in one
 * transaction. Every read comes first; the writes, and with them the audit
 * chain's lock, come last.
 */
export async function recordAutoOutcomeUnknown(input: {
  actor: AutoActor;
  consumptionId: string;
  grantId: string | null;
  haltId?: string;
}) {
  const haltId = input.haltId ?? randomUUID();
  return withAutoTransaction(input.consumptionId, limitsFor(input.actor), async (tx, now, recordReceipt) => {
    const mark = await readAutoOutcomeUnknownLocked(tx, input);
    const halt = await readAutoHaltLocked(
      tx,
      now,
      mark.kind === "record" ? { id: input.consumptionId, recordedAt: now } : null,
    );
    const marked = await writeAutoOutcomeUnknownLocked(tx, now, input.actor, input.consumptionId, mark);
    const opened = await writeAutoHaltLocked(tx, now, input.actor, haltId, halt);
    // Policy version 20, section 4: the record of a lost consume (and a
    // version 8 halt it opens) changes the automatic promotion state of that
    // consumption attempt, so an admitted tick keeps a receipt of it under
    // the attempted consumption id. A record already written changes nothing.
    if (marked.recorded || (opened.halted && !opened.replayed)) {
      recordReceipt("auto_promotion_consumption", input.consumptionId, 1);
    }
    return { ...marked, haltId: opened.haltId, halted: opened.halted };
  });
}

/**
 * The route-side wrapper. If the record itself fails, the outcome stays
 * unknown: this logs codes only and does not try the consume or the record
 * again.
 */
const recordAutoOutcomeUnknownSafely = async (input: {
  actor: AutoActor;
  consumptionId: string;
  grantId: string | null;
}) => {
  try {
    await recordAutoOutcomeUnknown(input);
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "amux_auto_promotion_outcome_unknown_unrecorded",
        actor: input.actor.kind,
        code: error instanceof BoardImportError ? error.code : "unexpected",
      }),
    );
  }
};

/** The owner clears one open halt. Clearing does not reopen the switch. */
export async function resumeAutoPromotion(input: { session: Session; request: Request; raw: string }) {
  const parsed = parseAutoResumeRequest(input.raw);
  if (!parsed.ok) throw new BoardImportError(parsed.code, 400);
  return commitAutoResume(input.session, input.request, parsed.request.haltId);
}

export async function commitAutoResume(session: Session, request: Request, haltId: string) {
  return withAutoTransaction(haltId, OWNER_TRANSACTION_LIMITS, async (tx, now) => {
    const halt = await tx.amuxRecommendationAutoHalt.findUnique({
      where: { id: haltId },
      select: { id: true, clearedAt: true, violationCode: true },
    });
    if (!halt) throw new BoardImportError("not_found", 404, haltId);
    if (halt.clearedAt) return { haltId, cleared: true as const, replayed: true as const };
    const updated = await tx.amuxRecommendationAutoHalt.updateMany({
      where: { id: haltId, clearedAt: null },
      data: { clearedAt: now },
    });
    if (updated.count !== 1) throw new BoardImportError("conflict", 409, haltId);
    await writeAutoAudit(
      tx,
      autoHumanActor(session, request),
      "amux.auto_promotion.resumed",
      "AmuxRecommendationAutoHalt",
      haltId,
      autoAuditMetadata({ violationCode: halt.violationCode }),
    );
    return { haltId, cleared: true as const, replayed: false as const };
  });
}
