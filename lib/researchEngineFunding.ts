import "server-only";

import type { AiModel } from "@/lib/models";
import type { TokenEstimateBreakdown } from "@/lib/chatTokenEstimate";
import { prisma } from "@/lib/prisma";
import { researchNow } from "@/lib/researchEngineRuntime";
import { recordResearchFundingSettled } from "@/lib/researchEngineStore";

/**
 * How Research engine v2 holds and settles money. Each paid model dispatch is
 * one ordinary Chat reservation (createChatBudget -> acquireChatAccess ->
 * settleChatUsage), so credit ledgers, provider budgets, search vendor budgets
 * and expiry reconciliation keep their existing meaning. The run's own total
 * is enforced separately in lib/researchEngineStore.ts before each hold.
 */

export type ResearchFundingEstimate = { credits: number; pricingVersion: string; searchSurchargeCredits: number; budget: unknown };

export type ResearchSettlementUsage = {
  inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number;
  outputTokens?: number; reasoningTokens?: number;
  usageFromProvider: boolean;
  outcome: "completed" | "cancelled" | "failed" | "empty";
  searchSurchargeCredits?: number; searchExecuted?: boolean; searchQueryCount?: number;
  searchBackendRequestCount?: number; searchQueriesObserved: boolean;
};

export type ResearchFundingRefusal = { kind: "budget" | "backpressure" | "refused"; code: string; retryAfterMs?: number };

export type ResearchFundingAdapter = {
  estimate(input: { userId: string; model: AiModel; inputEstimate: TokenEstimateBreakdown; outputTokenCap: number; searchEnabled: boolean }):
    Promise<ResearchFundingEstimate>;
  reserve(input: { userId: string; segmentId: string; model: AiModel; estimate: ResearchFundingEstimate; searchEnabled: boolean }):
    Promise<{ ok: true; reservationId: string; reservedCredits: number; leaseId: string | null } | ({ ok: false } & ResearchFundingRefusal)>;
  releaseLease(input: { userId: string; leaseId: string | null; segmentId: string }): Promise<void>;
  settle(input: { userId: string; reservationId: string; usage: ResearchSettlementUsage }): Promise<{ settledCredits: number }>;
};

const BACKPRESSURE_CODES = new Set(["CHAT_QUOTA_EXCEEDED", "CHAT_IP_QUOTA_EXCEEDED", "CHAT_IP_COST_QUOTA_EXCEEDED",
  "CHAT_CONCURRENCY_LIMIT", "AI_CHAT_DISABLED_BY_ADMIN", "PROVIDER_BUDGET_EXCEEDED"]);
const BUDGET_CODES = new Set(["PLAN_DAILY_CREDIT_LIMIT_REACHED", "CREDIT_COST_ALLOWANCE_INSUFFICIENT",
  "CHAT_CREDITS_EXHAUSTED", "INSUFFICIENT_CREDITS", "FREE_PRO_MODEL_QUOTA_EXCEEDED"]);

export function classifyResearchFundingError(error: unknown): ResearchFundingRefusal {
  const record = error as { code?: unknown; status?: unknown } | null;
  const code = typeof record?.code === "string" ? record.code : "RESEARCH_RESERVATION_FAILED";
  if (BUDGET_CODES.has(code) || record?.status === 402) return { kind: "budget", code };
  if (BACKPRESSURE_CODES.has(code) || record?.status === 429 || record?.status === 503) return { kind: "backpressure", code, retryAfterMs: 30_000 };
  return { kind: "refused", code };
}

/** The production adapter over lib/chatSecurity.ts. Loaded lazily so pure tests never import it. */
export async function createChatResearchFundingAdapter(): Promise<ResearchFundingAdapter> {
  const security = await import("@/lib/chatSecurity");
  const { getUserBillingPlan } = await import("@/lib/billingEntitlements");
  const { getWebSearchCapability } = await import("@/lib/webSearchCapability");
  const { reserveTurnSearchCost } = await import("@/lib/webSearchNativeCostReservation");
  const { getWebSearchSurchargeCredits } = await import("@/lib/webSearchCredits");
  const { resolveWebSearchBackendReadiness } = await import("@/lib/webSearchBackendRuntime");
  const internalRequest = () => new Request("http://127.0.0.1/internal/research-engine-worker");
  return {
    async estimate({ model, inputEstimate, outputTokenCap, searchEnabled }) {
      let searchBackend: import("@/lib/chatSecurity").ChatBudget["searchBackend"] = null;
      let surcharge = 0;
      if (searchEnabled) {
        const capability = getWebSearchCapability(model);
        const reservation = reserveTurnSearchCost({ model, capability, appManagedSearchEnabled: true, nativeSearchEnabled: false });
        searchBackend = reservation.ok ? reservation.searchBackend : null;
        surcharge = reservation.ok ? getWebSearchSurchargeCredits("always", capability, resolveWebSearchBackendReadiness()) : 0;
        // Research searches always run on Brave (runResearchSearch). Unless that
        // exact backend is reserved and priced for this model, no search is funded:
        // an admin turning web search off for the model refuses the turn here.
        if (searchBackend?.backend !== "brave" || surcharge <= 0) {
          throw Object.assign(new Error("RESEARCH_SEARCH_UNAVAILABLE"), { code: "RESEARCH_SEARCH_UNAVAILABLE" });
        }
      }
      const budget = security.createChatBudget("user", model, inputEstimate, {
        appManagedSearchEnabled: searchEnabled, searchBackend, webSearchSurchargeCredits: surcharge,
        toolInputPasses: 1, toolInputAboveAuthoredLimit: true, totalOutputTokenCap: outputTokenCap,
      });
      return { credits: budget.usageCredits, pricingVersion: budget.pricingVersion, searchSurchargeCredits: surcharge, budget };
    },
    async reserve({ userId, segmentId, estimate, searchEnabled }) {
      const plan = await getUserBillingPlan(userId);
      const access = security.identifyChatCaller(internalRequest(), userId, plan.tier, {
        dailyMessageLimit: plan.dailyMessageLimit, monthlyMessageLimit: plan.monthlyMessageLimit,
      });
      let acquired: Awaited<ReturnType<typeof security.acquireChatAccess>>;
      try {
        acquired = await security.acquireChatAccess(access, estimate.budget as Parameters<typeof security.acquireChatAccess>[1], {
          source: "chat", traceId: segmentId, enabledTools: searchEnabled ? ["web_search"] : [],
        });
      } catch (error) {
        return { ok: false as const, ...classifyResearchFundingError(error) };
      }
      // Once a hold exists it is always returned so the caller binds it to the
      // segment. A longer expiry is only an optimisation: expiry reconciliation
      // defers a segment whose dispatch is still active.
      await security.extendChatReservationExpiry(acquired.usageReservation.reservationId, 30 * 60).catch((error: unknown) => {
        console.warn("[research-engine] reservation expiry extension failed", { segmentId, code: (error as { code?: string })?.code ?? "unknown" });
      });
      return { ok: true as const, reservationId: acquired.usageReservation.reservationId,
        reservedCredits: acquired.usageReservation.usageCredits, leaseId: acquired.leaseId };
    },
    async releaseLease({ userId, leaseId, segmentId }) {
      if (!leaseId) return;
      const access = security.identifyChatCaller(internalRequest(), userId);
      await security.releaseChatAccess(leaseId, { traceId: segmentId, reason: "research_engine_dispatch_finished", subjectScope: access.subjectKey });
    },
    async settle({ userId, reservationId, usage }) {
      const reservation = await security.readChatUsageReservationForSettlement(reservationId, userId);
      const result = await security.settleChatUsage(reservation, usage);
      if (result.settledCredits === null || result.settledCredits === undefined) {
        const durable = await prisma.chatCreditReservation.findUnique({ where: { id: reservationId }, select: { reservedCredits: true, settledCredits: true, status: true } });
        // Never report a segment settled while its Chat hold is still open: the
        // segment stays reserved and the next maintenance pass retries.
        if (!durable || durable.status === "reserved") {
          throw Object.assign(new Error("RESEARCH_SETTLEMENT_PENDING"), { code: "RESEARCH_SETTLEMENT_PENDING" });
        }
        // A released hold charged nothing; otherwise trust the durable figure.
        if (durable.status === "released") return { settledCredits: durable.settledCredits ?? 0 };
        return { settledCredits: durable.settledCredits ?? (usage.usageFromProvider ? 0 : durable.reservedCredits) };
      }
      return { settledCredits: result.settledCredits };
    },
  };
}

let adapter: ResearchFundingAdapter | null = null;
export const setResearchFundingAdapter = (next: ResearchFundingAdapter | null) => { adapter = next; };
export async function researchFundingAdapter() {
  adapter ??= await createChatResearchFundingAdapter();
  return adapter;
}

/**
 * Settles a reserved segment once every dispatch it funds is terminal. A model
 * dispatch carries token usage; its child searches carry the search count.
 * Any unknown dispatch makes the settlement conservative (usageFromProvider
 * false / searchQueriesObserved false), the existing Chat meaning.
 */
export async function settleResearchSegmentIfReady(segmentId: string) {
  const segment = await prisma.researchFundingSegment.findUnique({
    where: { id: segmentId },
    include: { run: { select: { userId: true, searchSurchargeCredits: true } }, generations: true },
  });
  // A segment whose run is gone is left to expiry reconciliation (charged as unknown).
  if (!segment || !segment.run || !segment.reservationId || !["reserved", "unknown"].includes(segment.status)) return false;
  const generations = segment.generations;
  if (generations.some((generation) => generation.status === "intent" || generation.status === "dispatch_started")) return false;
  const childSearchesPending = await prisma.researchWorkItem.count({
    where: { runId: segment.runId!, kind: "search", status: { in: ["queued", "running", "blocked"] },
      payload: { path: ["fundingSegmentId"], equals: segment.id } },
  });
  if (childSearchesPending) return false;
  const model = generations.find((generation) => generation.kind === "model");
  // No dispatch intent yet: the worker may be between binding the hold and recording
  // its intent. Only recovery, under the run lock, may release such a segment.
  if (!model) return false;
  const searches = generations.filter((generation) => generation.kind === "search");
  const modelUnknown = model.status === "outcome_unknown";
  const searchUnknown = searches.some((generation) => generation.status === "outcome_unknown");
  const succeeded = searches.filter((generation) => generation.status === "completed" && (generation.searchRequestCount ?? 0) > 0)
    .reduce((sum, generation) => sum + (generation.searchRequestCount ?? 0), 0);
  const nothingDispatched = model.status === "dispatch_refused";
  const usage: ResearchSettlementUsage = nothingDispatched ? {
    inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, cacheWriteInputTokens: 0, reasoningTokens: 0,
    usageFromProvider: true, outcome: "failed", searchSurchargeCredits: segment.searchSurchargeCredits, searchExecuted: false, searchQueryCount: 0,
    searchBackendRequestCount: 0, searchQueriesObserved: true,
  } : modelUnknown ? {
    usageFromProvider: false, outcome: "failed", searchSurchargeCredits: segment.searchSurchargeCredits, searchQueriesObserved: false,
  } : {
    inputTokens: model.inputTokens ?? 0, cachedInputTokens: model.cachedInputTokens ?? 0,
    cacheWriteInputTokens: model.cacheWriteInputTokens ?? 0, outputTokens: model.outputTokens ?? 0,
    reasoningTokens: model.reasoningTokens ?? 0, usageFromProvider: true, outcome: "completed",
    // The reserved surcharge is passed so Chat settlement refunds it when no search was served.
    searchSurchargeCredits: segment.searchSurchargeCredits, searchExecuted: succeeded > 0, searchQueryCount: succeeded, searchBackendRequestCount: succeeded,
    searchQueriesObserved: !searchUnknown,
  };
  const funding = await researchFundingAdapter();
  let settledCredits: number;
  try {
    ({ settledCredits } = await funding.settle({ userId: segment.run.userId, reservationId: segment.reservationId, usage }));
  } catch (error) {
    if ((error as { code?: string }).code === "RESEARCH_SETTLEMENT_PENDING") return false;
    throw error;
  }
  await recordResearchFundingSettled(segment.id, Math.min(settledCredits, segment.reservedCredits), { ...usage, settledAt: researchNow().toISOString() });
  return true;
}
