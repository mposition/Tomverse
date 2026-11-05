import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";

import { writeSystemAuditLog } from "@/lib/adminAudit";
import { AMUX_SYSTEM_AUDIT_ACTOR } from "@/lib/amux/auditContract";
import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import { BoardImportError } from "./boardImportCore.ts";
import type { AmuxAnalysisSchemaRejectAt } from "./ideaAnalysisChunkCore.ts";
import { amuxPlanRefusalCard, amuxPlanRefusalPromptNote,
  type AmuxPlanRefusalDecision, type AmuxPlanRefusalReason } from
  "./ideaSessionPlanRefusalCore.ts";

type Tx = Prisma.TransactionClient;
export const AMUX_PLAN_REFUSAL_AUDIT_TARGET = "AmuxIdeaSessionPlanRefusal";
export const AMUX_PLAN_REFUSAL_DECIDED_ACTION = "amux.v19.session_plan_refusal.decided";
/** At most this many cards per relay tick, as for a v22 question. */
const SYNC_LIMIT = 3;

type ReasonColumns = { detail: string; schemaRule: string | null;
  schemaField: string | null; schemaUnit: number | null;
  schemaUnitKind: string | null };

const reasonOf = (row: ReasonColumns): AmuxPlanRefusalReason => ({
  detail: row.detail as AmuxPlanRefusalReason["detail"],
  ...(row.schemaRule ? { at: {
    rule: row.schemaRule as AmuxAnalysisSchemaRejectAt["rule"],
    ...(row.schemaField ? { field: row.schemaField as AmuxAnalysisSchemaRejectAt["field"] } : {}),
    ...(row.schemaUnit !== null ? { unit: row.schemaUnit } : {}),
    ...(row.schemaUnitKind ? { kind: row.schemaUnitKind as AmuxAnalysisSchemaRejectAt["kind"] } : {}),
  } } : {}),
});

/** Records why an answer was refused, in the result's transaction. The idea
 * stays `analyzing`, and this open row keeps it out of the queue. */
export async function recordAmuxSessionPlanRefusalInTx(tx: Tx, input: {
  ideaId: string; claimId: string; chunkIndex: number;
  reason: AmuxPlanRefusalReason; now: Date;
}) {
  const id = randomUUID();
  await writeSystemAuditLog({ tx, systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
    action: "amux.v19.session_plan_refusal.opened",
    targetType: AMUX_PLAN_REFUSAL_AUDIT_TARGET,
    targetId: id,
    summary: "Held one AMUX session idea for a decision after the plan check refused its answer.",
    metadata: { ideaId: input.ideaId, claimId: input.claimId,
      chunkIndex: input.chunkIndex, detail: input.reason.detail,
      schemaRule: input.reason.at?.rule ?? null } });
  await tx.amuxIdeaSessionPlanRefusal.create({ data: { id, ideaId: input.ideaId,
    claimId: input.claimId, chunkIndex: input.chunkIndex,
    detail: input.reason.detail, schemaRule: input.reason.at?.rule ?? null,
    schemaField: input.reason.at?.field ?? null,
    schemaUnit: input.reason.at?.unit ?? null,
    schemaUnitKind: input.reason.at?.kind ?? null, updatedAt: input.now } });
}

/** What a claim's page prompt needs: how many runs were decided so far, which
 * moves the invocation ordinal past the page index, and the reason to carry
 * when this page's newest refusal is the one being run again. */
export async function readAmuxSessionPlanRetriesInTx(tx: Tx, ideaId: string) {
  const retried = await tx.amuxIdeaSessionPlanRefusal.findMany({
    where: { ideaId, state: "retry" }, orderBy: { createdAt: "desc" },
    select: { chunkIndex: true, detail: true, schemaRule: true,
      schemaField: true, schemaUnit: true, schemaUnitKind: true } });
  return { count: retried.length,
    noteFor: (chunkIndex: number) => retried[0]?.chunkIndex === chunkIndex ?
      amuxPlanRefusalPromptNote(reasonOf(retried[0])) : null };
}

const open = { state: "open" } as const;
const ideaLive = (now: Date) => ({ state: "analyzing", cancelledAt: null,
  analysisCompletedAt: null, analysisDeadlineAt: { gt: now } });

/** Open refusals with no local card, as the relay's cards, and the cards of
 * refusals decided, or whose idea left analysis, that it has not closed. Two
 * statements. */
export async function readAmuxPlanRefusalSyncRows(tx: Tx, now: Date) {
  const pending = await tx.amuxIdeaSessionPlanRefusal.findMany({
    where: { ...open, localCardId: null, idea: ideaLive(now) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }], take: SYNC_LIMIT,
    select: { id: true, ideaId: true, chunkIndex: true, detail: true,
      schemaRule: true, schemaField: true, schemaUnit: true,
      schemaUnitKind: true, claim: { select: { provider: true,
        invocationOrdinal: true } } } });
  const closing = await tx.amuxIdeaSessionPlanRefusal.findMany({
    where: { localCardId: { not: null }, localCardClosedAt: null,
      OR: [{ state: { not: "open" } }, { idea: { NOT: ideaLive(now) } }] },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }], take: SYNC_LIMIT,
    select: { id: true, localCardId: true } });
  return {
    cards: pending.flatMap((row) => {
      const card = amuxPlanRefusalCard({ refusalId: row.id, ideaId: row.ideaId,
        claimProvider: row.claim.provider ?? "", chunkIndex: row.chunkIndex,
        runs: row.claim.invocationOrdinal + 1,
        reason: reasonOf(row) });
      return card ? [card] : [];
    }),
    closing: closing.map((row) => ({ questionId: row.id, cardId: row.localCardId! })),
  };
}

/** Names a refusal's local card, once; the same card again is a read. */
export async function recordAmuxPlanRefusalLocalCard(tx: Tx,
  input: { questionId: string; cardId: string }) {
  const changed = await tx.amuxIdeaSessionPlanRefusal.updateMany({ where: {
    id: input.questionId, localCardId: null }, data: { localCardId: input.cardId } });
  if (changed.count === 1) return { recorded: true as const };
  const row = await tx.amuxIdeaSessionPlanRefusal.findUnique({
    where: { id: input.questionId }, select: { localCardId: true } });
  if (!row) throw new BoardImportError("not_found", 404);
  if (row.localCardId !== input.cardId) throw new BoardImportError("card_conflict", 409);
  return { recorded: true as const };
}

/** Records that the relay closed a refusal's local card, once. */
export async function recordAmuxPlanRefusalLocalCardClosed(tx: Tx,
  input: { questionId: string; cardId: string; now: Date }) {
  const changed = await tx.amuxIdeaSessionPlanRefusal.updateMany({ where: {
    id: input.questionId, localCardId: input.cardId, localCardClosedAt: null,
    OR: [{ state: { not: "open" } }, { idea: { NOT: ideaLive(input.now) } }] },
  data: { localCardClosedAt: input.now } });
  if (changed.count === 1) return { recorded: true as const };
  const row = await tx.amuxIdeaSessionPlanRefusal.findUnique({
    where: { id: input.questionId },
    select: { localCardId: true, localCardClosedAt: true } });
  if (!row) throw new BoardImportError("not_found", 404);
  if (row.localCardId !== input.cardId || !row.localCardClosedAt)
    throw new BoardImportError("not_closable", 409);
  return { recorded: true as const };
}

/** The open refusal a card mirrors, on an idea still in analysis. */
export const readOpenAmuxPlanRefusalOfCard = (tx: Tx, cardId: string, now: Date) =>
  tx.amuxIdeaSessionPlanRefusal.findFirst({ where: { localCardId: cardId, ...open,
    idea: ideaLive(now) }, select: { id: true, ideaId: true } });

/** Ends the idea's analysis for the operator: the idea and every earlier
 * page's body clock. The refused answer's kept copy stays for its retention. */
export async function parkAmuxSessionIdeaInTx(tx: Tx, ideaId: string, now: Date) {
  const parked = await tx.amuxIdeaSubmission.updateMany({
    where: { id: ideaId, state: "analyzing", analysisCompletedAt: null,
      cancelledAt: null, analysisDeadlineAt: { gt: now } },
    // Completion ends the raw idea's clock, as on the v4 path (DB check).
    data: { state: "awaiting_owner", analysisCompletedAt: now, rawPurgeAfter: now },
  });
  if (parked.count !== 1) return false;
  // Deadlines only move earlier; the database refuses moving them later.
  await tx.amuxIdeaAnalysisChunk.updateMany({ where: { ideaId,
    freeformCiphertext: { not: null }, freeformPurgeAfter: { gt: now } },
  data: { freeformPurgeAfter: now } });
  await tx.amuxIdeaTransferPreview.updateMany({ where: { ideaId,
    payloadCiphertext: { not: null }, payloadPurgeAfter: { gt: now } },
  data: { payloadPurgeAfter: now } });
  return true;
}

/** Applies one decision; the caller holds the audit chain lock. A decision that
 * lost a race changes nothing. One conditional update, the audit, and on a stop
 * the three updates of the idea, which keeps a Decision Maker transaction within
 * docs/policy/amux-decision-maker.md §9's 12 statements. */
export async function decideAmuxPlanRefusalInTx(tx: Tx, input: { refusalId: string;
  ideaId: string; decision: AmuxPlanRefusalDecision;
  source: "operator" | "dm_confirmed"; decidedByUserId: string | null; now: Date;
  audit: () => Promise<unknown> }) {
  const decided = await tx.amuxIdeaSessionPlanRefusal.updateMany({
    where: { id: input.refusalId, ideaId: input.ideaId, ...open, idea: ideaLive(input.now) },
    data: { state: input.decision === "retry" ? "retry" : "stopped",
      decisionSource: input.source, decidedByUserId: input.decidedByUserId,
      decidedAt: input.now, updatedAt: input.now } });
  if (decided.count !== 1) return { applied: false as const };
  await input.audit();
  if (input.decision === "stop" &&
      !await parkAmuxSessionIdeaInTx(tx, input.ideaId, input.now)) {
    throw new BoardImportError("not_ready", 409);
  }
  return { applied: true as const };
}

/** Applies a confirmed Decision Maker proposal; the caller checked the kill
 * switch under the audit chain lock. The person's judgment audit names who
 * confirmed it. */
export const applyAmuxPlanRefusalDmDecision = (tx: Tx, input: { refusalId: string;
  ideaId: string; requestId: string; decision: AmuxPlanRefusalDecision; now: Date }) =>
  decideAmuxPlanRefusalInTx(tx, { refusalId: input.refusalId, ideaId: input.ideaId,
    decision: input.decision, source: "dm_confirmed", decidedByUserId: null, now: input.now,
    audit: () => writeSystemAuditLog({ tx,
      systemActor: AMUX_SYSTEM_AUDIT_ACTOR,
      action: AMUX_PLAN_REFUSAL_DECIDED_ACTION,
      targetType: AMUX_PLAN_REFUSAL_AUDIT_TARGET,
      targetId: input.refusalId,
      summary: "Applied a confirmed Decision Maker proposal to one refused session analysis answer.",
      metadata: { ideaId: input.ideaId, decision: input.decision, source: "dm_confirmed",
        requestId: input.requestId } }) });

/** The open refusal of an idea, for its Admin detail. */
export async function readOpenAmuxPlanRefusal(ideaId: string) {
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.amuxPlanRefusalOwnerRead,
    async (tx, context) => {
      const row = await tx.amuxIdeaSessionPlanRefusal.findFirst({
        where: { ideaId, ...open, idea: ideaLive(context.dbNow) },
        select: { id: true, chunkIndex: true, detail: true, schemaRule: true,
          schemaField: true, schemaUnit: true, schemaUnitKind: true } });
      return row ? { refusalId: row.id, chunkIndex: row.chunkIndex,
        ...reasonOf(row) } : null;
    });
}
