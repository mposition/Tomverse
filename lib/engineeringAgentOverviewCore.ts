/**
 * Pure derivations for the engineering agent's overview tab: how a pull
 * request binding reads to a person, how long a run took to open one, and how
 * the agent's own state reads in its page head. No database, no clock.
 */

import type { AgentOfficeEngineeringState } from "@/lib/agentOffice/live";
import type { AdminTone } from "@/lib/adminUiCore";

export type EngineeringPrRow = {
  prNumber: number;
  runId: string;
  /** The binding's own state: open or closed. */
  state: string;
  /** A person with authority approved it and its required checks passed (the agent's own observation). */
  approved: boolean;
  /** The merge observation; null until one is recorded. */
  merged: boolean | null;
  createdAt: string;
};

/**
 * `merged`: done. `ready`: approved and checks passed, so only a person's
 * merge is left, and that is the one to look at first. `waiting`: open, not
 * approved yet. `closed`: closed without a merge.
 */
export type EngineeringPrKind = "merged" | "ready" | "waiting" | "closed";

export function classifyEngineeringPr(row: Pick<EngineeringPrRow, "state" | "approved" | "merged">): EngineeringPrKind {
  if (row.merged === true) return "merged";
  if (row.state !== "open") return "closed";
  return row.approved ? "ready" : "waiting";
}

/**
 * Minutes from a run's start to the first pull request it opened, one number
 * per run, oldest first, for the newest `limit` runs that opened one. A row
 * whose times do not read, or that run backwards, is dropped rather than
 * drawn as zero.
 */
export function minutesToFirstPullRequest(
  rows: ReadonlyArray<{ runId: string; createdAt: Date | string; runStartedAt: Date | string }>,
  limit = 14,
): number[] {
  const earliest = new Map<string, { opened: number; started: number }>();
  for (const row of rows) {
    const opened = new Date(row.createdAt).getTime();
    const started = new Date(row.runStartedAt).getTime();
    if (!Number.isFinite(opened) || !Number.isFinite(started) || opened < started) continue;
    const seen = earliest.get(row.runId);
    if (!seen || opened < seen.opened) earliest.set(row.runId, { opened, started });
  }
  return [...earliest.values()]
    .sort((a, b) => b.opened - a.opened)
    .slice(0, limit)
    .reverse()
    .map((entry) => Math.round((entry.opened - entry.started) / 60_000));
}

export type EngineeringHeadStatus = "working" | "watching" | "observing" | "off" | "stopped" | "frozen" | "unknown";

/** How the page head names the agent, from its own switch and halt reading. */
export function engineeringHeadStatus(state: AgentOfficeEngineeringState): {
  status: EngineeringHeadStatus;
  tone: AdminTone;
  autoRun: "on" | "off" | "unknown";
} {
  if (state.kind === "unread") return { status: "unknown", tone: "unknown", autoRun: "unknown" };
  if (state.killSwitch || state.mode === "off") return { status: "off", tone: "idle", autoRun: "off" };
  if (state.halt !== "none") return { status: "stopped", tone: "bad", autoRun: "on" };
  if (state.frozen) return { status: "frozen", tone: "warn", autoRun: "on" };
  if (state.mode === "shadow") return { status: "observing", tone: "info", autoRun: "on" };
  return state.activeRuns > 0
    ? { status: "working", tone: "ok", autoRun: "on" }
    : { status: "watching", tone: "ok", autoRun: "on" };
}
