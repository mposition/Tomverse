import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import type { AmuxDmOwnerSettlementAnswer } from "./dmOwnerSettlementCore.ts";
import {
  applyAmuxDmOwnerSettlementDecision, applyAmuxDmOwnerSettlementRemake,
  cancelMovedAmuxDmOwnerSettlementClaim, guardAmuxDmOwnerSettlementRemakeIntake,
  readStaleAmuxDmOwnerSettlementRemake, recordAmuxDmOwnerSettlementHandoff,
  recordAmuxDmOwnerSettlementRemakeIdea, type AmuxDmOwnerSettlementApplied,
} from "./dmOwnerSettlementService.ts";
import { AMUX_SESSION_INTAKE_READBACK_ENV, amuxSessionIntakeReadbackEnabled } from
  "./ideaSessionIntakeReadbackCore.ts";
import {
  AMUX_SESSION_INTAKE_ENV, amuxIdeaSessionPrewriteStatus, amuxSessionIntakeWritePermitted,
  inspectAmuxIdeaSessionSubmission,
} from "./ideaSessionSubmissionCore.ts";
import {
  AmuxIdeaSessionGuardRefused, AmuxIdeaSessionSubmissionError, readAmuxIdeaSessionSubmissionRequest,
  submitAmuxIdeaFromSession, type AmuxIdeaSessionSubmissionGuard,
} from "./ideaSessionSubmissionService.ts";
import { AMUX_V4_IDEA_READBACK_ENV, AMUX_V4_IDEA_SUBMISSION_ENV } from "./ideaSubmissionCore.ts";

/**
 * A remake's new idea (owner decision 2026-11-13), in three steps:
 *
 * 1. The claim, in the transaction that holds the request -- the approver's
 *    claim of it, or after the operator's recorded judgment: under the audit
 *    chain lock and the kill switch the settlement becomes `claimed` with the
 *    idea request id (applyAmuxDmOwnerSettlementDecision). A person who
 *    judged first, or the kill switch, stops it there, before any idea exists.
 * 2. The idea, through the same session intake the Admin idea form and a
 *    coding session use (submitAmuxIdeaFromSession): analysed, carded and run
 *    like any other, its analysis inside the operating scope's own budget. The
 *    claim is checked again inside the intake's own commit transaction, before
 *    the idea or its reservation is written, under the audit chain lock
 *    (guardAmuxDmOwnerSettlementRemakeIntake): the kill switch, the claim, and
 *    the Task by the one rule every step uses; the same commit names the idea
 *    on the claim. A Task that moved cancels the claim, the kill switch or a
 *    busy card hands it to the person, and none of them writes an idea. A
 *    refusal goes to the person; an outcome nobody knows is read back once
 *    under the same request id and, when the idea is not there, goes to the
 *    person -- it is never filed again.
 * 3. The close of the card and the unstarted cards waiting on it, with the
 *    idea's id (applyAmuxDmOwnerSettlementRemake).
 *
 * A claim whose steps never ended (a lost answer, a held close) is finished by
 * a later tick from what the claim names, or handed over; nothing is filed then.
 */

const REPOSITORY = "mposition/Tomverse";

export type AmuxDmOwnerSettlementRemakeFiling =
  | { ideaId: string } | { refused: string } | { unknown: true } | { guarded: string };

const intakeOn = () =>
  amuxSessionIntakeWritePermitted(process.env[AMUX_SESSION_INTAKE_ENV], process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) &&
  amuxSessionIntakeReadbackEnabled(process.env[AMUX_SESSION_INTAKE_READBACK_ENV], process.env[AMUX_V4_IDEA_READBACK_ENV]);

/** The idea a request id committed, read back; null when it is not there, or only partly. */
export async function readBackAmuxDmOwnerSettlementRemakeIdea(requestId: string) {
  const seen = await readAmuxIdeaSessionSubmissionRequest(requestId);
  return seen.status === "committed" ? { ideaId: seen.ideaId } : null;
}

/** The session intake's own input for a remake: this repository, the Decision Maker as its source. */
export const amuxDmOwnerSettlementRemakeSubmission = (requestId: string, ideaText: string) =>
  inspectAmuxIdeaSessionSubmission({ version: 1, requestId,
    input: { version: 1, idea: ideaText, repositories: [REPOSITORY], pullRequests: [] },
    source: { toolName: "tomverse-amux-decision-maker", modelProvider: "decision-maker",
      sessionDisplay: "Decision Maker remake of a stopped card" } });

/** Files the remake's idea once under its request id, the guard inside its
 * commit; an idea already there is read back. */
export async function fileAmuxDmOwnerSettlementRemakeIdea(input: {
  requestId: string; ideaText: string; guard: AmuxIdeaSessionSubmissionGuard;
}): Promise<AmuxDmOwnerSettlementRemakeFiling> {
  if (!intakeOn()) return { refused: "intake_disabled" };
  const seen = await readAmuxIdeaSessionSubmissionRequest(input.requestId);
  if (seen.status === "committed") return { ideaId: seen.ideaId };
  if (seen.status === "partial") return { unknown: true };
  const inspected = amuxDmOwnerSettlementRemakeSubmission(input.requestId, input.ideaText);
  if (!inspected.ok) return { refused: "idea_refused" };
  try {
    return { ideaId: (await submitAmuxIdeaFromSession({ inspected, guard: input.guard })).ideaId };
  } catch (error) {
    if (error instanceof AmuxIdeaSessionGuardRefused) return { guarded: error.reason };
    if (error instanceof AmuxIdeaSessionSubmissionError) {
      if (error.code === "request_already_seen" && error.readBack === "committed" && error.ideaId)
        return { ideaId: error.ideaId };
      if (amuxIdeaSessionPrewriteStatus(error.code) !== undefined) return { refused: "idea_refused" };
    }
    return { unknown: true };
  }
}

/** What the steps after the claim reach outside the database; replaceable in tests. */
export type AmuxDmOwnerSettlementRemakeDeps = {
  fileIdea?: typeof fileAmuxDmOwnerSettlementRemakeIdea;
  readBack?: typeof readBackAmuxDmOwnerSettlementRemakeIdea;
};

/** The guard a claim's idea is committed under: checked, and the idea named on the claim. */
export const amuxDmOwnerSettlementRemakeGuard = (settlementId: string,
  remakeRequestId: string): AmuxIdeaSessionSubmissionGuard => ({
  check: (tx) => guardAmuxDmOwnerSettlementRemakeIntake(tx, { settlementId, remakeRequestId }),
  committed: (tx, ideaId) => recordAmuxDmOwnerSettlementRemakeIdea(tx, { settlementId, ideaId }),
});

const handOff = (settlementId: string, requestId: string, reason: string) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementHandoff,
    (tx, context) => recordAmuxDmOwnerSettlementHandoff(tx, { settlementId, requestId, reason,
      now: context.dbNow })).then(() => ({ applied: false, outcome: "handed_off" as const }));

const cancelMoved = (settlementId: string) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
    (tx, context) => cancelMovedAmuxDmOwnerSettlementClaim(tx, { settlementId, now: context.dbNow }));

const closeCards = (settlementId: string, ideaId: string) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
    (tx, context) => applyAmuxDmOwnerSettlementRemake(tx, { settlementId, ideaId, now: context.dbNow }));

/** Steps 2 and 3 of a claimed remake. */
export async function continueAmuxDmOwnerSettlementRemake(input: {
  settlementId: string; requestId: string; remakeRequestId: string; ideaText: string;
}, deps: AmuxDmOwnerSettlementRemakeDeps = {}): Promise<AmuxDmOwnerSettlementApplied> {
  const fileIdea = deps.fileIdea ?? fileAmuxDmOwnerSettlementRemakeIdea;
  const readBack = deps.readBack ?? readBackAmuxDmOwnerSettlementRemakeIdea;
  let filed: AmuxDmOwnerSettlementRemakeFiling = await fileIdea({ requestId: input.remakeRequestId,
    ideaText: input.ideaText,
    guard: amuxDmOwnerSettlementRemakeGuard(input.settlementId, input.remakeRequestId) })
    .catch((): AmuxDmOwnerSettlementRemakeFiling => ({ unknown: true }));
  if ("guarded" in filed) {
    // The commit wrote nothing. A Task that moved, or a person's answer, cancels
    // the claim; the kill switch or a card another writer holds leaves it to
    // the person; a claim that is no longer this one's needs nothing more.
    if (filed.guarded === "task_moved" || filed.guarded === "escalation_resolved")
      return cancelMoved(input.settlementId);
    if (filed.guarded === "kill_switch" || filed.guarded === "busy")
      return handOff(input.settlementId, input.requestId,
        filed.guarded === "busy" ? "remake_busy" : "remake_held");
    return { applied: false, outcome: null };
  }
  if ("unknown" in filed) filed = await readBack(input.remakeRequestId).catch(() => null) ??
    { refused: "outcome_unknown" };
  if ("refused" in filed)
    return handOff(input.settlementId, input.requestId,
      filed.refused === "outcome_unknown" ? "remake_unknown" : "remake_refused");
  if (!("ideaId" in filed)) return { applied: false, outcome: null };
  return closeCards(input.settlementId, filed.ideaId);
}

/**
 * A settlement answer after the operator's confirmation (the walk): the
 * answer applied in its own transaction, and a remake's idea filed only once
 * its claim has committed.
 */
export async function settleAmuxDmOwnerSettlementAnswer(input: {
  settlementId: string; answer: AmuxDmOwnerSettlementAnswer; source: "dm" | "dm_confirmed";
  requestId: string;
}, deps: AmuxDmOwnerSettlementRemakeDeps = {}): Promise<AmuxDmOwnerSettlementApplied> {
  const applied = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
    (tx, context) => applyAmuxDmOwnerSettlementDecision(tx, { settlementId: input.settlementId,
      answer: input.answer, source: input.source, requestId: input.requestId, now: context.dbNow }));
  if (applied.outcome !== "remake_claimed" || input.answer.decision !== "remake" ||
      !applied.remakeRequestId) return applied;
  const next = await continueAmuxDmOwnerSettlementRemake({ settlementId: input.settlementId,
    requestId: input.requestId, remakeRequestId: applied.remakeRequestId,
    ideaText: input.answer.ideaText }, deps);
  // The claim is the answer applied; what became of its idea is the settlement's record.
  return next.outcome === null ? applied : next;
}

/**
 * One claimed remake an earlier tick left unfinished. Nothing is filed: a
 * claim the intake's commit named an idea on closes its cards, one whose Task
 * moved is cancelled, and any other goes to the person once the idea is read
 * back and not there.
 */
export async function resumeAmuxDmOwnerSettlementRemake(deps: AmuxDmOwnerSettlementRemakeDeps = {}) {
  const stale = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementRemakeRead,
    (tx) => readStaleAmuxDmOwnerSettlementRemake(tx));
  if (!stale) return null;
  if (stale.remakeIdeaId) return closeCards(stale.settlementId, stale.remakeIdeaId);
  const cancelled = await cancelMoved(stale.settlementId);
  if (cancelled.outcome) return cancelled;
  const back = await (deps.readBack ?? readBackAmuxDmOwnerSettlementRemakeIdea)(stale.remakeRequestId)
    .catch(() => null);
  return back ? closeCards(stale.settlementId, back.ideaId) :
    handOff(stale.settlementId, stale.requestId, "remake_unknown");
}
