/**
 * What the Admin Console shows of the engineering agent
 * (docs/policy/engineering-agent.md §11, §12). Read only; the page loads only
 * the open section, and every list is the newest N rows with N on screen.
 *
 * The queue figures are counted the way the run trigger counts them -- current
 * bindings and unsettled publish items for pull requests, open owner items for
 * decisions, active runs in both -- so the screen and the database agree on
 * whether the next run would be admitted.
 */

import "server-only";

import {
  FIRST_T1_WINDOW_DAYS,
  OWNER_QUEUE_LIMITS,
  decideOwnerQueues,
  killSwitchEngaged,
  ENGINEERING_AGENT_KILL_SWITCH_ENV,
} from "@/lib/engineeringAgentCore";
import { readEngineeringAgentSwitches } from "@/lib/engineeringAgentStore";
import { prisma } from "@/lib/prisma";

export const ENGINEERING_AGENT_CONSOLE_SECTIONS = ["queue", "runs", "pull-requests", "settings"] as const;
export type EngineeringAgentConsoleSection = (typeof ENGINEERING_AGENT_CONSOLE_SECTIONS)[number];

/** How many rows a list shows. The screen states it. */
export const ENGINEERING_AGENT_CONSOLE_LIMIT = 50;

export type EngineeringAgentOwnerItemView = {
  id: string;
  kind: "t2_draft" | "decision" | "state_mismatch";
  reason: string | null;
  causeKey: string;
  runId: string | null;
  createdAt: string;
  patchBody: string | null;
  patchDigest: string | null;
  baseSha: string | null;
};

export type EngineeringAgentRunView = {
  id: string;
  cardId: string;
  cardKind: string;
  status: string;
  outcome: string | null;
  halt: string;
  modeAtStart: string;
  startedAt: string;
  endedAt: string | null;
};

export type EngineeringAgentBindingView = {
  id: string;
  runId: string;
  prNumber: number;
  state: string;
  current: boolean;
  approvalVerdict: string | null;
  merged: boolean | null;
  createdAt: string;
};

export type EngineeringAgentConsolePayload = {
  section: EngineeringAgentConsoleSection;
  canWrite: boolean;
  limit: number;
  queue?: {
    items: EngineeringAgentOwnerItemView[];
    totals: { t2_draft: number; decision: number; state_mismatch: number };
  };
  runs?: EngineeringAgentRunView[];
  pullRequests?: EngineeringAgentBindingView[];
  settings?: {
    mode: string;
    frozen: boolean;
    registration: boolean;
    killSwitch: boolean;
    pullRequests: { occupied: number; limit: number; firstT1Window: boolean };
    decisions: { occupied: number; limit: number };
  };
};

const ownerKinds = ["t2_draft", "decision", "state_mismatch"] as const;

export async function readEngineeringAgentConsole(
  section: EngineeringAgentConsoleSection,
  canWrite: boolean,
): Promise<EngineeringAgentConsolePayload> {
  const base = { section, canWrite, limit: ENGINEERING_AGENT_CONSOLE_LIMIT };

  if (section === "queue") {
    const [items, grouped] = await Promise.all([
      prisma.engineeringAgentWorkItem.findMany({
        where: { kind: { in: [...ownerKinds] }, state: "open" },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        take: ENGINEERING_AGENT_CONSOLE_LIMIT,
        select: {
          id: true,
          kind: true,
          reason: true,
          causeKey: true,
          runId: true,
          createdAt: true,
          patchBody: true,
          patchDigest: true,
          baseSha: true,
        },
      }),
      prisma.engineeringAgentWorkItem.groupBy({
        by: ["kind"],
        where: { kind: { in: [...ownerKinds] }, state: "open" },
        _count: { _all: true },
      }),
    ]);
    const total = (kind: string) => grouped.find((row) => row.kind === kind)?._count._all ?? 0;
    return {
      ...base,
      queue: {
        items: items.map((item) => ({
          ...item,
          kind: item.kind as EngineeringAgentOwnerItemView["kind"],
          createdAt: item.createdAt.toISOString(),
          // Only a draft's patch is shown; a person reads it before deciding.
          patchBody: item.kind === "t2_draft" ? item.patchBody : null,
        })),
        totals: { t2_draft: total("t2_draft"), decision: total("decision"), state_mismatch: total("state_mismatch") },
      },
    };
  }

  if (section === "runs") {
    const rows = await prisma.engineeringAgentRun.findMany({
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: ENGINEERING_AGENT_CONSOLE_LIMIT,
      select: {
        id: true,
        cardId: true,
        cardKind: true,
        status: true,
        outcome: true,
        halt: true,
        modeAtStart: true,
        startedAt: true,
        endedAt: true,
      },
    });
    return {
      ...base,
      runs: rows.map((row) => ({
        ...row,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt?.toISOString() ?? null,
      })),
    };
  }

  if (section === "pull-requests") {
    const rows = await prisma.engineeringAgentBinding.findMany({
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: ENGINEERING_AGENT_CONSOLE_LIMIT,
      select: {
        id: true,
        runId: true,
        prNumber: true,
        state: true,
        currentPrNumber: true,
        approvalObservation: true,
        mergeObservation: true,
        createdAt: true,
      },
    });
    const field = (value: unknown, key: string) =>
      value !== null && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)[key]
        : undefined;
    return {
      ...base,
      pullRequests: rows.map((row) => {
        const verdict = field(row.approvalObservation, "verdict");
        const merged = field(row.mergeObservation, "merged");
        return {
          id: row.id,
          runId: row.runId,
          prNumber: row.prNumber,
          state: row.state,
          current: row.currentPrNumber !== null,
          approvalVerdict: typeof verdict === "string" ? verdict : null,
          merged: typeof merged === "boolean" ? merged : null,
          createdAt: row.createdAt.toISOString(),
        };
      }),
    };
  }

  const switches = await readEngineeringAgentSwitches(prisma);
  const [bindings, pendingPublish, activeRuns, openOwnerItems, firstT1, registrationRow] = await Promise.all([
    prisma.engineeringAgentBinding.count({ where: { state: { in: ["open", "closed"] }, supersededAt: null } }),
    prisma.engineeringAgentWorkItem.count({
      where: { kind: "publish", state: { in: ["queued", "claimed", "needs_lookup", "outcome_unknown"] } },
    }),
    prisma.engineeringAgentRun.count({ where: { status: "active" } }),
    prisma.engineeringAgentWorkItem.count({ where: { kind: { in: [...ownerKinds] }, state: "open" } }),
    prisma.engineeringAgentRun.findFirst({
      where: { modeAtStart: "t1" },
      orderBy: { startedAt: "asc" },
      select: { startedAt: true },
    }),
    prisma.appSetting.findUnique({ where: { key: "feature.engineeringAgentRegistration" }, select: { value: true } }),
  ]);
  const queues = decideOwnerQueues({
    openPrBindings: bindings + pendingPublish + activeRuns,
    pendingDecisions: openOwnerItems + activeRuns,
    t1StartedAt: firstT1?.startedAt ?? null,
    now: new Date(),
  });
  return {
    ...base,
    settings: {
      mode: switches.mode,
      frozen: switches.frozen,
      registration: registrationRow?.value === "on",
      killSwitch: killSwitchEngaged(process.env[ENGINEERING_AGENT_KILL_SWITCH_ENV]),
      pullRequests: {
        occupied: bindings + pendingPublish + activeRuns,
        limit: queues.prLimit,
        firstT1Window: queues.prLimit === OWNER_QUEUE_LIMITS.prDuringFirstT1Days && firstT1 !== null,
      },
      decisions: { occupied: openOwnerItems + activeRuns, limit: OWNER_QUEUE_LIMITS.decision },
    },
  };
}

/** Days in the first T1 window, for the screen's explanation. */
export const ENGINEERING_AGENT_FIRST_T1_WINDOW_DAYS = FIRST_T1_WINDOW_DAYS;
