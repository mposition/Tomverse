import "server-only";

import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import { ResearchPreviewRunError } from "@/lib/deepResearchSettlementHandoff";
import type { ResearchWorkItemKind, ResearchWorkPayload } from "@/lib/researchEngineContract";
import { researchNow } from "@/lib/researchEngineRuntime";

/**
 * Durable state for Research engine v2. Every write that can race a worker is
 * fenced by (leaseOwner, leaseEpoch) on the work item and serialised with the
 * run row lock in one order: run row -> work item -> generation -> segment.
 * Completion, cancellation and recovery all take that order.
 */

export const RESEARCH_ITEM_LEASE_MS = 90_000;
export const RESEARCH_ITEM_MAX_ATTEMPTS = 4;
export const RESEARCH_SEGMENT_RESERVING_STALE_MS = 90_000;

export type ResearchConcurrencyLimits = {
  global: number;
  perAccount: number;
  perRun: number;
  perProvider: number;
};

export const researchConcurrencyLimits = (env: Record<string, string | undefined> = process.env): ResearchConcurrencyLimits => {
  const read = (name: string, fallback: number) => {
    const value = Number(env[name]);
    return Number.isSafeInteger(value) && value >= 1 && value <= 1_000 ? value : fallback;
  };
  return {
    global: read("RESEARCH_ENGINE_MAX_RUNNING_ITEMS", 32),
    perAccount: read("RESEARCH_ENGINE_MAX_RUNNING_ITEMS_PER_ACCOUNT", 4),
    perRun: read("RESEARCH_ENGINE_MAX_RUNNING_ITEMS_PER_RUN", 4),
    perProvider: read("RESEARCH_ENGINE_MAX_RUNNING_ITEMS_PER_PROVIDER", 16),
  };
};

const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

export const lockResearchRun = (tx: Prisma.TransactionClient, runId: string) =>
  tx.$queryRaw`SELECT "id" FROM "ResearchPreviewRun" WHERE "id" = ${runId} FOR UPDATE`;

/** Every visible mutation bumps the sequence clients use to drop stale responses. */
export const bumpRunSequence = (tx: Prisma.TransactionClient, runId: string, data: Prisma.ResearchPreviewRunUpdateInput = {}) =>
  tx.researchPreviewRun.update({ where: { id: runId }, data: { ...data, eventSequence: { increment: 1 } } });

export type NewResearchWorkItem = {
  kind: ResearchWorkItemKind;
  idempotencyKey: string;
  payload: ResearchWorkPayload;
  dependsOn?: string[];
  priority?: number;
  providerKey?: string | null;
  planRevision: number;
  inputRevision: number;
  status?: "queued" | "blocked";
};

/** Idempotent: the same key for the same run never creates a second item. */
export async function enqueueResearchWorkItems(tx: Prisma.TransactionClient, runId: string, items: readonly NewResearchWorkItem[]) {
  if (!items.length) return [] as Array<{ id: string; idempotencyKey: string }>;
  await tx.researchWorkItem.createMany({
    data: items.map((item) => ({
      runId, kind: item.kind, idempotencyKey: item.idempotencyKey.slice(0, 200), payload: json(item.payload),
      dependsOn: item.dependsOn ?? [], priority: item.priority ?? 0, providerKey: item.providerKey ?? null,
      planRevision: item.planRevision, inputRevision: item.inputRevision, status: item.status ?? "queued",
    })),
    skipDuplicates: true,
  });
  return tx.researchWorkItem.findMany({
    where: { runId, idempotencyKey: { in: items.map((item) => item.idempotencyKey.slice(0, 200)) } },
    select: { id: true, idempotencyKey: true },
  });
}

type ClaimCandidate = { id: string; runId: string; userId: string; providerKey: string | null; kind: string };

/**
 * Claims one runnable item under the global claim lock. Fairness: accounts and
 * runs with the fewest running items go first, so one large run cannot occupy
 * every slot; per-account, per-run, per-provider and global limits all hold.
 */
export async function claimNextResearchWorkItem(ownerId: string, limits: ResearchConcurrencyLimits = researchConcurrencyLimits()) {
  const now = researchNow();
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('research-engine-claim'))`;
    const running = await tx.$queryRaw<Array<{ userId: string; runId: string; providerKey: string | null; n: bigint }>>`
      SELECT r."userId", w."runId", w."providerKey", count(*)::bigint AS n
      FROM "ResearchWorkItem" w JOIN "ResearchPreviewRun" r ON r."id" = w."runId"
      WHERE w."status" = 'running'
      GROUP BY r."userId", w."runId", w."providerKey"`;
    let global = 0;
    const byUser = new Map<string, number>(); const byRun = new Map<string, number>(); const byProvider = new Map<string, number>();
    for (const row of running) {
      const n = Number(row.n); global += n;
      byUser.set(row.userId, (byUser.get(row.userId) ?? 0) + n);
      byRun.set(row.runId, (byRun.get(row.runId) ?? 0) + n);
      if (row.providerKey) byProvider.set(row.providerKey, (byProvider.get(row.providerKey) ?? 0) + n);
    }
    if (global >= limits.global) return null;
    const candidates = await tx.$queryRaw<ClaimCandidate[]>`
      SELECT w."id", w."runId", r."userId", w."providerKey", w."kind"
      FROM "ResearchWorkItem" w JOIN "ResearchPreviewRun" r ON r."id" = w."runId"
      WHERE w."status" = 'queued'
        AND (w."notBefore" IS NULL OR w."notBefore" <= ${now})
        AND r."engineVersion" = 2
        AND r."status" IN ('planning', 'queued', 'running', 'finalizing')
        AND r."cancelRequestedAt" IS NULL
        AND r."pauseRequestedAt" IS NULL
        AND r."recoveryQuarantinedAt" IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM "ResearchWorkItem" d
          WHERE d."id" = ANY(w."dependsOn") AND d."status" IN ('queued', 'running', 'blocked')
        )
      ORDER BY
        (SELECT count(*) FROM "ResearchWorkItem" x JOIN "ResearchPreviewRun" xr ON xr."id" = x."runId"
           WHERE x."status" = 'running' AND xr."userId" = r."userId") ASC,
        (SELECT count(*) FROM "ResearchWorkItem" y WHERE y."status" = 'running' AND y."runId" = w."runId") ASC,
        w."priority" DESC, w."createdAt" ASC, w."id" ASC
      LIMIT 64`;
    const pick = candidates.find((candidate) =>
      (byUser.get(candidate.userId) ?? 0) < limits.perAccount &&
      (byRun.get(candidate.runId) ?? 0) < limits.perRun &&
      (!candidate.providerKey || (byProvider.get(candidate.providerKey) ?? 0) < limits.perProvider));
    if (!pick) return null;
    const locked = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "ResearchWorkItem" WHERE "id" = ${pick.id} AND "status" = 'queued' FOR UPDATE SKIP LOCKED`;
    if (!locked.length) return null;
    const item = await tx.researchWorkItem.update({
      where: { id: pick.id },
      data: { status: "running", leaseOwner: ownerId, leaseEpoch: { increment: 1 },
        leaseExpiresAt: new Date(now.getTime() + RESEARCH_ITEM_LEASE_MS), startedAt: now, attempts: { increment: 1 } },
    });
    await tx.researchPreviewRun.updateMany({ where: { id: pick.runId, status: "queued" }, data: { status: "running", startedAt: now } });
    return item;
  });
}

export type ResearchItemFence = { itemId: string; ownerId: string; leaseEpoch: number };

export async function heartbeatResearchWorkItem(fence: ResearchItemFence) {
  const now = researchNow();
  const changed = await prisma.researchWorkItem.updateMany({
    where: { id: fence.itemId, status: "running", leaseOwner: fence.ownerId, leaseEpoch: fence.leaseEpoch, leaseExpiresAt: { gt: now } },
    data: { leaseExpiresAt: new Date(now.getTime() + RESEARCH_ITEM_LEASE_MS) },
  });
  return changed.count === 1;
}

/** Throws unless this worker still holds the item's lease. Call inside a transaction holding the run lock. */
export async function assertResearchItemFence(tx: Prisma.TransactionClient, fence: ResearchItemFence) {
  const item = await tx.researchWorkItem.findFirst({
    where: { id: fence.itemId, status: "running", leaseOwner: fence.ownerId, leaseEpoch: fence.leaseEpoch },
  });
  if (!item) throw new ResearchPreviewRunError(409, "RESEARCH_ITEM_LEASE_LOST", "The Research work item lease is no longer held.");
  return item;
}

export async function finishResearchWorkItem(tx: Prisma.TransactionClient, fence: ResearchItemFence, outcome: {
  status: "completed" | "failed" | "attention" | "cancelled" | "superseded";
  result?: unknown;
  errorCode?: string;
}) {
  await assertResearchItemFence(tx, fence);
  const now = researchNow();
  return tx.researchWorkItem.update({
    where: { id: fence.itemId },
    data: { status: outcome.status, ...(outcome.result !== undefined ? { result: json(outcome.result) } : {}),
      errorCode: outcome.errorCode?.slice(0, 80) ?? null, leaseOwner: null, leaseExpiresAt: null, completedAt: now },
  });
}

/** Return a claimed item to the queue without a dispatch having happened (backpressure, pause). */
export async function requeueResearchWorkItem(tx: Prisma.TransactionClient, fence: ResearchItemFence, options: {
  delayMs?: number; blocked?: boolean; errorCode?: string; refundAttempt?: boolean;
} = {}) {
  await assertResearchItemFence(tx, fence);
  const now = researchNow();
  return tx.researchWorkItem.update({
    where: { id: fence.itemId },
    data: { status: options.blocked ? "blocked" : "queued", leaseOwner: null, leaseExpiresAt: null,
      notBefore: options.delayMs ? new Date(now.getTime() + options.delayMs) : null,
      errorCode: options.errorCode?.slice(0, 80) ?? null,
      ...(options.refundAttempt ? { attempts: { decrement: 1 } } : {}) },
  });
}

// ---------------------------------------------------------------------------
// Dispatch ledger (reuses ResearchPreviewGeneration).

export type ResearchDispatchIdentity = {
  kind: "model" | "search" | "read";
  dispatchKey: string;
  fundingSegmentId?: string | null;
  modelId?: string; provider?: string; apiModel?: string; reasoning?: string; pricingVersion?: string;
};

/**
 * Records the intent before any external call. A key whose earlier attempt
 * reached `dispatch_started` or `outcome_unknown` is refused forever: an
 * unknown outcome is never retried blindly.
 */
export async function beginResearchDispatch(fence: ResearchItemFence & { runId: string }, identity: ResearchDispatchIdentity) {
  return prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, fence.runId);
    await assertResearchItemFence(tx, fence);
    const existing = await tx.researchPreviewGeneration.findUnique({
      where: { runId_dispatchKey: { runId: fence.runId, dispatchKey: identity.dispatchKey } },
    });
    if (existing) {
      if (existing.status === "completed") return { generation: existing, alreadyCompleted: true as const };
      if (existing.status !== "intent" && existing.status !== "dispatch_refused") {
        throw new ResearchPreviewRunError(409, "RESEARCH_DISPATCH_OUTCOME_UNKNOWN", "This dispatch already started; its outcome must be verified before any retry.");
      }
      const generation = await tx.researchPreviewGeneration.update({ where: { id: existing.id }, data: {
        status: "intent", leaseEpoch: fence.leaseEpoch, fundingSegmentId: identity.fundingSegmentId ?? existing.fundingSegmentId,
        stopReason: null, completedAt: null } });
      return { generation, alreadyCompleted: false as const };
    }
    const max = await tx.researchPreviewGeneration.aggregate({ where: { runId: fence.runId }, _max: { generationIndex: true } });
    const generation = await tx.researchPreviewGeneration.create({ data: {
      runId: fence.runId, generationIndex: (max._max.generationIndex ?? 0) + 1, status: "intent", leaseEpoch: fence.leaseEpoch,
      checkpointVersionBefore: 0, engineVersion: 2, kind: identity.kind, workItemId: fence.itemId,
      fundingSegmentId: identity.fundingSegmentId ?? null, dispatchKey: identity.dispatchKey,
      modelId: identity.modelId ?? null, provider: identity.provider ?? null, apiModel: identity.apiModel ?? null,
      reasoning: identity.reasoning ?? null, pricingVersion: identity.pricingVersion ?? null,
    } });
    return { generation, alreadyCompleted: false as const };
  });
}

/** The last fenced write before the network. After this, the outcome is "unknown" until recorded. */
export async function markResearchDispatchStarted(fence: ResearchItemFence & { runId: string }, generationId: string) {
  const changed = await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, fence.runId);
    const now = researchNow();
    const run = await tx.researchPreviewRun.findFirst({ where: { id: fence.runId, cancelRequestedAt: null }, select: { id: true } });
    if (!run) return 0;
    const item = await tx.researchWorkItem.findFirst({ where: { id: fence.itemId, status: "running", leaseOwner: fence.ownerId,
      leaseEpoch: fence.leaseEpoch, leaseExpiresAt: { gt: now } }, select: { id: true } });
    if (!item) return 0;
    const updated = await tx.researchPreviewGeneration.updateMany({ where: { id: generationId, status: "intent", leaseEpoch: fence.leaseEpoch },
      data: { status: "dispatch_started", dispatchStartedAt: now } });
    return updated.count;
  });
  if (changed !== 1) throw new ResearchPreviewRunError(409, "RESEARCH_DISPATCH_REFUSED", "This Research dispatch is no longer authorized.");
}

export type ResearchDispatchUsage = {
  inputTokens?: number; cachedInputTokens?: number; cacheWriteInputTokens?: number;
  outputTokens?: number; reasoningTokens?: number; searchRequestCount?: number; readCount?: number;
};

export async function completeResearchDispatch(tx: Prisma.TransactionClient, generationId: string, usage: ResearchDispatchUsage) {
  const changed = await tx.researchPreviewGeneration.updateMany({
    where: { id: generationId, status: "dispatch_started" },
    data: { status: "completed", completedAt: researchNow(), inputTokens: usage.inputTokens ?? null,
      cachedInputTokens: usage.cachedInputTokens ?? null, cacheWriteInputTokens: usage.cacheWriteInputTokens ?? null,
      outputTokens: usage.outputTokens ?? null, reasoningTokens: usage.reasoningTokens ?? null,
      searchRequestCount: usage.searchRequestCount ?? null, readCount: usage.readCount ?? null },
  });
  if (changed.count !== 1) throw new ResearchPreviewRunError(409, "RESEARCH_DISPATCH_COMMIT_CONFLICT", "The Research dispatch was not committed.");
}

/** A known pre-dispatch failure (never reached the network). Safe to retry with the same key. */
export const refuseResearchDispatch = (tx: Prisma.TransactionClient | typeof prisma, generationId: string, reason: string) =>
  tx.researchPreviewGeneration.updateMany({ where: { id: generationId, status: "intent" },
    data: { status: "dispatch_refused", stopReason: "dispatch_refused", completedAt: researchNow() } }).then(() => reason);

export const markResearchDispatchUnknown = (tx: Prisma.TransactionClient | typeof prisma, generationId: string) =>
  tx.researchPreviewGeneration.updateMany({ where: { id: generationId, status: "dispatch_started" },
    data: { status: "outcome_unknown", stopReason: "outcome_unknown", completedAt: researchNow() } });

// ---------------------------------------------------------------------------
// Funding segments: the run-total invariant.

export type ResearchRunMoney = {
  approvedCredits: number; settledCredits: number; reservedCredits: number; unknownCredits: number;
  finalizationReserveCredits: number; unallocatedFinalizationCredits: number; committedCredits: number;
};

export async function readResearchRunMoney(tx: Prisma.TransactionClient | typeof prisma, runId: string): Promise<ResearchRunMoney> {
  const [run, segments] = await Promise.all([
    tx.researchPreviewRun.findUnique({ where: { id: runId }, select: { approvedCredits: true, finalizationReserveCredits: true } }),
    tx.researchFundingSegment.findMany({ where: { runId }, select: { purpose: true, status: true, reservedCredits: true, settledCredits: true, settlementUsage: true } }),
  ]);
  if (!run || run.approvedCredits === null) throw new ResearchPreviewRunError(404, "RESEARCH_RUN_NOT_FOUND", "Research run not found.");
  let settled = 0; let reserved = 0; let unknown = 0; let finalizationUsed = 0;
  for (const segment of segments) {
    const known = (segment.settlementUsage as { usageFromProvider?: unknown } | null)?.usageFromProvider !== false;
    if (segment.status === "settled") { settled += segment.settledCredits ?? 0; if (!known) unknown += segment.settledCredits ?? 0; }
    else if (segment.status === "reserving" || segment.status === "reserved") reserved += segment.reservedCredits;
    else if (segment.status === "unknown") unknown += segment.reservedCredits;
    if (segment.purpose === "finalization" && segment.status !== "released") {
      finalizationUsed += segment.status === "settled" ? segment.settledCredits ?? 0 : segment.reservedCredits;
    }
  }
  const heldUnknown = segments.filter((segment) => segment.status === "unknown").reduce((sum, segment) => sum + segment.reservedCredits, 0);
  const unallocated = Math.max(0, run.finalizationReserveCredits - finalizationUsed);
  return {
    approvedCredits: run.approvedCredits, settledCredits: settled, reservedCredits: reserved, unknownCredits: unknown,
    finalizationReserveCredits: run.finalizationReserveCredits, unallocatedFinalizationCredits: unallocated,
    committedCredits: settled + reserved + heldUnknown,
  };
}

export class ResearchFundingRoomError extends Error {
  constructor(readonly needed: number, readonly available: number) {
    super("Research run budget has no room for this step.");
    this.name = "ResearchFundingRoomError";
  }
}

/**
 * Claims room for one reservation inside the approved total, under the run row
 * lock, before the Chat reservation is requested. Work segments may not use
 * the finalization reserve; finalization segments may.
 */
export async function claimResearchFundingRoom(input: {
  runId: string; purpose: "plan" | "work" | "finalization"; credits: number;
  modelId: string; provider: string; pricingVersion: string; fence?: ResearchItemFence;
}) {
  if (!Number.isSafeInteger(input.credits) || input.credits < 0) throw new Error("RESEARCH_FUNDING_CREDITS_INVALID");
  return prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, input.runId);
    if (input.fence) await assertResearchItemFence(tx, input.fence);
    const run = await tx.researchPreviewRun.findUnique({ where: { id: input.runId }, select: { cancelRequestedAt: true, status: true } });
    if (!run || run.cancelRequestedAt) throw new ResearchPreviewRunError(409, "RESEARCH_RUN_CANCELLED", "The Research run was cancelled.");
    const money = await readResearchRunMoney(tx, input.runId);
    const kept = input.purpose === "finalization" ? 0 : money.unallocatedFinalizationCredits;
    const available = money.approvedCredits - money.committedCredits - kept;
    if (input.credits > available) throw new ResearchFundingRoomError(input.credits, Math.max(0, available));
    const max = await tx.researchFundingSegment.aggregate({ where: { runId: input.runId }, _max: { sequence: true } });
    return tx.researchFundingSegment.create({ data: {
      runId: input.runId, sequence: (max._max.sequence ?? 0) + 1, purpose: input.purpose, status: "reserving",
      reservedCredits: input.credits, modelId: input.modelId, provider: input.provider, pricingVersion: input.pricingVersion,
    } });
  });
}

export async function bindResearchFundingReservation(segmentId: string, reservationId: string, reservedCredits: number) {
  const changed = await prisma.researchFundingSegment.updateMany({
    where: { id: segmentId, status: "reserving", reservationId: null, reservedCredits: { gte: reservedCredits } },
    data: { status: "reserved", reservationId, reservedCredits },
  });
  if (changed.count !== 1) throw new ResearchPreviewRunError(409, "RESEARCH_FUNDING_BIND_CONFLICT", "The Research funding segment could not be bound.");
}

/** Nothing was reserved (refusal) or the reservation was settled at zero before any dispatch. */
export const releaseResearchFundingSegment = (segmentId: string) =>
  prisma.researchFundingSegment.updateMany({ where: { id: segmentId, status: { in: ["reserving", "reserved"] } },
    data: { status: "released", settledAt: null } });

export const markResearchFundingUnknown = (tx: Prisma.TransactionClient | typeof prisma, segmentId: string, usage: unknown) =>
  tx.researchFundingSegment.updateMany({ where: { id: segmentId, status: "reserved" },
    data: { status: "unknown", settlementUsage: json(usage) } });

export async function recordResearchFundingSettled(segmentId: string, settledCredits: number, usage: unknown) {
  await prisma.researchFundingSegment.updateMany({
    where: { id: segmentId, status: { in: ["reserved", "unknown"] } },
    data: { status: "settled", settledCredits: Math.max(0, settledCredits), settledAt: researchNow(), settlementUsage: json(usage) },
  });
}

// ---------------------------------------------------------------------------
// Sources and evidence.

export async function nextResearchSourceKey(tx: Prisma.TransactionClient, runId: string, visibility: "public" | "private") {
  const prefix = visibility === "public" ? "W" : "P";
  const rows = await tx.$queryRaw<Array<{ n: number | null }>>`
    SELECT max(substring("sourceKey" from 2)::int) AS n FROM "ResearchSource" WHERE "runId" = ${runId} AND "sourceKey" LIKE ${prefix + "%"}`;
  return `${prefix}${(rows[0]?.n ?? 0) + 1}`;
}

export type PublicSourceCandidate = {
  url: string; origin: "web_search" | "user_url" | "discovered_link";
  title?: string; snippet?: string; publishedAt?: string; publisher?: string;
};

/**
 * Registers public URLs by canonical identity. The first snippet seen is kept
 * as the source's snippet-only version; a repeated URL returns its existing key.
 */
export async function registerPublicSources(runId: string, candidates: readonly PublicSourceCandidate[]) {
  if (!candidates.length) return [] as Array<{ id: string; sourceKey: string; canonicalUrl: string; created: boolean }>;
  return prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, runId);
    const now = researchNow();
    const urls = [...new Set(candidates.map((candidate) => candidate.url))];
    const existing = await tx.researchSource.findMany({ where: { runId, canonicalUrl: { in: urls } }, select: { id: true, sourceKey: true, canonicalUrl: true } });
    const byUrl = new Map(existing.map((row) => [row.canonicalUrl!, row]));
    const out: Array<{ id: string; sourceKey: string; canonicalUrl: string; created: boolean }> = [];
    let next = Number((await nextResearchSourceKey(tx, runId, "public")).slice(1));
    for (const candidate of candidates) {
      const known = byUrl.get(candidate.url);
      if (known) { out.push({ id: known.id, sourceKey: known.sourceKey, canonicalUrl: candidate.url, created: false }); continue; }
      const publishedAt = candidate.publishedAt ? new Date(candidate.publishedAt) : null;
      const source = await tx.researchSource.create({ data: {
        runId, sourceKey: `W${next++}`, origin: candidate.origin, visibility: "public", canonicalUrl: candidate.url,
        title: candidate.title?.slice(0, 300) ?? null, publisher: candidate.publisher?.slice(0, 200) ?? null,
        snippet: candidate.snippet?.slice(0, 600) ?? null,
        publishedAt: publishedAt && Number.isFinite(publishedAt.getTime()) ? publishedAt : null, firstSeenAt: now,
      } });
      if (candidate.snippet) await tx.researchSourceVersion.create({ data: {
        sourceId: source.id, runId, version: 1, readStatus: "snippet_only", extractionMethod: "search_snippet",
        retrievedAt: now, charLength: candidate.snippet.length,
      } });
      byUrl.set(candidate.url, { id: source.id, sourceKey: source.sourceKey, canonicalUrl: candidate.url });
      out.push({ id: source.id, sourceKey: source.sourceKey, canonicalUrl: candidate.url, created: true });
    }
    return out;
  });
}

export async function recordResearchSourceVersion(input: {
  runId: string; sourceId: string;
  readStatus: "read" | "unavailable";
  extractionMethod: string; finalUrl?: string; contentType?: string;
  sourceModifiedAt?: Date | null; contentDigest?: string; byteLength?: number; charLength?: number;
  truncated?: boolean; failureReason?: string; objectKey?: string;
  chunks?: ReadonlyArray<{ chunkIndex: number; charStart: number; charEnd: number; locator: unknown; digest: string }>;
  publishedAt?: Date | null; title?: string; duplicateOfSourceId?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, input.runId);
    const max = await tx.researchSourceVersion.aggregate({ where: { sourceId: input.sourceId }, _max: { version: true } });
    const version = await tx.researchSourceVersion.create({ data: {
      sourceId: input.sourceId, runId: input.runId, version: (max._max.version ?? 0) + 1, readStatus: input.readStatus,
      extractionMethod: input.readStatus === "read" ? input.extractionMethod : "none", finalUrl: input.finalUrl ?? null,
      contentType: input.contentType ?? null, retrievedAt: researchNow(), sourceModifiedAt: input.sourceModifiedAt ?? null,
      contentDigest: input.contentDigest ?? null, byteLength: input.byteLength ?? null, charLength: input.charLength ?? null,
      truncated: input.truncated ?? false, failureReason: input.readStatus === "unavailable" ? (input.failureReason ?? "unavailable").slice(0, 80) : null,
      objectKey: input.objectKey ?? null, chunkCount: input.chunks?.length ?? 0,
    } });
    if (input.chunks?.length) {
      await tx.researchEvidenceChunk.createMany({ data: input.chunks.map((chunk) => ({
        versionId: version.id, runId: input.runId, chunkIndex: chunk.chunkIndex, locator: json(chunk.locator),
        charStart: chunk.charStart, charEnd: chunk.charEnd, digest: chunk.digest,
      })) });
    }
    if (input.title || input.publishedAt || input.duplicateOfSourceId !== undefined) {
      await tx.researchSource.update({ where: { id: input.sourceId }, data: {
        ...(input.title ? { title: input.title.slice(0, 300) } : {}),
        ...(input.publishedAt ? { publishedAt: input.publishedAt } : {}),
        ...(input.duplicateOfSourceId !== undefined ? { duplicateOfSourceId: input.duplicateOfSourceId } : {}),
      } });
    }
    return version;
  });
}

/** Latest version of each source; `read` versions take precedence over a snippet. */
export async function latestResearchVersions(runId: string, sourceIds: readonly string[]) {
  const versions = await prisma.researchSourceVersion.findMany({
    where: { runId, sourceId: { in: [...sourceIds] } }, orderBy: [{ version: "desc" }],
    include: { chunks: { orderBy: { chunkIndex: "asc" }, select: { id: true, chunkIndex: true, charStart: true, charEnd: true, locator: true } } },
  });
  const latest = new Map<string, (typeof versions)[number]>();
  for (const version of versions) {
    const current = latest.get(version.sourceId);
    if (!current || (current.readStatus !== "read" && version.readStatus === "read")) latest.set(version.sourceId, version);
  }
  return latest;
}

export async function readOwnedResearchRun(userId: string, runId: string) {
  return prisma.researchPreviewRun.findFirst({ where: { id: runId, userId, engineVersion: 2 } });
}
