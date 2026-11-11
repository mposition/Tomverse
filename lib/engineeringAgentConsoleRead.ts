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

import type { Prisma } from "@prisma/client";

import {
  OWNER_QUEUE_LIMITS,
  killSwitchEngaged,
  ENGINEERING_AGENT_KILL_SWITCH_ENV,
} from "@/lib/engineeringAgentCore";
import { readEngineeringAgentSwitches } from "@/lib/engineeringAgentStore";
import {
  ENGINEERING_AGENT_PATCH_FILE_LIMIT,
  ENGINEERING_AGENT_CARD_ITEM_KINDS,
  ENGINEERING_AGENT_REVIEW_PR_CAUSE_PREFIX,
  engineeringAgentCardItems,
  engineeringAgentDraftRejudgeable,
  engineeringAgentItemPullRequest,
  engineeringAgentMismatchPublishItemId,
  engineeringAgentPatchFiles,
  type EngineeringAgentCardItemView,
  type EngineeringAgentItemPullRequest,
  type EngineeringAgentPatchFile,
} from "@/lib/engineeringAgentOwnerItemContextCore";
import { readAmuxCardTitle } from "@/lib/amux/adminExecutionRead";
import type { AmuxV22QuestionDm } from "@/lib/amux/v22OwnerQuestionDmCore";
import { readAmuxDmLocalCardState } from "@/lib/amux/v22OwnerQuestionDmRead";
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
  /** A v22 draft the tier round kept private, which a person may send back. */
  rejudgeable: boolean;
  /** What the item is about, for the person deciding it. Null: no run to read. */
  context: EngineeringAgentOwnerItemContext | null;
};

export type EngineeringAgentOwnerItemContext = {
  card: {
    id: string;
    displayKey: string | null;
    /** Null when a v4 card's title could not be opened. */
    title: string | null;
    status: string;
    taskRole: string | null;
    requiresHumanReview: boolean;
  };
  run: {
    id: string;
    status: string;
    outcome: string | null;
    worker: string;
    attemptOutcome: string | null;
    attemptReason: string | null;
    startedAt: string;
    endedAt: string | null;
  };
  pullRequests: EngineeringAgentItemPullRequest[];
  /** The draft's changed files, at most ENGINEERING_AGENT_PATCH_FILE_LIMIT; `fileCount` is all of them. */
  files: EngineeringAgentPatchFile[];
  fileCount: number;
  /** The cross-vendor review of the run's commit, when one was recorded. */
  review: {
    verdict: string;
    authorVendor: string;
    reviewerVendors: string[];
    touchesContract: boolean;
    createdAt: string;
  } | null;
  /**
   * The Decision Maker's review of the run's result, or for a T2 draft its
   * advice on the patch (kind `t2_advice`; lib/engineeringAgentT2DmReviewService.ts).
   * Not filed: nothing was put to it yet.
   */
  dm:
    /** `unfilable`: a T2 draft whose patch did not fit a card, recorded once. */
    | { filed: false; unfilable?: boolean }
    | {
        filed: true;
        kind: string;
        state: string;
        decision: string | null;
        answerSource: string | null;
        /** Its newest request; `restricted` without ops:write. */
        detail: AmuxV22QuestionDm;
      };
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
    killSwitch: boolean;
    pullRequests: { occupied: number; limit: number };
    decisions: { occupied: number; limit: number };
  };
};

const ownerKinds = ["t2_draft", "decision", "state_mismatch"] as const;

const contextRunSelect = {
  id: true,
  status: true,
  outcome: true,
  startedAt: true,
  endedAt: true,
  attempt: {
    select: {
      worker: true,
      outcome: true,
      reason: true,
      v52ReviewRecord: {
        select: { verdict: true, authorVendor: true, reviewerVendors: true, touchesContract: true, createdAt: true },
      },
      v22ResultReview: {
        select: { kind: true, state: true, decision: true, answerSource: true, localCardId: true },
      },
    },
  },
  card: {
    select: {
      id: true, title: true, displayKey: true, status: true, taskRole: true, requiresHumanReview: true,
      sourceSystem: true, sourceSnapshot: true, v4TitleCiphertext: true, v4TitleKeyId: true,
      v4TitleKeyVersion: true, v4TitleDigest: true, v4TitleDigestKeyId: true,
    },
  },
  bindings: {
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    select: { prNumber: true, state: true, supersededAt: true, approvalObservation: true, mergeObservation: true },
  },
} satisfies Prisma.EngineeringAgentRunSelect;

/**
 * The context of each item, keyed by item id. A mismatch about a published
 * item has no run of its own; its run is the published item's.
 */
async function readOwnerItemContexts(
  items: Array<{ id: string; kind: string; causeKey: string; runId: string | null; patchBody: string | null }>,
  canReadDm: boolean,
): Promise<Map<string, EngineeringAgentOwnerItemContext>> {
  const publishIds = items
    .map((item) => (item.runId === null ? engineeringAgentMismatchPublishItemId(item.causeKey) : null))
    .filter((id): id is string => id !== null);
  const publishRuns = publishIds.length
    ? await prisma.engineeringAgentWorkItem.findMany({ where: { id: { in: publishIds } }, select: { id: true, runId: true } })
    : [];
  const runIdOf = (item: (typeof items)[number]) =>
    item.runId ??
    publishRuns.find((row) => row.id === engineeringAgentMismatchPublishItemId(item.causeKey))?.runId ??
    null;
  const runIds = [...new Set(items.map(runIdOf).filter((id): id is string => id !== null))];
  const runs = runIds.length
    ? await prisma.engineeringAgentRun.findMany({ where: { id: { in: runIds } }, select: contextRunSelect })
    : [];
  const titles = new Map(
    await Promise.all(runs.map(async (run) => [run.id, await readAmuxCardTitle(run.card)] as const)),
  );
  const dmStates = new Map(
    await Promise.all(
      runs.map(async (run) => {
        const cardId = run.attempt.v22ResultReview?.localCardId ?? null;
        const state: AmuxV22QuestionDm = !canReadDm
          ? { state: "restricted" }
          : cardId === null
            ? { state: "filed" }
            : await readAmuxDmLocalCardState(cardId);
        return [run.id, state] as const;
      }),
    ),
  );

  // A T2 draft's advice card (TOMVERSE_ENGINEERING_AGENT_T2_DM_REVIEW).
  const draftIds = items.filter((item) => item.kind === "t2_draft").map((item) => item.id);
  const advice = draftIds.length
    ? await prisma.engineeringAgentDmReview.findMany({
        where: { workItemId: { in: draftIds } },
        select: { workItemId: true, localCardId: true, unfilableAt: true, localCardClosedAt: true },
      })
    : [];
  const adviceStates = new Map(
    await Promise.all(
      advice.flatMap((row) => {
        const cardId = row.localCardId;
        if (cardId === null) return [];
        return [(async () => {
          const state: AmuxV22QuestionDm = !canReadDm ? { state: "restricted" } : await readAmuxDmLocalCardState(cardId);
          return [row.workItemId, state] as const;
        })()];
      }),
    ),
  );

  const contexts = new Map<string, EngineeringAgentOwnerItemContext>();
  for (const item of items) {
    const run = runs.find((row) => row.id === runIdOf(item));
    if (!run) continue;
    const files = item.kind === "t2_draft" && item.patchBody !== null ? engineeringAgentPatchFiles(item.patchBody) : [];
    const review = run.attempt.v52ReviewRecord;
    const resultReview = run.attempt.v22ResultReview;
    const draftAdvice = item.kind === "t2_draft" ? advice.find((row) => row.workItemId === item.id) : undefined;
    contexts.set(item.id, {
      card: {
        id: run.card.id,
        displayKey: run.card.displayKey,
        title: titles.get(run.id) ?? null,
        status: run.card.status,
        taskRole: run.card.taskRole,
        requiresHumanReview: run.card.requiresHumanReview,
      },
      run: {
        id: run.id,
        status: run.status,
        outcome: run.outcome,
        worker: run.attempt.worker,
        attemptOutcome: run.attempt.outcome,
        attemptReason: run.attempt.reason,
        startedAt: run.startedAt.toISOString(),
        endedAt: run.endedAt?.toISOString() ?? null,
      },
      pullRequests: run.bindings.map(engineeringAgentItemPullRequest),
      files: files.slice(0, ENGINEERING_AGENT_PATCH_FILE_LIMIT),
      fileCount: files.length,
      review: review
        ? {
            verdict: review.verdict,
            authorVendor: review.authorVendor,
            reviewerVendors: review.reviewerVendors,
            touchesContract: review.touchesContract,
            createdAt: review.createdAt.toISOString(),
          }
        : null,
      dm: draftAdvice?.unfilableAt
        ? { filed: false, unfilable: true }
        : draftAdvice
        ? {
            filed: true,
            kind: "t2_advice",
            state: draftAdvice.localCardClosedAt ? "closed" : "open",
            decision: null,
            answerSource: null,
            detail: adviceStates.get(item.id) ?? { state: "unavailable" },
          }
        : resultReview
        ? {
            filed: true,
            kind: resultReview.kind,
            state: resultReview.state,
            decision: resultReview.decision,
            answerSource: resultReview.answerSource,
            detail: dmStates.get(run.id) ?? { state: "unavailable" },
          }
        : { filed: false },
    });
  }
  return contexts;
}

export async function readEngineeringAgentConsole(
  section: EngineeringAgentConsoleSection,
  canWrite: boolean,
  canReadDm = false,
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
          run: { select: { modeAtStart: true, amuxAttemptId: true,
            card: { select: { sourceSystem: true } } } },
        },
      }),
      prisma.engineeringAgentWorkItem.groupBy({
        by: ["kind"],
        where: { kind: { in: [...ownerKinds] }, state: "open" },
        _count: { _all: true },
      }),
    ]);
    const total = (kind: string) => grouped.find((row) => row.kind === kind)?._count._all ?? 0;
    const contexts = await readOwnerItemContexts(items, canReadDm);
    return {
      ...base,
      queue: {
        items: items.map(({ run, ...item }) => ({
          ...item,
          context: contexts.get(item.id) ?? null,
          rejudgeable: engineeringAgentDraftRejudgeable(item, run),
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
  const [bindings, pendingPublish, activeRuns, openOwnerItems] = await Promise.all([
    prisma.engineeringAgentBinding.count({ where: { state: { in: ["open", "closed"] }, supersededAt: null } }),
    prisma.engineeringAgentWorkItem.count({
      where: { kind: "publish", state: { in: ["queued", "claimed", "needs_lookup", "outcome_unknown"] } },
    }),
    prisma.engineeringAgentRun.count({ where: { status: "active" } }),
    prisma.engineeringAgentWorkItem.count({ where: { kind: { in: [...ownerKinds] }, state: "open" } }),
  ]);
  return {
    ...base,
    settings: {
      mode: switches.mode,
      frozen: switches.frozen,
      killSwitch: killSwitchEngaged(process.env[ENGINEERING_AGENT_KILL_SWITCH_ENV]),
      pullRequests: { occupied: bindings + pendingPublish + activeRuns, limit: OWNER_QUEUE_LIMITS.pr },
      decisions: { occupied: openOwnerItems + activeRuns, limit: OWNER_QUEUE_LIMITS.decision },
    },
  };
}

const cardItemRunSelect = {
  cardId: true,
  modeAtStart: true,
  amuxAttemptId: true,
  card: { select: { sourceSystem: true } },
} satisfies Prisma.EngineeringAgentRunSelect;

const cardItemSelect = {
  id: true,
  kind: true,
  reason: true,
  causeKey: true,
  createdAt: true,
  patchBody: true,
  patchDigest: true,
  baseSha: true,
  run: { select: cardItemRunSelect },
} satisfies Prisma.EngineeringAgentWorkItemSelect;

/**
 * The open T2 drafts and state mismatches of the given AMUX cards, for the
 * owner queue (Admin › Execution › Waiting on me). Read only, the same rows
 * and rejudge rule the engineering console's queue shows; the actions stay in
 * the engineering routes.
 */
export async function readEngineeringAgentCardItems(
  cardIds: readonly string[],
): Promise<Map<string, EngineeringAgentCardItemView[]>> {
  if (cardIds.length === 0) return new Map();
  const [own, published] = await Promise.all([
    prisma.engineeringAgentWorkItem.findMany({
      where: { state: "open", kind: { in: [...ENGINEERING_AGENT_CARD_ITEM_KINDS] }, run: { cardId: { in: [...cardIds] } } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: ENGINEERING_AGENT_CONSOLE_LIMIT,
      select: cardItemSelect,
    }),
    // A mismatch about a published item has no run; its card is the published item's.
    prisma.engineeringAgentWorkItem.findMany({
      where: { state: "open", kind: "state_mismatch", runId: null, causeKey: { startsWith: ENGINEERING_AGENT_REVIEW_PR_CAUSE_PREFIX } },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take: ENGINEERING_AGENT_CONSOLE_LIMIT,
      select: cardItemSelect,
    }),
  ]);
  const publishIds = [...new Set(published
    .map((row) => engineeringAgentMismatchPublishItemId(row.causeKey))
    .filter((id): id is string => id !== null))];
  const publishRows = publishIds.length
    ? await prisma.engineeringAgentWorkItem.findMany({
        where: { id: { in: publishIds } },
        select: { id: true, run: { select: cardItemRunSelect } },
      })
    : [];
  return engineeringAgentCardItems(cardIds, [...own, ...published],
    new Map(publishRows.map((row) => [row.id, row.run] as const)));
}
