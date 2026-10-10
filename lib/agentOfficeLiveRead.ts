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

import type {
  AgentOfficeReviewState,
  AgentOfficeAmuxState,
  AgentOfficeDecisionState,
  AgentOfficeEngineeringState,
  AgentOfficeFinanceState,
  AgentOfficeLiveRooms,
  AgentOfficeOperatorQueue,
  AgentOfficeQaState,
  AgentOfficeResearchState,
} from "@/lib/agentOffice/live";
import {
  countAutoFixActionCases,
  countAwaitingAmuxEscalations,
  countPendingMarketingApprovals,
} from "@/lib/adminNavigationCounts";
import { agentOfficeAmuxState } from "@/lib/agentOfficeAmuxState";
import { AGENT_OFFICE_DECISION_WINDOW_MS, agentOfficeDecisionState } from "@/lib/agentOfficeDecisionState";
import { agentOfficeFinanceState } from "@/lib/agentOfficeFinanceState";
import {
  AGENT_OFFICE_ENGINEERING_SETTING_KEYS,
  agentOfficeEngineeringState,
} from "@/lib/agentOfficeEngineeringState";
import { agentOfficeQaState } from "@/lib/agentOfficeQaState";
import { agentOfficeReviewState } from "@/lib/agentOfficeReviewState";
import { agentOfficeResearchState } from "@/lib/agentOfficeResearchState";
import { readDecisionMakerSwitchesOrThrow } from "@/lib/amux/decisionMakerSwitchStore";
import { countOpenAmuxOrchestratorHalts } from "@/lib/amux/orchestratorHaltStore";
import { getConfiguredAmuxWorkerCatalog } from "@/lib/amux/routing";
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
import { prisma } from "@/lib/prisma";
import { isProductResearchRouteEnabled } from "@/lib/productResearchObservationRouteAuth";
import {
  PRODUCT_RESEARCH_ENABLED_SINCE_SETTING,
  latestProductResearchSuccess,
} from "@/lib/productResearchObservationStore";
import { slotForInstant } from "@/lib/productResearchObservationRunnerCore.mjs";
import { QA_RELEASE_ROUTE_SECRET_ENV } from "@/lib/qaReleaseRouteAuthCore";

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
    const catalog = getConfiguredAmuxWorkerCatalog();
    const names = (catalog ?? []).filter((worker) => !worker.archived).map((worker) => worker.worker_name);
    const runtimes = names.length
      ? await prisma.amuxWorkerRuntime.findMany({
          where: { workerName: { in: names } },
          select: { workerName: true, status: true, dispatchReady: true, heartbeatAt: true, leaseExpiresAt: true },
        })
      : [];
    // Judged against a clock taken after the read: a lease that has run out
    // by then is lost, never live.
    return agentOfficeAmuxState({ catalog, runtimes, now: new Date() });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "amux_workers" });
    return { kind: "unread" };
  }
}

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
 * The AMUX Decision Maker: its switches (through its own reader), and three
 * aggregates of its ledger -- questions per route and instance in the last 24
 * hours, the newest routing per route and instance, and the newest judgment
 * per instance. Counts and times only: no card, question, proposal, digest or
 * person's id is selected.
 */
async function readDecision(now: Date): Promise<AgentOfficeDecisionState> {
  try {
    const since = new Date(now.getTime() - AGENT_OFFICE_DECISION_WINDOW_MS);
    const [switches, recent, latest, judged] = await Promise.all([
      readDecisionMakerSwitchesOrThrow(prisma),
      prisma.amuxDecisionMakerRequest.groupBy({
        by: ["route", "instance"],
        where: { createdAt: { gte: since } },
        _count: { _all: true },
      }),
      prisma.amuxDecisionMakerRequest.groupBy({ by: ["route", "instance"], _max: { createdAt: true } }),
      prisma.amuxDecisionMakerJudgment.groupBy({ by: ["instance"], _max: { createdAt: true } }),
    ]);
    return agentOfficeDecisionState({
      switches,
      recent: recent.map((row) => ({ route: row.route, instance: row.instance, count: row._count._all })),
      latest: latest.map((row) => ({ route: row.route, instance: row.instance, lastAt: row._max.createdAt })),
      judgments: judged.map((row) => ({ instance: row.instance, lastAt: row._max.createdAt })),
    });
  } catch {
    console.warn({ event: "admin_agent_office_read_failed", read: "decision_maker" });
    return { kind: "unread" };
  }
}

/**
 * The operator to-do counts, each read on its own: one failing count is
 * that count unknown, not the whole to-do zero (rule 8).
 */
async function readOperatorQueue(): Promise<AgentOfficeOperatorQueue> {
  const [marketing, amuxEscalations, amuxHalts, autoFix] = await Promise.allSettled([
    countPendingMarketingApprovals(),
    countAwaitingAmuxEscalations(),
    countOpenAmuxOrchestratorHalts(),
    countAutoFixActionCases(),
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
    autoFix: value(autoFix, "operator_queue_autofix"),
  };
}

export async function readAgentOfficeLiveRooms(now: Date = new Date()): Promise<AgentOfficeLiveRooms> {
  const [research, qa, finance, engineering, amux, review, decision, queue] = await Promise.all([
    readResearch(now),
    readQa(),
    readFinance(),
    readEngineering(),
    readAmuxWorkers(),
    readReview(),
    readDecision(now),
    readOperatorQueue(),
  ]);
  return { readAt: now.toISOString(), research, qa, finance, engineering, amux, review, decision, queue };
}
