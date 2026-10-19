import { amuxDatabaseDiagnosticCode } from "./readFailureCore.ts";

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
export type AmuxIdeaWaitingFor = "execution_approval" | "continuation" | "owner_input" | "plan_approval" |
  "session_review";

export type AmuxIdeaProgressFacts = {
  state: string;
  submissionOrigin?: "owner" | "session";
  cancelled: boolean;
  chunks: Array<{
    chunkIndex: number; state: string; coverageStatus: string | null;
    previewState: string | null; holdStatus: string | null;
  }>;
  proposedUnits: number;
  /** The idea's own registered cards (stories and tasks). */
  /** `merged`: v4TerminalAt is set (the merge was observed); a cancelled card is closed but not merged. */
  cards: Array<{ cardType: string | null; status: string; reviewPrNumber: number | null; merged: boolean }>;
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
const FINISHED = new Set(["draft_ready", "partially_decided", "decided"]);

export function amuxIdeaProgress(facts: AmuxIdeaProgressFacts): AmuxIdeaProgress {
  const tasks = facts.cards.filter((card) => card.cardType !== "story");
  const closed = (task: (typeof tasks)[number]) => task.merged || task.status === "cancelled";
  const counts = {
    total: tasks.length,
    done: tasks.filter((task) => task.merged).length,
    inReview: tasks.filter((task) => !closed(task) && task.status === "review" && task.reviewPrNumber !== null).length,
  };
  // Pages run in order, so the latest page says what happens now; a stale
  // hold or unknown outcome left on an earlier page never hides a human step.
  const latest = facts.chunks.reduce<AmuxIdeaProgressFacts["chunks"][number] | null>(
    (last, chunk) => !last || chunk.chunkIndex > last.chunkIndex ? chunk : last, null);
  const attention = latest !== null && (latest.state === UNKNOWN ||
    latest.previewState === UNKNOWN || latest.holdStatus === UNKNOWN);
  const at = (stage: AmuxIdeaProgressStage, waitingFor: AmuxIdeaWaitingFor | null = null): AmuxIdeaProgress =>
    ({ stage, waitingFor: attention ? null : waitingFor, attention, tasks: counts });

  if (facts.cancelled || facts.state === "cancelled") return at("cancelled");
  if (latest && (latest.state === "in_flight" ||
    (latest.previewState !== null && ACTIVE_PREVIEW.has(latest.previewState)) ||
    (latest.holdStatus !== null && ACTIVE_HOLD.has(latest.holdStatus)))) {
    return at("analysis");
  }
  if (latest?.coverageStatus === "needs_owner_input") return at("execution_approval", "owner_input");
  if (latest?.coverageStatus === "more") return at("execution_approval", "continuation");
  if (latest && latest.chunkIndex > 0 && NOT_YET_SENT.has(latest.state)) {
    return at("execution_approval", "continuation");
  }
  if (facts.proposedUnits > 0) return at("plan_approval", "plan_approval");

  if (counts.total > 0) {
    if (tasks.every(closed)) return at(counts.done > 0 ? "done" : "cancelled");
    return at(counts.inReview > 0 ? "review" : "execution");
  }
  // Cards registered without a Task yet (stories only) are still execution.
  if (facts.cards.length > 0) return at("execution");
  if (facts.state === "analyzing") return at("analysis");
  // An analysis that finished with nothing left to decide (rejected, or every
  // proposal refused or expired) waits for nobody.
  if (latest && FINISHED.has(latest.state)) return at("plan_approval");
  // v19 session submissions have no per-idea execution approval. Their
  // append-only reservation waits for automatic analysis, not a human step.
  if (facts.submissionOrigin === "session" && facts.state === "submitted") {
    return at("analysis");
  }
  // A v19 session answer that could not become a plan (invalid, an owner
  // question or a continuation page) leaves the queue with no plan rows; the
  // operator decides what to do with the idea.
  if (facts.submissionOrigin === "session" && facts.state === "awaiting_owner" &&
      facts.chunks.length === 0) {
    return at("analysis", "session_review");
  }
  return at("execution_approval", "execution_approval");
}

/** Position of a stage on the six-step bar; cancelled has none. */
export function amuxIdeaProgressStep(stage: AmuxIdeaProgressStage): number | null {
  const index = (AMUX_IDEA_PROGRESS_STAGES as readonly string[]).indexOf(stage);
  return index < 0 ? null : index + 1;
}

/**
 * What the page logs when the progress read fails: codes and class names only,
 * never a message, a query, a parameter or a row. The Ideas tab used to log
 * the bare event, so a production failure could not be told apart (a busy
 * database, a statement timeout, a missing column and a refused boundary all
 * looked the same).
 */
export function amuxIdeaProgressFailureLog(error: unknown): {
  subsystem: "amux"; event: "idea_progress_read_failed";
  name: string | null; boundaryCode: string | null; prismaCode: string | null; sqlState: string | null;
  signal: "connection_closed" | "timeout" | null;
} {
  const record = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const cause = (record.cause && typeof record.cause === "object" ? record.cause : {}) as Record<string, unknown>;
  const short = (value: unknown, pattern: RegExp) =>
    typeof value === "string" && pattern.test(value) ? value : null;
  // A session ended for idling in its transaction (SQLSTATE 25P03) reaches the pg client as a
  // plain Error with no code at all ("Client has encountered a connection error and is not
  // queryable"). The message is matched against fixed patterns and only the class is logged,
  // never the text: the text of a database error can carry a query or a value.
  const text = typeof record.message === "string" ? record.message : "";
  const signal = /not queryable|connection (?:error|terminated|closed)|terminating connection|ECONNRESET/i.test(text)
    ? "connection_closed" as const : /time(?:d)? ?out/i.test(text) ? "timeout" as const : null;
  return {
    subsystem: "amux",
    event: "idea_progress_read_failed",
    name: short(record.name, /^[A-Za-z][A-Za-z0-9]{0,63}$/),
    boundaryCode: short(record.code, /^AMUX_DB_[A-Z_]{1,48}$/),
    prismaCode: short(record.code, /^P\d{4}$/) ?? short(cause.code, /^P\d{4}$/),
    sqlState: amuxDatabaseDiagnosticCode(error),
    signal,
  };
}
