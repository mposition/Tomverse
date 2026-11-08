import type { AmuxIdeaProgressStage } from "./amux/ideaProgressCore.ts";
import { qaReleaseTrainNextDepartureMs } from "./qaReleaseTrainCore.ts";

/**
 * Presentation arithmetic for the Development screens of the Admin console
 * (Ideas, Execution board, Release, AMUX settings, Safety & recovery).
 *
 * Pure and free of React. Nothing here decides an approval, a budget or a
 * halt: it only maps rows the server already read onto the pictures the screens
 * draw (a five-step bar, a board column, a train route), so the mapping can be
 * tested without a browser.
 */

/** The five steps an idea walks, as the operator sees them. */
export const AMUX_IDEA_FLOW_STEPS = ["idea", "execution_approval", "plan_approval", "execution", "pr"] as const;
export type AmuxIdeaFlowStepId = (typeof AMUX_IDEA_FLOW_STEPS)[number];
export type AdminFlowStepState = "done" | "current" | "attention" | "todo";

/**
 * Where an idea stands on the five-step bar, from the stage the progress read
 * decided (`lib/amux/ideaProgressCore.ts`). Analysis runs between the two
 * approvals, so an analysing idea has its execution approval behind it and its
 * plan approval ahead. A cancelled idea has no bar (null). `attention` marks
 * the current step when something stopped there that nobody has looked at.
 */
export function amuxIdeaFlowSteps(
  stage: AmuxIdeaProgressStage,
  options: { attention?: boolean } = {}
): Array<{ id: AmuxIdeaFlowStepId; state: AdminFlowStepState }> | null {
  if (stage === "cancelled") return null;
  const current: Record<Exclude<AmuxIdeaProgressStage, "cancelled">, number> = {
    execution_approval: 1,
    analysis: 2,
    plan_approval: 2,
    execution: 3,
    review: 4,
    done: AMUX_IDEA_FLOW_STEPS.length,
  };
  const at = current[stage];
  return AMUX_IDEA_FLOW_STEPS.map((id, index) => ({
    id,
    state: index < at ? "done" : index === at ? (options.attention ? "attention" : "current") : "todo",
  }));
}

export type AmuxWorkerChannel = "claude" | "codex" | "copilot" | "cursor";
export const AMUX_WORKER_CHANNELS: readonly AmuxWorkerChannel[] = ["claude", "codex", "copilot", "cursor"];

/**
 * Each registered worker's channel (the CLI it runs), from the class it was
 * registered with. A name says nothing about it (the registry registers the two
 * independently), so a worker that is not registered, or whose class is not one
 * of the four channels, has none and is drawn without a badge.
 */
export function amuxWorkerChannels(
  rows: ReadonlyArray<{ workerName: string; providerClass: string }>
): Record<string, AmuxWorkerChannel> {
  const channels: Record<string, AmuxWorkerChannel> = {};
  for (const row of rows) {
    const channel = AMUX_WORKER_CHANNELS.find((candidate) => candidate === row.providerClass);
    if (channel) channels[row.workerName] = channel;
  }
  return channels;
}

export type AmuxBoardColumn = "waiting" | "approval" | "running" | "review" | "done";
export const AMUX_BOARD_COLUMNS: readonly AmuxBoardColumn[] = ["waiting", "approval", "running", "review", "done"];

/** Escalation reasons that ask the owner to decide; any other reason means the work itself stopped. */
const APPROVAL_REASONS: ReadonlySet<string> = new Set([
  "human_review_required",
  "canonical_deadline_review_required",
  "local_card_closed",
  "local_card_unlinked",
  "local_card_ambiguous",
]);

/**
 * The board column a lane is drawn in. The six server lanes stay as they are
 * (the board snapshot, its paging, its counts and the moves are unchanged);
 * this only groups them: the three waiting lanes become one column with a
 * sub-list each, and the whole attention lane is the column of what waits for
 * the owner, so its count stays the server's count.
 */
export function amuxBoardColumn(lane: string): AmuxBoardColumn {
  switch (lane) {
    case "tomverse_backlog":
    case "amux_backlog":
    case "todo":
      return "waiting";
    case "in_progress":
      return "running";
    case "in_review":
      return "review";
    case "attention":
      return "approval";
    default:
      return "done";
  }
}

/**
 * A card in the attention lane whose reason is the work stopping (a lost run,
 * an unknown outcome, a limit) rather than the owner being asked. It is drawn
 * with a red edge and a way to Safety & recovery; the owner's open question or
 * review always wins, because that is what the card is waiting for.
 */
export const amuxBoardCardStuck = (input: { lane: string; attentionReason: string | null; ownerQuestion: "open" | "answered" | null }) =>
  input.lane === "attention" && input.ownerQuestion !== "open" &&
  input.attentionReason !== null && !APPROVAL_REASONS.has(input.attentionReason);

/** How long ago, in the largest whole unit; null for a time that cannot be read. */
export function amuxElapsed(fromMs: number, nowMs: number): { value: number; unit: "minute" | "hour" | "day" } | null {
  if (!Number.isFinite(fromMs) || !Number.isFinite(nowMs)) return null;
  const minutes = Math.max(0, Math.floor((nowMs - fromMs) / 60_000));
  if (minutes < 60) return { value: minutes, unit: "minute" };
  if (minutes < 1440) return { value: Math.floor(minutes / 60), unit: "hour" };
  return { value: Math.floor(minutes / 1440), unit: "day" };
}

const AEST_OFFSET_MS = 10 * 60 * 60 * 1000;

export type TrainStopState = "departed" | "missed" | "next" | "upcoming";

/**
 * Today's route (AEST): each departure hour and whether its train left. A
 * past hour is `departed` only when an admission for it was recorded; a past
 * hour with none is `missed` (nothing to carry, or it did not run), never
 * assumed to have left. The first hour still ahead is `next`.
 */
export function qaTrainRoute(
  nowMs: number,
  hours: readonly number[],
  admittedHours: ReadonlySet<number>
): Array<{ hour: number; state: TrainStopState }> {
  const aest = new Date(nowMs + AEST_OFFSET_MS);
  const nowMinutes = aest.getUTCHours() * 60 + aest.getUTCMinutes();
  const sorted = [...new Set(hours)].sort((a, b) => a - b);
  const nextHour = sorted.find((hour) => hour * 60 > nowMinutes);
  return sorted.map((hour) => ({
    hour,
    state: hour === nextHour ? "next" : hour * 60 <= nowMinutes ? (admittedHours.has(hour) ? "departed" : "missed") : "upcoming",
  }));
}

/** The next departure (today's or tomorrow's) and the whole minutes until it; null with no hours. */
export function qaTrainNext(nowMs: number, hours: readonly number[]): { departsAtMs: number; minutes: number } | null {
  const departsAtMs = qaReleaseTrainNextDepartureMs(nowMs, hours);
  return departsAtMs === null ? null : { departsAtMs, minutes: Math.max(0, Math.ceil((departsAtMs - nowMs) / 60_000)) };
}

/** The hour of an admission slot id (`YYYYMMDD-HHMM`) when it belongs to the AEST day of `nowMs`, else null. */
export function qaTrainSlotHourToday(slot: string, nowMs: number): number | null {
  const match = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/.exec(slot);
  if (!match) return null;
  const aest = new Date(nowMs + AEST_OFFSET_MS);
  const today = `${aest.getUTCFullYear()}${String(aest.getUTCMonth() + 1).padStart(2, "0")}${String(aest.getUTCDate()).padStart(2, "0")}`;
  return `${match[1]}${match[2]}${match[3]}` === today ? Number(match[4]) : null;
}

/** A fraction in [0, 1] for a bar; null when a side is unknown or the whole is not positive. */
export function amuxBarFraction(part: number | null, whole: number | null): number | null {
  if (part === null || whole === null || !Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return null;
  return Math.min(1, Math.max(0, part / whole));
}

export type AmuxCardStatusGroup = "waiting" | "running" | "review" | "done" | "blocked" | "cancelled" | "other";

/**
 * The group a card's stored status counts in. `backlog` and `todo` both wait
 * for a worker; a status this table does not know is `other`, which counts only
 * in the total, never as one of the named groups.
 */
export function amuxCardStatusGroup(status: string): AmuxCardStatusGroup {
  switch (status) {
    case "backlog":
    case "todo":
      return "waiting";
    case "doing":
      return "running";
    case "review":
      return "review";
    case "done":
      return "done";
    case "blocked":
      return "blocked";
    case "cancelled":
      return "cancelled";
    default:
      return "other";
  }
}
