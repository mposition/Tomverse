import type { AmuxExecutionLane } from "@/lib/amux/adminExecutionViewCore";
import {
  amuxIdeaLaneView, type AmuxIdeaLaneAttemptFact, type AmuxIdeaLaneCandidateFacts, type AmuxIdeaLaneState,
} from "@/lib/amux/ideaLaneCore";

/**
 * Idea lane work on the Execution board (owner request 2026-11-04). The lane
 * skips the card stages on purpose, so these are display rows next to the
 * cards, never AMUX Task rows: a real card would be picked up by the card
 * execution engine, approvals and dispatch, and run twice.
 */

/** How many of the owner's newest lane ideas the board shows. */
export const AMUX_IDEA_LANE_BOARD_LIMIT = 50;
/** A merged idea stays on the board this long; the Done history has no other rule. */
export const AMUX_IDEA_LANE_BOARD_DONE_MS = 7 * 86_400_000;

/** A board column, or the Done history under the board for a merged idea. */
export type AmuxIdeaLaneBoardColumn = Extract<AmuxExecutionLane, "amux_backlog" | "in_progress" | "in_review" |
  "attention"> | "done";

export type AmuxIdeaLaneBoardCard = {
  requestId: string;
  /** The body's first line (lib/amux/ideaTitleCore.ts); null once the body is purged. */
  title: string | null;
  column: AmuxIdeaLaneBoardColumn;
  state: AmuxIdeaLaneState["state"];
  prNumber: number | null;
  attempts: number;
};

const COLUMN: Record<AmuxIdeaLaneState["state"], AmuxIdeaLaneBoardColumn> = {
  queued: "amux_backlog", running: "in_progress", pr_open: "in_review", merged: "done",
  failed: "attention", pr_closed: "attention",
};

export const amuxIdeaLaneBoardColumn = (state: AmuxIdeaLaneState["state"]) => COLUMN[state];

export const amuxIdeaLaneBoardHref = (requestId: string) =>
  `/admin/amux-backlog?tab=ideas&idea=${encodeURIComponent(requestId)}`;

export type AmuxIdeaLaneBoardIdea = AmuxIdeaLaneCandidateFacts & {
  requestId: string; title: string | null; laneAttempts: AmuxIdeaLaneAttemptFact[];
};

/**
 * One idea's board card, or null when the lane has not taken it and will not
 * take it next, or its final part merged more than a week ago. The lane state is the
 * Ideas list's (amuxIdeaLaneView): attempts already made show with the lane
 * off; an idea waiting for its first run shows only while the lane is on.
 */
export function amuxIdeaLaneBoardCard(idea: AmuxIdeaLaneBoardIdea, nowMs: number,
  enabled: boolean): AmuxIdeaLaneBoardCard | null {
  const lane = amuxIdeaLaneView(idea.laneAttempts, nowMs, idea, enabled);
  if (!lane) return null;
  if (lane.state === "merged") {
    // lane.prNumber is the PR that settled the final part; an earlier part's merge does not count.
    const mergedAtMs = Math.min(...idea.laneAttempts.flatMap((item) =>
      item.outcome === "pr_open" && item.prNumber === lane.prNumber && item.mergedAtMs ? [item.mergedAtMs] : []));
    if (mergedAtMs <= nowMs - AMUX_IDEA_LANE_BOARD_DONE_MS) return null;
  }
  return { requestId: idea.requestId, title: idea.title, column: COLUMN[lane.state], state: lane.state,
    prNumber: lane.prNumber, attempts: lane.attempts };
}
