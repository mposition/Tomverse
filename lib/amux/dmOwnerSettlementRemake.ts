import "server-only";

import { AMUX_DB_BOUNDARIES, withAmuxDbBoundary } from "@/lib/amux/dbBoundary";
import type { AmuxDmOwnerSettlementAnswer } from "./dmOwnerSettlementCore.ts";
import {
  applyAmuxDmOwnerSettlementDecision, applyAmuxDmOwnerSettlementRemake,
  readAmuxDmOwnerSettlementRemakeLive, readStaleAmuxDmOwnerSettlementRemake,
  recordAmuxDmOwnerSettlementHandoff, type AmuxDmOwnerSettlementApplied,
} from "./dmOwnerSettlementService.ts";
import { AMUX_SESSION_INTAKE_READBACK_ENV, amuxSessionIntakeReadbackEnabled } from
  "./ideaSessionIntakeReadbackCore.ts";
import {
  AMUX_SESSION_INTAKE_ENV, amuxIdeaSessionPrewriteStatus, amuxSessionIntakeWritePermitted,
  inspectAmuxIdeaSessionSubmission,
} from "./ideaSessionSubmissionCore.ts";
import {
  AmuxIdeaSessionSubmissionError, readAmuxIdeaSessionSubmissionRequest, submitAmuxIdeaFromSession,
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
 *    kill switch and the claim are read again just before it; a claim that no
 *    longer stands files nothing, and the kill switch hands it to the person.
 *    A refusal goes to the person; an outcome nobody knows is read back once
 *    under the same request id and, when the idea is not there, goes to the
 *    person -- it is never filed again.
 * 3. The close of the card and the unstarted cards waiting on it, with the
 *    idea's id (applyAmuxDmOwnerSettlementRemake).
 *
 * A claim whose steps 2 and 3 never ended (a lost answer, a held close) is
 * finished by a later tick from step 2's read-back alone.
 */

const REPOSITORY = "mposition/Tomverse";

export type AmuxDmOwnerSettlementRemakeFiling =
  | { ideaId: string } | { refused: string } | { unknown: true };

const intakeOn = () =>
  amuxSessionIntakeWritePermitted(process.env[AMUX_SESSION_INTAKE_ENV], process.env[AMUX_V4_IDEA_SUBMISSION_ENV]) &&
  amuxSessionIntakeReadbackEnabled(process.env[AMUX_SESSION_INTAKE_READBACK_ENV], process.env[AMUX_V4_IDEA_READBACK_ENV]);

/** The idea a request id committed, read back; null when it is not there, or only partly. */
export async function readBackAmuxDmOwnerSettlementRemakeIdea(requestId: string) {
  const seen = await readAmuxIdeaSessionSubmissionRequest(requestId);
  return seen.status === "committed" ? { ideaId: seen.ideaId } : null;
}

/** Files the remake's idea once under its request id; an idea already there is read back. */
export async function fileAmuxDmOwnerSettlementRemakeIdea(input: {
  requestId: string; ideaText: string;
}): Promise<AmuxDmOwnerSettlementRemakeFiling> {
  if (!intakeOn()) return { refused: "intake_disabled" };
  const seen = await readAmuxIdeaSessionSubmissionRequest(input.requestId);
  if (seen.status === "committed") return { ideaId: seen.ideaId };
  if (seen.status === "partial") return { unknown: true };
  const inspected = inspectAmuxIdeaSessionSubmission({ version: 1, requestId: input.requestId,
    input: { version: 1, idea: input.ideaText, repositories: [REPOSITORY], pullRequests: [] },
    source: { toolName: "tomverse-amux-decision-maker", modelProvider: "decision-maker",
      sessionDisplay: "Decision Maker remake of a stopped card" } });
  if (!inspected.ok) return { refused: "idea_refused" };
  try {
    return { ideaId: (await submitAmuxIdeaFromSession({ inspected })).ideaId };
  } catch (error) {
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

const handOff = (settlementId: string, requestId: string, reason: string) =>
  withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementHandoff,
    (tx, context) => recordAmuxDmOwnerSettlementHandoff(tx, { settlementId, requestId, reason,
      now: context.dbNow })).then(() => ({ applied: false, outcome: "handed_off" as const }));

/**
 * Steps 2 and 3 of a claimed remake. `ideaText` null finishes an old claim
 * from the read-back alone: nothing new is filed then.
 */
export async function continueAmuxDmOwnerSettlementRemake(input: {
  settlementId: string; requestId: string; remakeRequestId: string; ideaText: string | null;
}, deps: AmuxDmOwnerSettlementRemakeDeps = {}): Promise<AmuxDmOwnerSettlementApplied> {
  const fileIdea = deps.fileIdea ?? fileAmuxDmOwnerSettlementRemakeIdea;
  const readBack = deps.readBack ?? readBackAmuxDmOwnerSettlementRemakeIdea;
  const live = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementRemakeRead,
    (tx) => readAmuxDmOwnerSettlementRemakeLive(tx, input.settlementId));
  // The claim no longer stands (a person moved the card, or it was handed
  // over): nothing is filed, and the sync cancels a claim whose Task moved.
  if (!live.live) return { applied: false, outcome: null };
  if (live.killSwitch !== false) return handOff(input.settlementId, input.requestId, "remake_held");
  let filed: AmuxDmOwnerSettlementRemakeFiling = input.ideaText === null ? { unknown: true } :
    await fileIdea({ requestId: input.remakeRequestId, ideaText: input.ideaText })
      .catch((): AmuxDmOwnerSettlementRemakeFiling => ({ unknown: true }));
  if ("unknown" in filed) filed = await readBack(input.remakeRequestId).catch(() => null) ??
    { refused: "outcome_unknown" };
  if ("refused" in filed)
    return handOff(input.settlementId, input.requestId,
      filed.refused === "outcome_unknown" ? "remake_unknown" : "remake_refused");
  const ideaId = filed.ideaId;
  return withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementApply,
    (tx, context) => applyAmuxDmOwnerSettlementRemake(tx, { settlementId: input.settlementId,
      ideaId, now: context.dbNow }));
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

/** One claimed remake an earlier tick left unfinished: finished, or handed to the person. */
export async function resumeAmuxDmOwnerSettlementRemake(deps: AmuxDmOwnerSettlementRemakeDeps = {}) {
  const stale = await withAmuxDbBoundary(AMUX_DB_BOUNDARIES.decisionMakerOwnerSettlementRemakeRead,
    (tx) => readStaleAmuxDmOwnerSettlementRemake(tx));
  if (!stale) return null;
  return continueAmuxDmOwnerSettlementRemake({ settlementId: stale.settlementId,
    requestId: stale.requestId, remakeRequestId: stale.remakeRequestId, ideaText: null }, deps);
}
