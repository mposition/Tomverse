import "server-only";

import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog, writeSystemAuditLog } from "@/lib/adminAudit";
import { DAILY_PRODUCT_AGENT_AUDIT_ACTOR } from "@/lib/adminAuditSystemActors";
import { claimRecommendationInTransaction, type ClaimedRecommendation } from "@/lib/autoRouterRecAgent";
import { OPTIMIZER_LOCK } from "@/lib/autoRouterOptimizerLock";
import { REC_AGENT_LEASE_MS } from "@/lib/autoRouterRecommendationsCore";
import {
  DAILY_PRODUCT_AGENT_CURSOR, DAILY_PRODUCT_AGENT_DAY, DAILY_PRODUCT_AGENT_TASK_CAP, DAILY_PRODUCT_AGENT_PREFIX, dailyProductAgentEnabled,
  canRetryDailyProductTask, dailyProductAgentKey, dailyProductDaySchema, dailyProductResultDecision, followingSource, parseDailyProductState,
  scoutAgentId, scoutIdFromAgentId, sourceOrder, type DailyProductAgentState,
  type DailyProductResult, type DailyProductSource,
} from "@/lib/dailyProductAgentCore";
import { prisma } from "@/lib/prisma";
import { suggestionWorkBrief } from "@/lib/productResearchScoutIdeaText";

type DailyProductClaim = Omit<ClaimedRecommendation, "cycleId" | "index">;

async function saveSetting(tx: Prisma.TransactionClient, key: string, value: string) {
  await tx.appSetting.upsert({ where: { key }, create: { key, value }, update: { value } });
}

async function audit(tx: Prisma.TransactionClient, id: string, action: "claimed" | "result_recorded", metadata: Prisma.InputJsonObject) {
  await writeSystemAuditLog({ tx, systemActor: DAILY_PRODUCT_AGENT_AUDIT_ACTOR,
    action: `daily_product_agent.${action}`, targetType: "ProductResearchSuggestion", targetId: id,
    summary: action === "claimed" ? "The daily coding agent claimed a Scout suggestion."
      : "The daily coding agent recorded a Scout implementation result.", metadata });
}

/** No source is completed here: a draft PR is not a production deployment. */
export async function claimDailyProductTask(input: { origin: string; now?: Date }): Promise<DailyProductClaim | null> {
  if (!dailyProductAgentEnabled(process.env)) return null;
  const now = input.now ?? new Date();
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${OPTIMIZER_LOCK}))`;
    // Brisbane has no daylight saving; the quota key must not depend on ICU formatting.
    const day = new Date(now.getTime() + 10 * 60 * 60_000).toISOString().slice(0, 10);
    const daily = await tx.appSetting.findUnique({ where: { key: DAILY_PRODUCT_AGENT_DAY }, select: { value: true } });
    let count = 0;
    if (daily) {
      // Fail closed on corrupt budget state, rather than silently resetting it.
      let parsed;
      try { parsed = dailyProductDaySchema.safeParse(JSON.parse(daily.value)); } catch { return null; }
      if (!parsed.success || parsed.data.day > day) return null;
      if (parsed.data.day === day) count = parsed.data.count;
    }
    if (count >= DAILY_PRODUCT_AGENT_TASK_CAP) return null;
    const cursor = await tx.appSetting.findUnique({ where: { key: DAILY_PRODUCT_AGENT_CURSOR }, select: { value: true } });
    for (const source of sourceOrder(cursor?.value)) {
      const task = source === "routing"
        ? await claimRecommendationInTransaction(tx, input.origin, now)
        : await claimScout(tx, source, input.origin, now);
      if (!task) continue;
      await saveSetting(tx, DAILY_PRODUCT_AGENT_CURSOR, followingSource(source));
      await saveSetting(tx, DAILY_PRODUCT_AGENT_DAY, JSON.stringify({ day, count: count + 1 }));
      return task;
    }
    return null;
  });
}

async function claimScout(tx: Prisma.TransactionClient, source: Exclude<DailyProductSource, "routing">, origin: string, now: Date): Promise<DailyProductClaim | null> {
  // Any existing row fences the source forever, including expired/invalid
  // leases and unknown publish outcomes. No daily automatic retries.
  const records = await tx.appSetting.findMany({ where: { key: { startsWith: `${DAILY_PRODUCT_AGENT_PREFIX}scout.` } }, select: { key: true, value: true } });
  const held = records.filter((row) => parseDailyProductState(row.value)?.status !== "retry_ready");
  const sent = await tx.appSetting.findMany({ where: { key: { startsWith: `${DAILY_PRODUCT_AGENT_PREFIX}amux.` } }, select: { key: true } });
  const heldIds = [...held, ...sent].flatMap(({ key }) => {
    if (key.startsWith(`${DAILY_PRODUCT_AGENT_PREFIX}amux.`)) return [key.slice(`${DAILY_PRODUCT_AGENT_PREFIX}amux.`.length)];
    const id = scoutIdFromAgentId(key.slice(DAILY_PRODUCT_AGENT_PREFIX.length));
    return id ? [id] : [];
  });
  const memory = { startsWith: "memory.continuation." };
  const row = await tx.productResearchSuggestion.findFirst({
    where: { status: "open", amuxIdeaId: null, id: { notIn: heldIds },
      ...(source === "memory" ? { subject: memory } : { NOT: { subject: memory } }) },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  if (!row) return null;
  const id = scoutAgentId(row.id);
  const claimId = randomUUID();
  const leaseUntil = new Date(now.getTime() + REC_AGENT_LEASE_MS).toISOString();
  const entry: DailyProductAgentState = { source, claimId, at: now.toISOString(), leaseUntil, status: "claimed" };
  await saveSetting(tx, dailyProductAgentKey(id), JSON.stringify(entry));
  await audit(tx, row.id, "claimed", { source, claimId, leaseUntil });
  return { id, recommendation: row.title, findings: [row.evidence], claimId, leaseUntil,
    instruction: suggestionWorkBrief({ ...row, url: `${origin}/admin/product-research` }, {
      url: "Admin source", done: "Verify the current develop code first. If already solved, report the evidence without a duplicate change. Otherwise implement, run relevant tests, and commit the smallest fix. Never mark this suggestion completed or send it to AMUX.",
    }) };
}

export async function recordDailyProductResult(input: DailyProductResult) {
  const id = scoutIdFromAgentId(input.id);
  if (!id) return { refused: "not_found" as const };
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const key = dailyProductAgentKey(input.id);
    const stored = await tx.appSetting.findUnique({ where: { key }, select: { value: true } });
    const current = parseDailyProductState(stored?.value);
    const decision = dailyProductResultDecision(current, input);
    if (decision === "not_claimed" || !current) return { refused: "not_claimed" as const };
    if (decision === "replay") return { ok: true as const, changed: false };
    // A factual result belongs to its claim even if a person has since closed
    // the source. Never overwrite that person's suggestion status.
    const next: DailyProductAgentState = input.outcome === "pr_opened"
      ? { ...current, status: "pr_opened", prUrl: input.prUrl }
      : { ...current, status: "failed", reason: input.reason };
    await saveSetting(tx, key, JSON.stringify(next));
    await audit(tx, id, "result_recorded", { claimId: input.claimId, outcome: input.outcome,
      ...(input.outcome === "pr_opened" ? { prUrl: input.prUrl } : { reason: input.reason }) });
    return { ok: true as const, changed: true };
  });
}

/** Owner route only: unknown publication/review outcomes are never released here. */
export async function retryDailyProductTask(input: { id: string; session: Session; request: Request }) {
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const id = scoutAgentId(input.id), key = dailyProductAgentKey(id);
    const row = await tx.productResearchSuggestion.findUnique({ where: { id: input.id }, select: { status: true, amuxIdeaId: true } });
    const sent = await tx.appSetting.findUnique({ where: { key: `${DAILY_PRODUCT_AGENT_PREFIX}amux.${input.id}` }, select: { key: true } });
    if (!row || row.status !== "open" || row.amuxIdeaId || sent) return false;
    const stored = await tx.appSetting.findUnique({ where: { key }, select: { value: true } });
    const current = parseDailyProductState(stored?.value);
    if (!canRetryDailyProductTask(current) || current?.status !== "failed") return false;
    await saveSetting(tx, key, JSON.stringify({ ...current, status: "retry_ready" }));
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "product_research.suggestion.agent_retry_requested", targetType: "product_research_suggestion", targetId: input.id,
      summary: "Owner queued a known pre-publication failure for another coding attempt.",
      metadata: { priorClaimId: current.claimId, reason: current.reason } });
    return true;
  });
}
