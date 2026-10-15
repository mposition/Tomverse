/**
 * The approved v49 backlog redesign shows each idea at one of six stages
 * (execution approval → analysis → plan approval → execution → PR review and
 * merge → done), and lifts the human ones into "decide now". This is the one
 * place that decides the stage from the rows the bounded read returns; it is
 * pure and never guesses: an unknown or stopped outcome is its own flag.
 *
 * Signals (prisma/schema.prisma):
 * - the idea: `AmuxIdeaSubmission.state`, `analysisCompletedAt`, `cancelledAt`;
 * - each chunk's current preview and its budget hold (execution approval
 *   confirms the preview and reserves the hold; the analysis agent claims it);
 * - proposed draft units (the plan waiting for approval);
 * - the Task cards a consumed `register_card` decision created, with their
 *   status, review PR number and `v4TerminalAt` (set when the merge is
 *   observed).
 */

export const AMUX_IDEA_PROGRESS_STAGES = [
  "execution_approval", "analysis", "plan_approval", "execution", "review", "done",
] as const;
export type AmuxIdeaProgressStage = typeof AMUX_IDEA_PROGRESS_STAGES[number] | "cancelled";

export type AmuxIdeaProgressFacts = {
  state: string;
  analysisCompleted: boolean;
  cancelled: boolean;
  /** Each chunk's current preview state and its hold status, if any. */
  previews: Array<{ state: string; holdStatus: string | null }>;
  chunkStates: string[];
  proposedUnits: number;
  /** The idea's own registered cards (stories and tasks). */
  cards: Array<{ cardType: string | null; status: string; reviewPrNumber: number | null; terminal: boolean }>;
};

export type AmuxIdeaProgress = {
  stage: AmuxIdeaProgressStage;
  /** A human decision is waiting in this stage (execution or plan approval). */
  decisionWaiting: boolean;
  /** Something stopped with an unknown outcome; it is never retried automatically. */
  attention: boolean;
  tasks: { total: number; done: number; inReview: number };
};

const UNKNOWN = new Set(["outcome_unknown"]);
const ANALYSIS_PREVIEW = new Set(["confirmed", "in_flight"]);
const ANALYSIS_HOLD = new Set(["reserved", "in_flight"]);

export function amuxIdeaProgress(facts: AmuxIdeaProgressFacts): AmuxIdeaProgress {
  const tasks = facts.cards.filter((card) => card.cardType !== "story");
  const counts = {
    total: tasks.length,
    done: tasks.filter((task) => task.terminal).length,
    inReview: tasks.filter((task) => !task.terminal && task.status === "review" && task.reviewPrNumber !== null).length,
  };
  const attention = facts.previews.some((preview) => UNKNOWN.has(preview.state) ||
    (preview.holdStatus !== null && UNKNOWN.has(preview.holdStatus))) ||
    facts.chunkStates.some((state) => UNKNOWN.has(state));
  const at = (stage: AmuxIdeaProgressStage, decisionWaiting = false): AmuxIdeaProgress =>
    ({ stage, decisionWaiting: decisionWaiting && !attention, attention, tasks: counts });

  if (facts.cancelled || facts.state === "cancelled") return at("cancelled");
  if (counts.total > 0) {
    if (counts.done === counts.total) return at("done");
    return at(counts.inReview > 0 ? "review" : "execution");
  }
  // Cards registered without a Task yet (stories only) are still execution.
  if (facts.cards.length > 0) return at("execution");
  if (facts.proposedUnits > 0 && (facts.analysisCompleted || facts.state === "awaiting_owner")) {
    return at("plan_approval", true);
  }
  if (facts.state === "analyzing" || facts.previews.some((preview) =>
    ANALYSIS_PREVIEW.has(preview.state) ||
    (preview.holdStatus !== null && ANALYSIS_HOLD.has(preview.holdStatus)))) {
    return at("analysis");
  }
  return at("execution_approval", true);
}

/** Position of a stage on the six-step bar; cancelled has none. */
export function amuxIdeaProgressStep(stage: AmuxIdeaProgressStage): number | null {
  const index = (AMUX_IDEA_PROGRESS_STAGES as readonly string[]).indexOf(stage);
  return index < 0 ? null : index + 1;
}
