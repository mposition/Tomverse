/**
 * The approved v49 backlog redesign shows each idea at one of six stages
 * (execution approval → analysis → plan approval → execution → PR review and
 * merge → done), and lifts the human ones into "decide now". This is the one
 * place that decides the stage from the rows the bounded read returns; it is
 * pure and never guesses: an unknown or stopped outcome is its own flag.
 *
 * Signals (prisma/schema.prisma):
 * - the idea: `AmuxIdeaSubmission.state`, `cancelledAt`;
 * - each chunk (state, coverage, continuation) and its current preview and
 *   budget hold: execution approval confirms the preview and reserves the
 *   hold, the analysis agent claims it, a page with `coverageStatus = more`
 *   needs the next page's transfer approved, and `needs_owner_input` waits
 *   for the operator's answer;
 * - proposed draft units (the plan waiting for approval);
 * - the Task cards a consumed `register_card` decision created, with their
 *   status, review PR number and `v4TerminalAt` (set when the merge is
 *   observed).
 *
 * A human step still open always wins over card progress: an idea with some
 * cards registered and proposals still undecided is waiting for its plan
 * approval, not done.
 */

export const AMUX_IDEA_PROGRESS_STAGES = [
  "execution_approval", "analysis", "plan_approval", "execution", "review", "done",
] as const;
export type AmuxIdeaProgressStage = typeof AMUX_IDEA_PROGRESS_STAGES[number] | "cancelled";
/** What a person must do next, when anything. */
export type AmuxIdeaWaitingFor = "execution_approval" | "continuation" | "owner_input" | "plan_approval";

export type AmuxIdeaProgressFacts = {
  state: string;
  cancelled: boolean;
  chunks: Array<{
    chunkIndex: number; state: string; coverageStatus: string | null;
    previewState: string | null; holdStatus: string | null;
  }>;
  proposedUnits: number;
  /** The idea's own registered cards (stories and tasks). */
  cards: Array<{ cardType: string | null; status: string; reviewPrNumber: number | null; terminal: boolean }>;
};

export type AmuxIdeaProgress = {
  stage: AmuxIdeaProgressStage;
  /** The human step waiting, or null; never set while an outcome is unknown. */
  waitingFor: AmuxIdeaWaitingFor | null;
  /** Something stopped with an unknown outcome; it is never retried automatically. */
  attention: boolean;
  tasks: { total: number; done: number; inReview: number };
};

const UNKNOWN = "outcome_unknown";
const ACTIVE_PREVIEW = new Set(["confirmed", "in_flight"]);
const ACTIVE_HOLD = new Set(["reserved", "in_flight"]);
const NOT_YET_SENT = new Set(["pending", "collecting", "awaiting_preview"]);

export function amuxIdeaProgress(facts: AmuxIdeaProgressFacts): AmuxIdeaProgress {
  const tasks = facts.cards.filter((card) => card.cardType !== "story");
  const counts = {
    total: tasks.length,
    done: tasks.filter((task) => task.terminal).length,
    inReview: tasks.filter((task) => !task.terminal && task.status === "review" && task.reviewPrNumber !== null).length,
  };
  const attention = facts.chunks.some((chunk) => chunk.state === UNKNOWN ||
    chunk.previewState === UNKNOWN || chunk.holdStatus === UNKNOWN);
  const at = (stage: AmuxIdeaProgressStage, waitingFor: AmuxIdeaWaitingFor | null = null): AmuxIdeaProgress =>
    ({ stage, waitingFor: attention ? null : waitingFor, attention, tasks: counts });

  if (facts.cancelled || facts.state === "cancelled") return at("cancelled");
  const analysisActive = facts.chunks.some((chunk) => chunk.state === "in_flight" ||
    (chunk.previewState !== null && ACTIVE_PREVIEW.has(chunk.previewState)) ||
    (chunk.holdStatus !== null && ACTIVE_HOLD.has(chunk.holdStatus)));
  if (analysisActive) return at("analysis");

  const latest = facts.chunks.reduce<AmuxIdeaProgressFacts["chunks"][number] | null>(
    (last, chunk) => !last || chunk.chunkIndex > last.chunkIndex ? chunk : last, null);
  if (latest?.coverageStatus === "needs_owner_input") return at("execution_approval", "owner_input");
  if (latest?.coverageStatus === "more") return at("execution_approval", "continuation");
  if (latest && latest.chunkIndex > 0 && NOT_YET_SENT.has(latest.state)) {
    return at("execution_approval", "continuation");
  }
  if (facts.proposedUnits > 0) return at("plan_approval", "plan_approval");

  if (counts.total > 0) {
    if (counts.done === counts.total) return at("done");
    return at(counts.inReview > 0 ? "review" : "execution");
  }
  // Cards registered without a Task yet (stories only) are still execution.
  if (facts.cards.length > 0) return at("execution");
  if (facts.state === "analyzing") return at("analysis");
  return at("execution_approval", "execution_approval");
}

/** Position of a stage on the six-step bar; cancelled has none. */
export function amuxIdeaProgressStep(stage: AmuxIdeaProgressStage): number | null {
  const index = (AMUX_IDEA_PROGRESS_STAGES as readonly string[]).indexOf(stage);
  return index < 0 ? null : index + 1;
}
