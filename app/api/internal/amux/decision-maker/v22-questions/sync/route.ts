export const dynamic = "force-dynamic";

import { z } from "zod";

import { readLimitedJson } from "@/lib/apiSecurity";
import { BoardImportError } from "@/lib/amux/boardImportCore";
import {
  AMUX_DB_BOUNDARIES,
  withAmuxDbBoundary,
  withAmuxRouteBudget,
} from "@/lib/amux/dbBoundary";
import { parseDmDeliveryCursor } from "@/lib/amux/decisionMakerDeliveryCore";
import { recordAmuxDmRelaySync } from "@/lib/amux/dmRelayHeartbeat";
import {
  dmInternalRoutesEnabled,
  dmRouteErrorResponse,
  dmRouteRefusal,
} from "@/lib/amux/decisionMakerInternalRoute";
import { isAmuxSyncAuthorized } from "@/lib/amux/guard";
import { amuxJsonNoStore } from "@/lib/amux/internalRoute";
import {
  openAmuxIdeaCardCloseQuestionIfDue,
  readAmuxIdeaCardCloseSyncForRelay,
} from "@/lib/amux/ideaCardCloseService";
import {
  AMUX_V22_QUESTION_SYNC_LIMIT,
  openAmuxV22QuestionCards,
  readAmuxV22QuestionSyncRows,
  runAmuxV22ResolveStep,
} from "@/lib/amux/v22OwnerQuestionDmService";
import { runAmuxDmAutoApplyStep } from "@/lib/amux/dmAutoApplyService";
import { amuxV22ResultReviewDmEnabled } from "@/lib/amux/v22ResultReviewCore";
import {
  openAmuxV22ResultReviewCards,
  readAmuxV22ResultReviewSyncRows,
  recordAmuxV22ResultReviewsUnfilable,
} from "@/lib/amux/v22ResultReviewService";
import { amuxDmOwnerSettlementEnabled } from "@/lib/amux/dmOwnerSettlementCore";
import {
  openAmuxDmOwnerSettlementCards,
  readAmuxDmOwnerSettlementSyncRows,
  recordAmuxDmOwnerSettlementsUnfilable,
} from "@/lib/amux/dmOwnerSettlementService";
import { resumeAmuxDmOwnerSettlementRemake } from "@/lib/amux/dmOwnerSettlementRemake";
import { engineeringAgentT2DmReviewEnabled } from "@/lib/engineeringAgentT2DmReviewCore";
import {
  engineeringAgentT2DmCards,
  readEngineeringAgentT2DmSyncRows,
  recordEngineeringAgentT2DmUnfilable,
} from "@/lib/engineeringAgentT2DmReviewService";

/**
 * The relay's v22 question tick (operator decision 2026-10-30): first one
 * step of the walk over confirmed Decision Maker proposals from the relay's
 * cursor (`after`), which answers an open question whose card a person
 * confirmed -- a read, then the answer under the audit chain lock and the
 * kill switch, or, when the answer cannot resume the Task, an escalation and
 * the cancel, each its own transaction within docs/policy/amux-decision-maker.md §9's 12 statements; then the open questions that still need a typed-ask card on the
 * AMUX host and the cards of questions no longer open that it should close.
 * `cursor` says where the walk goes next. The question text is opened from
 * the run's encrypted result outside the read transaction. Closed until
 * `TOMVERSE_AMUX_DM_ROUTING=enabled`.
 *
 * An idea card close question (lib/amux/ideaCardCloseService.ts) rides the same
 * tick in the same shape, so the bridge needs no change: the walk applies its
 * confirmed answer, one new question may open while its own switch is on, and
 * its entries follow the v22 ones in the two lists. A fault in that part leaves
 * the v22 questions to go on.
 *
 * Owner decision 2026-11-07: a v22 result waiting for review rides the tick the
 * same way (lib/amux/v22ResultReviewService.ts; new cards only while
 * TOMVERSE_AMUX_V22_RESULT_REVIEW_DM=enabled), and while
 * TOMVERSE_AMUX_DM_APPROVER=enabled one Decision Maker proposal per tick is
 * applied without the operator (lib/amux/dmAutoApplyService.ts).
 *
 * Owner decision 2026-11-13: a stopped v22 Task in the owner queue that no
 * other path holds rides the tick as an owner queue settlement
 * (lib/amux/dmOwnerSettlementService.ts; new settlements and cards only while
 * TOMVERSE_AMUX_DM_OWNER_SETTLEMENT=enabled), before the T2 drafts.
 *
 * Operator decision 2026-11-11: an engineering agent T2 draft rides the tick
 * last, for advice only (lib/engineeringAgentT2DmReviewService.ts; new cards
 * only while TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW=enabled). Its answer is
 * shown beside the draft in Admin and applies nothing.
 */
const OPERATION = "decision_maker_v22_question_sync";
const refused = dmRouteRefusal("synced");
const requestSchema = z.object({ after: z.unknown().optional() }).strict();

export async function POST(request: Request) {
  if (!isAmuxSyncAuthorized(request)) {
    return amuxJsonNoStore({ error: "Unauthorized" }, 401);
  }
  // The relay's last call, before the switch: the monitor's silence alert
  // (lib/amux/dmRelayHeartbeatCore.ts) reads it. Never throws.
  await recordAmuxDmRelaySync();
  if (!dmInternalRoutesEnabled()) return refused(409, "dm_routing_disabled");

  return withAmuxRouteBudget(async () => {
    try {
      const body = await readLimitedJson(request, 1_024, requestSchema);
      const after = parseDmDeliveryCursor(body.after);
      if (after === undefined) return refused(400, "invalid_request");
      const { resolved: outcome, cursor } = await runAmuxV22ResolveStep(after);
      const autoApplied = await runAmuxDmAutoApplyStep().catch(() => {
        console.warn(JSON.stringify({ subsystem: "amux", event: "dm_auto_apply_step_failed" }));
        return null;
      });
      await openAmuxIdeaCardCloseQuestionIfDue().catch(() => {
        console.warn(JSON.stringify({ subsystem: "amux", event: "idea_card_close_open_failed" }));
      });
      const rows = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerV22QuestionRead,
        (tx, context) => readAmuxV22QuestionSyncRows(tx, context.dbNow));
      const cards = [...rows.refusalCards, ...await openAmuxV22QuestionCards(rows.pending)];
      const cardClose = await readAmuxIdeaCardCloseSyncForRelay();
      const review = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerV22ResultReviewRead,
        (tx) => readAmuxV22ResultReviewSyncRows(tx)).then(async (rows) => {
        if (!amuxV22ResultReviewDmEnabled()) return { pending: [], closing: rows.closing };
        const opened = await openAmuxV22ResultReviewCards(rows.pending);
        if (opened.unfilable.length > 0)
          await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerV22ResultReviewHandoff,
            (tx, context) => recordAmuxV22ResultReviewsUnfilable(tx,
              { reviewIds: opened.unfilable, now: context.dbNow }));
        return { pending: opened.cards, closing: rows.closing };
      }).catch(() => {
        console.warn(JSON.stringify({ subsystem: "amux", event: "v22_result_review_sync_failed" }));
        return { pending: [], closing: [] };
      });
      // A remake an earlier tick claimed and did not finish: its idea read back,
      // never filed again, and its cards closed or the person told.
      await resumeAmuxDmOwnerSettlementRemake().catch(() => {
        console.warn(JSON.stringify({ subsystem: "amux", event: "dm_owner_settlement_resume_failed" }));
      });
      const settlementOn = amuxDmOwnerSettlementEnabled();
      const settlement = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementSync,
        (tx) => readAmuxDmOwnerSettlementSyncRows(tx, { enabled: settlementOn })).then(async (rows) => {
        if (!settlementOn) return { pending: [], closing: rows.closing };
        const opened = await openAmuxDmOwnerSettlementCards(rows);
        if (opened.unfilable.length > 0)
          await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementHandoff,
            (tx, context) => recordAmuxDmOwnerSettlementsUnfilable(tx,
              { settlementIds: opened.unfilable, now: context.dbNow }));
        return { pending: opened.cards, closing: rows.closing };
      }).catch(() => {
        console.warn(JSON.stringify({ subsystem: "amux", event: "dm_owner_settlement_sync_failed" }));
        return { pending: [], closing: [] };
      });
      const t2 = await withAmuxDbBoundary(
        AMUX_DB_BOUNDARIES.engineeringAgentT2DmReviewRead,
        (tx) => readEngineeringAgentT2DmSyncRows(tx)).then(async (rows) => {
        if (!engineeringAgentT2DmReviewEnabled()) return { pending: [], closing: rows.closing };
        const opened = engineeringAgentT2DmCards(rows.pending);
        if (opened.unfilable.length > 0)
          await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.engineeringAgentT2DmReviewUnfilable,
            (tx, context) => recordEngineeringAgentT2DmUnfilable(tx,
              { workItemIds: opened.unfilable, now: context.dbNow }));
        return { pending: opened.cards, closing: rows.closing };
      }).catch(() => {
        console.warn(JSON.stringify({ subsystem: "amux", event: "engineering_t2_dm_review_sync_failed" }));
        return { pending: [], closing: [] };
      });
      return amuxJsonNoStore({
        synced: true,
        resolved: outcome,
        ...(autoApplied ? { auto_applied: autoApplied.applied ? autoApplied.kind : null } : {}),
        cursor: cursor.move === "advance" ? { move: "advance",
          judged_at_ms: cursor.judgedAtMs, request_id: cursor.requestId } :
          { move: cursor.move },
        pending: [...cards, ...cardClose.pending, ...review.pending, ...settlement.pending,
          ...t2.pending].slice(0, AMUX_V22_QUESTION_SYNC_LIMIT),
        closing: [...rows.closing, ...cardClose.closing, ...review.closing, ...settlement.closing,
          ...t2.closing]
          .slice(0, AMUX_V22_QUESTION_SYNC_LIMIT)
          .map((row) => ({ question_id: row.questionId, card_id: row.cardId })),
      });
    } catch (error) {
      if (error instanceof BoardImportError) return refused(error.httpStatus, error.code);
      return dmRouteErrorResponse(OPERATION, error, refused);
    }
  });
}
