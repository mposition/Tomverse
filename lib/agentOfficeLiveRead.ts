/**
 * What the Agent office reads of the agents it can show for real.
 *
 * Read only, and narrower than the agents' own sections: the office shows an
 * agent's operating state, never its content. For product research that
 * means the switch, today's slot and the newest success -- not the payload,
 * not issue titles, not counts (docs/policy/product-research-agent.md §4,
 * §8). Nothing here writes. In particular the silence anchor is looked up and
 * not created: `readProductResearchEnabledSince()` writes it on first sight,
 * which is the agent section's job, and a page that "writes nothing" must not
 * do it as a side effect of being opened.
 *
 * A failed read comes back as `unread` and is reported, never absorbed
 * (docs/ui-contracts/admin-console-ia.md, rules 5 and 8).
 */

import "server-only";

import type { Prisma } from "@prisma/client";

import type {
  AgentOfficeReviewState,
  AgentOfficeAmuxState,
  AgentOfficeAmuxDetail,
  AgentOfficeDecisionState,
  AgentOfficeInboxCounts,
  AgentOfficeMerges,
  AgentOfficeHistory,
  AgentOfficeAmuxPulse,
  AgentOfficeDigestState,
  AgentOfficeEngineeringState,
  AgentOfficeFinanceState,
  AgentOfficeLiveRooms,
  AgentOfficeMarketingState,
  AgentOfficeOperatorQueue,
  AgentOfficeQaState,
  AgentOfficeResearchState,
  AgentOfficeRoutingState,
  AgentOfficeSreState,
  AgentOfficeSupportState,
  AgentOfficeTrustState,
} from "@/lib/agentOffice/live";
import {
  countAwaitingAmuxEscalations,
  countPendingMarketingApprovals,
} from "@/lib/adminNavigationCounts";
import {
  agentOfficeAmuxDetail,
  agentOfficeAttemptMark,
  agentOfficeAmuxRosterFromRegistry,
  agentOfficeAmuxState,
  agentOfficeProviderLabel,
  brisbaneMidnight,
} from "@/lib/agentOfficeAmuxState";
import { readAmuxCardTitle } from "@/lib/amux/adminExecutionRead";
import { countDecisionMakerAttention } from "@/lib/amux/decisionMakerAttention";
import { countOpenAmuxPlanRefusals } from "@/lib/amux/ideaSessionPlanRefusalService";
import { AGENT_OFFICE_AMUX_ROSTER } from "@/lib/agentOffice/amuxRoster";
import { agentOfficeDecisionState } from "@/lib/agentOfficeDecisionState";
import { AGENT_OFFICE_DIGEST_WINDOW_MS, agentOfficeDigestState } from "@/lib/agentOfficeDigestState";
import { agentOfficeFinanceState } from "@/lib/agentOfficeFinanceState";
import {
  AGENT_OFFICE_ENGINEERING_SETTING_KEYS,
  agentOfficeEngineeringState,
} from "@/lib/agentOfficeEngineeringState";
import { agentOfficeMarketingState } from "@/lib/agentOfficeMarketingState";
import { agentOfficeQaState } from "@/lib/agentOfficeQaState";
import { agentOfficeRoutingMonthStart, agentOfficeRoutingState } from "@/lib/agentOfficeRoutingState";
import { agentOfficeReviewState } from "@/lib/agentOfficeReviewState";
import { agentOfficeResearchState } from "@/lib/agentOfficeResearchState";
import { agentOfficeSreState } from "@/lib/agentOfficeSreState";
import { agentOfficeSupportState } from "@/lib/agentOfficeSupportState";
import { agentOfficeTrustState } from "@/lib/agentOfficeTrustState";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import { countOpenAmuxOrchestratorHalts } from "@/lib/amux/orchestratorHaltStore";
import {
  amuxDerivedCatalogAsConfigured,
  readAmuxRegistryAndDerivedCatalog,
  type AmuxConfiguredWorker,
} from "@/lib/amux/workerAssignmentCatalog";
import { readBillingFinanceOpsControl } from "@/lib/billingFinanceOpsControl";
import {
  BILLING_FINANCE_OPS_AGENT_KEY,
  BILLING_FINANCE_OPS_ENVIRONMENTS,
  type BillingFinanceOpsEnvironment,
  billingFinanceOpsIdempotencyKey,
} from "@/lib/billingFinanceOpsDigest";
import { resolveDeploymentEnvironment } from "@/lib/deploymentEnvironment";
import { REVIEW_ORCHESTRATOR_STATUS_KEY } from "@/lib/reviewOrchestratorStatusCore";
import { ENGINEERING_AGENT_KILL_SWITCH_ENV, OWNER_ITEM_KINDS } from "@/lib/engineeringAgentCore";
import { currentEngineeringAgentHalt, readEngineeringAgentHaltState } from "@/lib/engineeringAgentStore";
import { readMarketingConsoleOverview } from "@/lib/marketingConsoleOverview";
import { readSwitches as readMarketingSwitches } from "@/lib/marketingConsoleRead";
import { readOpsObserverAdminView } from "@/lib/opsObserverStore";
import { prisma } from "@/lib/prisma";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import { readTrustSafetyDigest } from "@/lib/trustSafetyDigestRead";
import {
  PRODUCT_RESEARCH_ENABLED_SINCE_SETTING,
  latestProductResearchSuccess,
} from "@/lib/productResearchObservationStore";
import { slotForInstant } from "@/lib/productResearchObservationRunnerCore.mjs";
import { QA_RELEASE_ROUTE_SECRET_ENV } from "@/lib/qaReleaseRouteAuthCore";
import { readSupportTriageHealth } from "@/lib/supportTriageCycle";
import { resolveSupportTriageEnabled } from "@/lib/supportTriageLlmSetting";

const parseInstant = (value: string | null | undefined) => {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed : null;
};

async function readResearch(now: Date): Promise<AgentOfficeResearchState> {
  const enabled = isProductResearchRouteEnabled();
  if (!enabled) {
    return agentOfficeResearchState({ enabled, rows: [], lastSuccessAt: null, enabledSince: null, now });
  }
  try {
    const slot = new Date(slotForInstant(now.getTime()));
    const [rows, lastSuccessAt, anchor] = await Promise.all([
      prisma.productResearchObservation.findMany({
        where: { slot },
        select: { slot: true, outcome: true, failureStage: true },
      }),
      latestProductResearchSuccess(),
      prisma.appSetting.findUnique({
        where: { key: PRODUCT_RESEARCH_ENABLED_SINCE_SETTING },
        select: { value: true },
      }),
    ]);
    return agentOfficeResearchState({
      enabled,
      rows,
      lastSuccessAt,
      enabledSince: parseInstant(anchor?.value),
      now,
    });
  } catch {
    // The error itself is not logged: a database error can carry query text,
    // and the read's name is what an operator searches for.
    console.warn({ event: "admin_agent_office_read_failed", read: "product_research" });
    return { kind: "unread" };
  }
}

/**
 * QA and release: the newest control revision's number and switch, when the
 * newest digest was stored, and whether the merge lane is latched. The digest
 * body is not selected -- the office says whether a digest arrived, never
 * what it says.
 */
async function readQa(): Promise<AgentOfficeQaState> {
  try {
    const [control, latest, latch] = await Promise.all([
      prisma.qaReleaseOperatorControl.findFirst({
        orderBy: { revision: "desc" },
        select: { revision: true, digestEnabled: true },
      }),
      prisma.agentDigestItem.findFirst({
        where: { agentKey: "qa-release" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
      prisma.qaReleaseMergeLaneLatch.findFirst({
        orderBy: { sequence: "desc" },
        select: { latched: true },
      }),
    ]);
    return agentOfficeQaState({
      // Usable means the same 32-character floor the monitor applies; the
      // value is never read beyond its length.
      digestSecretConfigured: (process.env[QA_RELEASE_ROUTE_SECRET_ENV.digest] ?? "").length >= 32,
      control,
      latestDigestAt: latest?.createdAt ?? null,
      mergeLaneLatched: latch?.latched === true,
      // Taken after the reads: a digest stored while they ran must not be
      // dated after the clock it is judged against.
      now: new Date(),
    });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "qa_release" });
    return { kind: "unread" };
  }
}

/**
 * Billing and finance: the switch row, whether this environment's digest for
 * today exists, and when the newest digest was stored. The digest body is not
 * selected -- the office says whether the day was recorded, never what the
 * register held (docs/policy/billing-finance-ops.md §1.4).
 */
async function readFinance(): Promise<AgentOfficeFinanceState> {
  try {
    const environment = resolveDeploymentEnvironment();
    const now = new Date();
    const today = now.toISOString().slice(0, 10);
    const runsHere = (BILLING_FINANCE_OPS_ENVIRONMENTS as readonly string[]).includes(environment);
    const [control, recordedToday, latest] = await Promise.all([
      readBillingFinanceOpsControl(prisma),
      runsHere
        ? prisma.agentDigestItem.count({
            where: {
              agentKey: BILLING_FINANCE_OPS_AGENT_KEY,
              idempotencyKey: billingFinanceOpsIdempotencyKey(environment as BillingFinanceOpsEnvironment, today),
            },
          })
        : Promise.resolve(0),
      prisma.agentDigestItem.findFirst({
        where: { agentKey: BILLING_FINANCE_OPS_AGENT_KEY },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
    return agentOfficeFinanceState({
      environment,
      control,
      recordedToday: recordedToday > 0,
      latestDigestAt: latest?.createdAt ?? null,
      now,
    });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "billing_finance_ops" });
    return { kind: "unread" };
  }
}

/**
 * Chat routing improvement: the newest optimizer cycle of either target, this
 * month's cycle spend and the newest promotion. Only status, code, spend and
 * time columns are selected: no guidance, case or summary, which stay on the
 * routing screen.
 */
async function readRouting(now: Date): Promise<AgentOfficeRoutingState> {
  try {
    const [last, monthCycles, promoted] = await Promise.all([
      prisma.autoRouterOptimizerCycle.findFirst({
        orderBy: { createdAt: "desc" },
        select: { target: true, status: true, failure: true, createdAt: true, finishedAt: true },
      }),
      prisma.autoRouterOptimizerCycle.findMany({
        where: { createdAt: { gte: agentOfficeRoutingMonthStart(now) } },
        select: { createdAt: true, spentMicroUsd: true },
      }),
      prisma.autoRouterOptimizerCycle.findFirst({
        where: { promotedAt: { not: null } },
        orderBy: { promotedAt: "desc" },
        select: { promotedAt: true },
      }),
    ]);
    return agentOfficeRoutingState({ last, monthCycles, lastPromotedAt: promoted?.promotedAt ?? null, now });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "auto_router_optimizer" });
    return { kind: "unread" };
  }
}

/**
 * Ops and SRE: the chain verdict through the agent's own admin reader (one
 * bounded `state_read` transaction that writes nothing), and when its newest
 * digest was stored. The agent's tables are not read here, and no digest body
 * is selected.
 */
async function readSre(): Promise<AgentOfficeSreState> {
  try {
    const [view, latest] = await Promise.all([
      readOpsObserverAdminView(),
      prisma.agentDigestItem.findFirst({
        where: { agentKey: "sre-ops" },
        orderBy: { createdAt: "desc" },
        select: { createdAt: true },
      }),
    ]);
    return agentOfficeSreState({ view, latestDigestAt: latest?.createdAt ?? null });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "ops_observer" });
    return { kind: "unread" };
  }
}

/**
 * Support triage: the agent's own health reading and its own switch. A switch
 * or health read that fails is an unread room, never an "off" one. No report,
 * draft or suggestion is selected.
 */
async function readSupport(): Promise<AgentOfficeSupportState> {
  try {
    const [resolved, health] = await Promise.all([
      resolveSupportTriageEnabled(process.env),
      readSupportTriageHealth(),
    ]);
    return agentOfficeSupportState({ enabled: resolved.enabled, health });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "support_triage" });
    return { kind: "unread" };
  }
}

/**
 * Marketing: the console's own overview counts and its switch strip. The
 * overview fails part by part (a part it could not read is null); the switch
 * strip says "unreadable" rather than "off". No draft, fact, URL or amount is
 * used, and the cost figures the overview carries are not passed on.
 */
async function readMarketing(): Promise<AgentOfficeMarketingState> {
  try {
    const [overview, read] = await Promise.all([readMarketingConsoleOverview(), readMarketingSwitches()]);
    return agentOfficeMarketingState({
      overview,
      drafts: read.switches.drafts,
      publish: read.switches.publish,
    });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "marketing" });
    return { kind: "unread" };
  }
}

/**
 * Trust and safety: the section's own reader, unchanged. It checks
 * `trust-safety:read` itself and returns `{ permitted: false }` having read
 * nothing when the caller is not the owner, so no permission check is repeated
 * or bypassed here. It writes nothing, opens two bounded transactions and does
 * not read the observer's run table (docs/policy/trust-safety-compliance-agent.md
 * §5.6, §5.3). Only counts, the switch and a time come back, and only those are kept.
 */
async function readTrust(): Promise<AgentOfficeTrustState> {
  try {
    return agentOfficeTrustState(await readTrustSafetyDigest());
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "trust_safety" });
    return { kind: "unread" };
  }
}

/**
 * Engineering: the switch settings, the agent's own halt reading, open owner
 * items counted by kind, how many runs are in progress and since when, and the
 * newest ended run's status, outcome and times. No patch body, reason, cause key or card is selected: the office says
 * how the agent stands, never what it worked on (docs/policy/engineering-agent.md §11).
 */
async function readEngineering(): Promise<AgentOfficeEngineeringState> {
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
      // Ended runs only, by their end: with two runs at once, the newest to
      // start is not the one that last finished.
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
    console.warn({ event: "admin_agent_office_read_failed", read: "engineering" });
    return { kind: "unread" };
  }
}

/**
 * AMUX workers: the app's worker catalog and each worker's runtime row --
 * status, whether it can take work, its last heartbeat and its lease. Nothing
 * about the cards or tasks they work on is selected.
 */
async function readAmuxWorkers(): Promise<AgentOfficeAmuxState> {
  try {
    // Orchestration policy version 35, section 3: a seat for every
    // registered worker that is not retired, against the derived catalog,
    // both read in one statement. A registry that cannot be read falls back
    // to the display roster with the catalog unknown.
    let roster: readonly { name: string; provider: string }[] = AGENT_OFFICE_AMUX_ROSTER;
    const read = await readAmuxRegistryAndDerivedCatalog(prisma);
    // The derived catalog names provider classes; seats show the roster's
    // labels, assigned or not.
    const catalog: AmuxConfiguredWorker[] | null = read.derived === null
      ? null
      : amuxDerivedCatalogAsConfigured(read.derived).workers.map((worker) => ({
          ...worker,
          provider: agentOfficeProviderLabel(worker.provider),
        }));
    if (read.registrations !== null) {
      roster = agentOfficeAmuxRosterFromRegistry(read.registrations, AGENT_OFFICE_AMUX_ROSTER.map((worker) => worker.name));
    }
    const admitted = new Set((catalog ?? []).filter((worker) => !worker.archived).map((worker) => worker.worker_name));
    const names = roster.filter((worker) => admitted.has(worker.name)).map((worker) => worker.name);
    const runtimes = names.length
      ? await prisma.amuxWorkerRuntime.findMany({
          where: { workerName: { in: names } },
          select: { workerName: true, status: true, dispatchReady: true, heartbeatAt: true, leaseExpiresAt: true },
        })
      : [];
    // Judged against a clock taken after the read: a lease that has run out
    // by then is lost, never live.
    return agentOfficeAmuxState({ catalog, roster, runtimes, now: new Date() });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "amux_workers" });
    return { kind: "unread" };
  }
}

/** The same read, for AMUX › Operations settings › Workers. It selects nothing more. */
export const readAgentOfficeAmuxWorkers = readAmuxWorkers;

/**
 * The independent review server: the latest status report it sent, the one
 * row it may write. The report has no field for a job, a branch or a finding.
 */
async function readReview(): Promise<AgentOfficeReviewState> {
  try {
    const row = await prisma.appSetting.findUnique({
      where: { key: REVIEW_ORCHESTRATOR_STATUS_KEY },
      select: { value: true },
    });
    // Judged against a clock taken after the read: a report older than the
    // threshold by then is stale, never fresh.
    return agentOfficeReviewState({ stored: row?.value ?? null, now: new Date() });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "review_orchestrator" });
    return { kind: "unread" };
  }
}

/**
 * The AMUX Decision Maker: its switches, through its own reader. Its ledgers
 * belong to its store modules alone (docs/policy/amux-decision-maker.md §10),
 * so nothing of them is read here.
 */
async function readDecision(): Promise<AgentOfficeDecisionState> {
  try {
    return agentOfficeDecisionState({ switches: await readDecisionMakerSwitchesOrThrow(prisma) });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "decision_maker" });
    return { kind: "unread" };
  }
}

/**
 * The digest desk: digests per agent in the last 24 hours and each agent's
 * newest one. Counts and times only: no payload, kind or key is selected.
 */
async function readDigest(now: Date): Promise<AgentOfficeDigestState> {
  try {
    const since = new Date(now.getTime() - AGENT_OFFICE_DIGEST_WINDOW_MS);
    const [recent, latest] = await Promise.all([
      prisma.agentDigestItem.groupBy({ by: ["agentKey"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
      prisma.agentDigestItem.groupBy({ by: ["agentKey"], _max: { createdAt: true } }),
    ]);
    return agentOfficeDigestState({
      recent: recent.map((row) => ({ agentKey: row.agentKey, count: row._count._all })),
      latest: latest.map((row) => ({ agentKey: row.agentKey, lastAt: row._max.createdAt })),
    });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "agent_digests" });
    return { kind: "unread" };
  }
}

/**
 * The operator to-do counts, each read on its own: one failing count is
 * that count unknown, not the whole to-do zero (rule 8).
 */
async function readOperatorQueue(): Promise<AgentOfficeOperatorQueue> {
  const [marketing, amuxEscalations, amuxHalts] = await Promise.allSettled([
    countPendingMarketingApprovals(),
    countAwaitingAmuxEscalations(),
    countOpenAmuxOrchestratorHalts(),
  ]);
  const value = (result: PromiseSettledResult<number>, read: string) => {
    if (result.status === "fulfilled") return result.value;
    console.warn({ event: "admin_agent_office_read_failed", read });
    return null;
  };
  return {
    marketing: value(marketing, "operator_queue_marketing"),
    amuxEscalations: value(amuxEscalations, "operator_queue_amux_escalations"),
    amuxHalts: value(amuxHalts, "operator_queue_amux_halts"),
  };
}

/**
 * Per AMUX worker: its latest quota observation and its last ten ended
 * attempts' outcomes. For the owner only -- the AMUX card list is the owner's
 * (lib/adminNavigation.ts, Cards) -- also the open attempt with the card it
 * holds and today's (AEST) CLI usage. Nothing else of a card, and no prompt or
 * output, is read.
 */
async function readAmuxDetail(amux: AgentOfficeAmuxState, owner: boolean, now: Date): Promise<AgentOfficeAmuxDetail> {
  if (amux.kind !== "observed") return { kind: "unread" };
  const names = amux.workers.map((worker) => worker.name);
  if (names.length === 0) return { kind: "observed", ownerDetail: owner, workers: {} };
  try {
    // The newest observation per worker, and its ended attempts of the last
    // two weeks newest first (the mapping keeps ten each).
    const [quotas, attempts] = await Promise.all([
      prisma.amuxQuotaObservation.findMany({
        where: { worker: { in: names }, observedAt: { lte: now } },
        distinct: ["worker"],
        orderBy: [{ worker: "asc" }, { observedAt: "desc" }, { createdAt: "desc" }, { id: "desc" }],
        select: { worker: true, remainingBasisPoints: true, exhausted: true, observedAt: true, resetAt: true },
      }),
      prisma.amuxExecutionAttempt.findMany({
        where: { worker: { in: names }, endedAt: { not: null, lte: now, gte: new Date(now.getTime() - 14 * 86_400_000) } },
        orderBy: [{ endedAt: "desc" }, { id: "desc" }],
        take: names.length * 10 + 200,
        select: { worker: true, outcome: true },
      }),
    ]);
    let open: Parameters<typeof agentOfficeAmuxDetail>[0]["open"] = [];
    let usage: { worker: string; tokens: number; cost: number }[] = [];
    let models: { worker: string; model: string | null }[] = [];
    if (owner) {
      const since = brisbaneMidnight(now);
      const today = { worker: { in: names }, startedAt: { gte: since } };
      const [openRows, priced, projected, modelRows] = await Promise.all([
        prisma.amuxExecutionAttempt.findMany({
          where: { worker: { in: names }, endedAt: null },
          orderBy: { startedAt: "desc" },
          select: {
            worker: true, taskId: true, startedAt: true, leaseExpiresAt: true,
            task: { select: { id: true, displayKey: true, title: true, sourceSystem: true, sourceSnapshot: true,
              v4TitleCiphertext: true, v4TitleKeyId: true, v4TitleKeyVersion: true, v4TitleDigest: true, v4TitleDigestKeyId: true } },
          },
        }),
        // An event's actual API price when it has one, else its projected price.
        prisma.amuxCliUsageEvent.groupBy({
          by: ["worker"],
          where: { ...today, actualApiCostMicrousd: { not: null } },
          _sum: { inputTokens: true, outputTokens: true, actualApiCostMicrousd: true },
        }),
        prisma.amuxCliUsageEvent.groupBy({
          by: ["worker"],
          where: { ...today, actualApiCostMicrousd: null },
          _sum: { inputTokens: true, outputTokens: true, projectedApiCostMicrousd: true },
        }),
        prisma.amuxCliUsageEvent.findMany({
          where: { worker: { in: names } },
          distinct: ["worker"],
          orderBy: [{ worker: "asc" }, { startedAt: "desc" }],
          select: { worker: true, actualModelId: true, selectedModelId: true },
        }),
      ]);
      open = await Promise.all(openRows.map(async (row) => ({
        worker: row.worker,
        taskId: row.taskId,
        startedAt: row.startedAt,
        leaseExpiresAt: row.leaseExpiresAt,
        cardKey: row.task.displayKey,
        cardTitle: await readAmuxCardTitle(row.task),
      })));
      const sum = new Map<string, { tokens: number; cost: number }>();
      const add = (worker: string, tokens: number, cost: number) => {
        const prev = sum.get(worker) ?? { tokens: 0, cost: 0 };
        sum.set(worker, { tokens: prev.tokens + tokens, cost: prev.cost + cost });
      };
      for (const row of priced) {
        add(row.worker, Number(row._sum.inputTokens ?? 0) + Number(row._sum.outputTokens ?? 0), Number(row._sum.actualApiCostMicrousd ?? 0));
      }
      for (const row of projected) {
        add(row.worker, Number(row._sum.inputTokens ?? 0) + Number(row._sum.outputTokens ?? 0), Number(row._sum.projectedApiCostMicrousd ?? 0));
      }
      usage = [...sum].map(([worker, value]) => ({ worker, ...value }));
      models = modelRows.map((row) => ({ worker: row.worker, model: row.actualModelId ?? row.selectedModelId }));
    }
    return agentOfficeAmuxDetail({ names, owner, quotas, attempts, open, usage, models });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "amux_worker_detail" });
    return { kind: "unread" };
  }
}

/** The other queues an AMUX worker waits on a person for, each read on its own. */
async function readInboxCounts(now: Date): Promise<AgentOfficeInboxCounts> {
  const [dm, v22, refusals] = await Promise.allSettled([
    countDecisionMakerAttention(),
    prisma.amuxV22TaskQuestion.count({ where: { state: "open" } }),
    countOpenAmuxPlanRefusals(prisma as unknown as Prisma.TransactionClient, now),
  ]);
  const value = (result: PromiseSettledResult<number>, read: string) => {
    if (result.status === "fulfilled") return result.value;
    console.warn({ event: "admin_agent_office_read_failed", read });
    return null;
  };
  return {
    dmAttention: value(dm, "inbox_dm_attention"),
    v22Questions: value(v22, "inbox_v22_questions"),
    planRefusals: value(refusals, "inbox_plan_refusals"),
  };
}

/** Merge-lane merges in the last day: the PR number and when, for the floor's celebration. */
async function readMerges(now: Date): Promise<AgentOfficeMerges> {
  try {
    const rows = await prisma.qaReleaseMergeAttempt.findMany({
      where: { mergeCommitSha: { not: null }, updatedAt: { gte: new Date(now.getTime() - 86_400_000) } },
      orderBy: { updatedAt: "desc" },
      take: 20,
      select: { pullRequestNumber: true, consumedAt: true, updatedAt: true },
    });
    return {
      kind: "observed",
      items: rows.map((row) => ({ pr: row.pullRequestNumber, mergedAt: (row.consumedAt ?? row.updatedAt).toISOString() })),
    };
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "merge_lane_merges" });
    return { kind: "unread" };
  }
}

/** Rewinding reads at most this many of today's attempts (newest first). */
const HISTORY_CAP = 2_000;

/** Today's (AEST) attempts of the seated workers, open ones included, for the rewind. */
async function readHistory(amux: AgentOfficeAmuxState, now: Date): Promise<AgentOfficeHistory> {
  if (amux.kind !== "observed") return { kind: "unread" };
  const since = brisbaneMidnight(now);
  const names = amux.workers.map((worker) => worker.name);
  if (names.length === 0) return { kind: "observed", since: since.toISOString(), spans: [], truncated: false };
  try {
    const rows = await prisma.amuxExecutionAttempt.findMany({
      where: {
        worker: { in: names },
        startedAt: { lte: now },
        OR: [{ endedAt: null }, { endedAt: { gte: since } }],
      },
      orderBy: [{ startedAt: "desc" }, { id: "desc" }],
      take: HISTORY_CAP + 1,
      select: { worker: true, startedAt: true, endedAt: true, outcome: true },
    });
    return {
      kind: "observed",
      since: since.toISOString(),
      truncated: rows.length > HISTORY_CAP,
      spans: rows.slice(0, HISTORY_CAP).map((row) => ({
        worker: row.worker,
        startedAt: row.startedAt.toISOString(),
        endedAt: row.endedAt ? row.endedAt.toISOString() : null,
        mark: row.endedAt ? agentOfficeAttemptMark(row.outcome) : null,
      })),
    };
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "amux_history" });
    return { kind: "unread" };
  }
}

/**
 * The fifteen-second re-read of the AMUX room: its workers, their detail,
 * today's attempts and the day's merges. The same reads as the page, nothing
 * more; the caller decides `owner` from the session.
 */
export async function readAgentOfficeAmuxPulse(now: Date = new Date(), options: { owner?: boolean } = {}): Promise<AgentOfficeAmuxPulse> {
  const [amux, merges] = await Promise.all([readAmuxWorkers(), readMerges(now)]);
  const [amuxDetail, history] = await Promise.all([readAmuxDetail(amux, options.owner === true, now), readHistory(amux, now)]);
  return { readAt: now.toISOString(), amux, amuxDetail, merges, history };
}

export async function readAgentOfficeLiveRooms(
  now: Date = new Date(),
  options: { owner?: boolean } = {}
): Promise<AgentOfficeLiveRooms> {
  const [research, qa, finance, routing, sre, support, marketing, trust, engineering, amux, review, decision, digest, queue, inbox, merges] =
    await Promise.all([
      readResearch(now),
      readQa(),
      readFinance(),
      readRouting(now),
      readSre(),
      readSupport(),
      readMarketing(),
      readTrust(),
      readEngineering(),
      readAmuxWorkers(),
      readReview(),
      readDecision(),
      readDigest(now),
      readOperatorQueue(),
      readInboxCounts(now),
      readMerges(now),
    ]);
  const [amuxDetail, history] = await Promise.all([readAmuxDetail(amux, options.owner === true, now), readHistory(amux, now)]);
  return {
    readAt: now.toISOString(),
    research,
    qa,
    finance,
    routing,
    sre,
    support,
    marketing,
    trust,
    engineering,
    amux,
    review,
    decision,
    digest,
    queue,
    amuxDetail,
    inbox,
    merges,
    history,
  };
}
