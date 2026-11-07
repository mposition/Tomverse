/**
 * What the engineering agent's page head and Overview tab read. Read only:
 * the agent's own switch and halt resolution (the same one the Agent office
 * uses), the pull request bindings it recorded, and counts of what waits for a
 * person. Every part is read on its own, so one failing read leaves the others
 * usable, and a part that did not read is null, never zero (admin IA rule 8).
 *
 * No patch body, reason or card is selected: the overview says how the agent
 * stands and which pull requests wait on a person, never what a patch holds.
 */

import "server-only";

import { Prisma } from "@prisma/client";

import type { AgentOfficeEngineeringState } from "@/lib/agentOffice/live";
import {
  AGENT_OFFICE_ENGINEERING_SETTING_KEYS,
  agentOfficeEngineeringState,
} from "@/lib/agentOfficeEngineeringState";
import { ENGINEERING_AGENT_KILL_SWITCH_ENV, OWNER_ITEM_KINDS } from "@/lib/engineeringAgentCore";
import {
  classifyEngineeringPr,
  minutesToFirstPullRequest,
  type EngineeringPrRow,
} from "@/lib/engineeringAgentOverviewCore";
import { currentEngineeringAgentHalt, readEngineeringAgentHaltState } from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

/** How many pull requests the overview lists; the screen links to the full record. */
export const ENGINEERING_OVERVIEW_PR_LIMIT = 5;

/** The agent's own state, for the page head and the tab chips. `unread` when any part failed. */
export async function readEngineeringAgentHead(): Promise<AgentOfficeEngineeringState> {
  try {
    const [settings, haltState, owner, active, lastRun] = await Promise.all([
      prisma.appSetting.findMany({
        where: { key: { in: AGENT_OFFICE_ENGINEERING_SETTING_KEYS } },
        select: { key: true, value: true },
      }),
      readEngineeringAgentHaltState(prisma),
      prisma.engineeringAgentWorkItem.groupBy({
        by: ["kind"],
        where: { kind: { in: [...OWNER_ITEM_KINDS] }, state: "open" },
        _count: { _all: true },
      }),
      prisma.engineeringAgentRun.aggregate({
        where: { status: "active" },
        _count: { _all: true },
        _min: { startedAt: true },
      }),
      prisma.engineeringAgentRun.findFirst({
        where: { status: { in: ["finished", "abandoned"] }, endedAt: { not: null } },
        orderBy: [{ endedAt: "desc" }, { id: "desc" }],
        select: { status: true, outcome: true, startedAt: true, endedAt: true },
      }),
    ]);
    return agentOfficeEngineeringState({
      settings,
      killSwitch: process.env[ENGINEERING_AGENT_KILL_SWITCH_ENV],
      halt: currentEngineeringAgentHalt(haltState),
      openOwnerItems: owner.map((row) => ({ kind: row.kind, count: row._count._all })),
      active: { count: active._count._all, since: active._min.startedAt },
      lastRun,
    });
  } catch {
    console.warn({ event: "admin_engineering_overview_read_failed", read: "head" });
    return { kind: "unread" };
  }
}

export type EngineeringOverviewBody = {
  /** Open pull requests of the agent; null when they could not be counted. */
  openPrs: number | null;
  /** The newest bindings and what each is waiting for; null when they could not be read. */
  pullRequests: EngineeringPrRow[] | null;
  /** Drafts a person sent back in the last 30 days; null when not readable. */
  rejectedDrafts30d: number | null;
  /** Minutes from a run's start to its first pull request, oldest first; null when not readable. */
  minutesToPr: number[] | null;
};

const settle = async <T>(read: string, run: () => Promise<T>): Promise<T | null> => {
  try {
    return await run();
  } catch {
    console.warn({ event: "admin_engineering_overview_read_failed", read });
    return null;
  }
};

const field = (value: unknown, key: string) =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)[key]
    : undefined;

export async function readEngineeringOverviewBody(now: Date = new Date()): Promise<EngineeringOverviewBody> {
  const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const [openPrs, pullRequests, rejectedDrafts30d, minutesToPr] = await Promise.all([
    settle("open_prs", () =>
      prisma.engineeringAgentBinding.count({
        where: { state: "open", supersededAt: null, mergeObservation: { equals: Prisma.AnyNull } },
      }),
    ),
    settle("pull_requests", async () => {
      const rows = await prisma.engineeringAgentBinding.findMany({
        where: { supersededAt: null },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 40,
        select: { runId: true, prNumber: true, state: true, approvalObservation: true, mergeObservation: true, createdAt: true },
      });
      const mapped: EngineeringPrRow[] = rows.map((row) => {
        const merged = field(row.mergeObservation, "merged");
        return {
          prNumber: row.prNumber,
          runId: row.runId,
          state: row.state,
          approved: field(row.approvalObservation, "verdict") === "approved",
          merged: typeof merged === "boolean" ? merged : null,
          createdAt: row.createdAt.toISOString(),
        };
      });
      // What waits on a person first, then the rest by recency.
      const rank = (row: EngineeringPrRow) => (classifyEngineeringPr(row) === "ready" ? 0 : 1);
      return mapped
        .map((row, index) => ({ row, index }))
        .sort((a, b) => rank(a.row) - rank(b.row) || a.index - b.index)
        .slice(0, ENGINEERING_OVERVIEW_PR_LIMIT)
        .map((entry) => entry.row);
    }),
    settle("rejected_drafts", () =>
      prisma.engineeringAgentApproval.count({ where: { decision: "rejected", decidedAt: { gte: since } } }),
    ),
    settle("minutes_to_pr", async () => {
      const rows = await prisma.engineeringAgentBinding.findMany({
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: 80,
        select: { runId: true, createdAt: true, run: { select: { startedAt: true } } },
      });
      return minutesToFirstPullRequest(
        rows.map((row) => ({ runId: row.runId, createdAt: row.createdAt, runStartedAt: row.run.startedAt })),
      );
    }),
  ]);
  return { openPrs, pullRequests, rejectedDrafts30d, minutesToPr };
}
