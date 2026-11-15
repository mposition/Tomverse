/**
 * A successful v22 result is never thrown away (owner decision 2026-11-15).
 *
 * A Task's run is admitted to publication when it starts. When that could not
 * happen -- the Publisher halted, the mode off, no public pull request
 * consent, the owner queue full, develop unreadable (`v22_publication_skipped`)
 * -- the run still executes, its reviewed patch is stored in
 * `AmuxV22TaskPatch`, and the Task goes to review with no pull request. Until
 * this decision that patch stayed private: the Decision Maker then ran the
 * Task again, and AMUX-IMGOUT-003 spent all five attempts while two results
 * that had passed review were discarded.
 *
 * Such a result is now *kept*: the newest attempt of a Task that ended
 * `succeeded` into `review`, whose patch body is still stored, and for which
 * no engineering run was ever opened. Once publication can open, it is put on
 * the same publication path settlement would have taken (tier judgement, then
 * a pull request or an owner's T2 draft; lib/amux/v22KeptResultPublication.ts),
 * and nothing asks to run it again: the Decision Maker's owner settlement does
 * not file a card that holds one (dmOwnerSettlementRead.ts).
 *
 * Why keep and publish later rather than hold write Tasks back at assignment:
 * every cause above is a state that changes while the result waits, and the
 * run is the expensive part. Holding assignment would idle workers on a
 * condition that usually clears within the hour and still lose the result of a
 * run already started when it set in; keeping costs one stored row and
 * spends no attempt.
 *
 * Pure: which attempt a card's review is for, and whether a kept result may be
 * published now.
 */

import { AMUX_V22_ENGINEERING_PUBLICATION_ENV, amuxV22EngineeringPublicationEnabled } from "./v22TaskExecutionCore.ts";
import { ENGINEERING_AGENT_LEGACY_HALTS_ENV, engineeringAgentLegacyHalts } from "../engineeringAgentCore.ts";

/** Read newest first; more attempts than this are never a card's review (the budget is 5). */
export const AMUX_V22_REVIEW_ATTEMPT_SCAN = 20;

export type AmuxV22ReviewAttemptRow = {
  id: string;
  endedAt: Date | string | null;
  outcome: string | null;
  toStatus: string | null;
};

/**
 * The attempt a card in review is waiting on: the newest one that ended
 * `succeeded` into `review`, or null while any attempt is still open. A later
 * attempt that failed, expired, or whose result was rejected back to todo
 * holds no review of its own, so it does not hide the accepted result before
 * it -- the kept result of a card that then used up its budget is still that
 * card's review (owner decision 2026-11-15). With `legacy`
 * (ENGINEERING_AGENT_LEGACY_HALTS) only the newest attempt counts, as before.
 */
export function amuxV22ReviewAttempt<T extends AmuxV22ReviewAttemptRow>(
  attemptsNewestFirst: readonly T[], legacy = false,
): T | null {
  if (legacy) {
    const last = attemptsNewestFirst[0];
    return last && last.endedAt !== null && last.outcome === "succeeded" && last.toStatus === "review" ? last : null;
  }
  for (const attempt of attemptsNewestFirst) {
    if (attempt.endedAt === null) return null;
    if (attempt.outcome === "succeeded" && attempt.toStatus === "review") return attempt;
  }
  return null;
}

/**
 * Whether kept results are published at all: v22 publication is on and the
 * kill switch is off. While they are not, a kept result is an ordinary private
 * result again, and the Decision Maker's owner settlement files it as before.
 */
export const amuxV22KeptResultPublicationEnabled = (env: Record<string, string | undefined> = process.env) =>
  !engineeringAgentLegacyHalts(env[ENGINEERING_AGENT_LEGACY_HALTS_ENV]) &&
  amuxV22EngineeringPublicationEnabled(env[AMUX_V22_ENGINEERING_PUBLICATION_ENV]);

export type AmuxV22KeptResultFacts = {
  publicationEnabled: boolean;
  legacy: boolean;
  orchestratorHalted: boolean;
  /** A run may be admitted at all: the mode is shadow or t1 and nothing is frozen. */
  claimAllowed: boolean;
  /** A public pull request may be written: the mode is t1 and nothing is frozen. */
  publishAllowed: boolean;
  mode: string;
  /** The Task's public pull request consent. */
  consent: boolean;
  /** The Task's status now: a kept result waits in review, or blocked once the budget is spent. */
  taskStatus: string;
};

export type AmuxV22KeptResultVerdict =
  | { publish: true; moveToReview: boolean; tierPending: boolean }
  | { publish: false; reason: "disabled" | "orchestrator_halted" | "engineering_off" | "shadow_mode" | "task_moved" };

/**
 * Whether a kept result goes on its way now, and how. Under `t1`, with nothing
 * frozen, it opens one of the two products settlement opens: with the Task's
 * public pull request consent, a draft whose tier the Publisher reads next,
 * which becomes a pull request or the owner's T2 draft; without it, the
 * owner's T2 draft directly -- an internal decision item with the patch,
 * never a public write -- which a person sends back to the tier round once
 * the consent is there (rejudgeEngineeringAgentV22Draft, which takes a run
 * that started under `t1`).
 *
 * Under `shadow` it waits (review r-20261115-115151-9e04dc): a run opened now
 * would be recorded as a shadow run for good, and a shadow run's product can
 * never become a pull request -- the database refuses its publish item and
 * the rejudge refuses its draft -- so the result would be stuck as a draft
 * once t1 returned. Kept, it is published then; meanwhile a person can still
 * settle it from the owner queue. An agent that is off or frozen, or a halted
 * AMUX, keeps it waiting too, and the next round asks again. A blocked card --
 * one whose later attempts failed until its budget ran out -- goes back to
 * review.
 */
export function decideAmuxV22KeptResult(facts: AmuxV22KeptResultFacts): AmuxV22KeptResultVerdict {
  if (!facts.publicationEnabled || facts.legacy) return { publish: false, reason: "disabled" };
  if (facts.orchestratorHalted) return { publish: false, reason: "orchestrator_halted" };
  if (facts.taskStatus !== "review" && facts.taskStatus !== "blocked") return { publish: false, reason: "task_moved" };
  if (!facts.claimAllowed) return { publish: false, reason: "engineering_off" };
  if (facts.mode !== "t1") return { publish: false, reason: facts.mode === "shadow" ? "shadow_mode" : "engineering_off" };
  return { publish: true, moveToReview: facts.taskStatus === "blocked",
    tierPending: facts.publishAllowed && facts.consent };
}
