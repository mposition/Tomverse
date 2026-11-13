/**
 * Storage for the product-research scout's suggestions (owner direction
 * 2026-10-19, LLM-first). One table, written by the scout route and changed by
 * the operator's dismiss, complete and send-to-AMUX actions in Admin.
 */
import "server-only";

import type { Session } from "next-auth";

import { takeAuditChainLock, writeAdminAuditLog } from "@/lib/adminAudit";
import { DAILY_PRODUCT_AGENT_PREFIX, canHandOffDailyProductTask, dailyProductAgentKey, dailyProductDisplayState, parseDailyProductState, scoutAgentId } from "@/lib/dailyProductAgentCore";
import { prisma } from "@/lib/prisma";
import {
  SCOUT_EXISTING_TITLES_MAX,
  type ScoutSubjectKind,
  type ScoutSuggestion,
  type SuggestionStatus,
} from "@/lib/productResearchScoutCore";
import {
  ISSUE_SUBJECT_PREFIX,
  ISSUE_SUGGESTION_KIND,
  issueNumberOfSubject,
  type IssueSuggestion,
} from "@/lib/productResearchScoutIssuesCore";

export type StoredSuggestion = {
  readonly id: string;
  readonly createdAt: Date;
  readonly kind: string;
  readonly subject: string;
  readonly title: string;
  readonly area: string;
  readonly severity: string;
  readonly evidence: string;
  readonly suggestion: string;
  readonly status: string;
  readonly statusChangedAt: Date | null;
  readonly amuxIdeaId: string | null;
  readonly modelId: string | null;
  readonly agentWork?: { status: "claimed" | "needs_lookup" | "pr_opened" | "failed" | "retry_ready"; prUrl?: string; reason?: string; retryable?: boolean };
};

/**
 * Titles already suggested for a subject, newest first, whatever their status:
 * a dismissed suggestion is not to come back, and a sent one is AMUX's now.
 */
export async function recentSuggestionTitles(subject: string): Promise<string[]> {
  const rows = await prisma.productResearchSuggestion.findMany({
    where: { subject },
    orderBy: { createdAt: "desc" },
    take: SCOUT_EXISTING_TITLES_MAX,
    select: { title: true },
  });
  return rows.map((row) => row.title);
}

export async function insertSuggestions(input: {
  readonly kind: ScoutSubjectKind;
  readonly subject: string;
  readonly modelId: string;
  readonly suggestions: readonly ScoutSuggestion[];
}): Promise<number> {
  if (input.suggestions.length === 0) return 0;
  const created = await prisma.productResearchSuggestion.createMany({
    data: input.suggestions.map((suggestion) => ({
      kind: input.kind,
      subject: input.subject,
      modelId: input.modelId,
      title: suggestion.title,
      area: suggestion.area,
      severity: suggestion.severity,
      evidence: suggestion.evidence,
      suggestion: suggestion.suggestion,
    })),
  });
  return created.count;
}

/**
 * Issue numbers not to ask the model about again: those with an open
 * suggestion, and those with any suggestion since `since` (a dismissed one
 * does not come back the next morning).
 */
export async function recentlySuggestedIssues(since: Date): Promise<Set<string>> {
  const rows = await prisma.productResearchSuggestion.findMany({
    where: { subject: { startsWith: ISSUE_SUBJECT_PREFIX }, OR: [{ status: "open" }, { createdAt: { gte: since } }] },
    select: { subject: true },
  });
  return new Set(rows.map((row) => issueNumberOfSubject(row.subject)).filter((id): id is string => id !== null));
}

/** One suggestion per issue, each under its own `issue.<number>` subject. */
export async function insertIssueSuggestions(input: {
  readonly modelId: string;
  readonly suggestions: readonly IssueSuggestion[];
}): Promise<number> {
  if (input.suggestions.length === 0) return 0;
  const created = await prisma.productResearchSuggestion.createMany({
    data: input.suggestions.map((suggestion) => ({
      kind: ISSUE_SUGGESTION_KIND,
      subject: suggestion.subject,
      modelId: input.modelId,
      title: suggestion.title,
      area: suggestion.area,
      severity: suggestion.severity,
      evidence: suggestion.evidence,
      suggestion: suggestion.suggestion,
    })),
  });
  return created.count;
}

/** The newest successful observation, read only (the observation store stays its only writer). */
export async function latestObservationForTriage(): Promise<{ readonly slot: Date; readonly payload: unknown } | null> {
  return prisma.productResearchObservation.findFirst({
    where: { outcome: "ok" },
    orderBy: { slot: "desc" },
    select: { slot: true, payload: true },
  });
}

export const SUGGESTION_LIST_LIMIT = 300;

/** Open suggestions first by severity, then creation; completions by decision time. */
export async function listSuggestions(status: SuggestionStatus): Promise<StoredSuggestion[]> {
  const rows = await prisma.productResearchSuggestion.findMany({
    where: { status },
    orderBy: status === "completed" ? { statusChangedAt: "desc" } : { createdAt: "desc" },
    take: SUGGESTION_LIST_LIMIT,
  });
  if (status !== "open") return rows;
  const agentRows = rows.length > 0
    ? await prisma.appSetting.findMany({ where: { key: { in: rows.flatMap((row) => [dailyProductAgentKey(scoutAgentId(row.id)), `${DAILY_PRODUCT_AGENT_PREFIX}amux.${row.id}`]) } }, select: { key: true, value: true } })
    : [];
  const work = new Map(agentRows.map((row) => [row.key, row.value]));
  const visible: StoredSuggestion[] = rows.map((row) => {
    const value = work.get(dailyProductAgentKey(scoutAgentId(row.id)));
    return value === undefined ? row : { ...row, agentWork: { ...dailyProductDisplayState(value, Date.now()),
      ...(work.has(`${DAILY_PRODUCT_AGENT_PREFIX}amux.${row.id}`) ? { retryable: false } : {}) } };
  });
  const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  return visible.sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

export async function readSuggestion(id: string): Promise<StoredSuggestion | null> {
  return prisma.productResearchSuggestion.findUnique({ where: { id } });
}

/** A human AMUX send and an autonomous claim cannot both own the suggestion. */
export async function reserveScoutSend(input: { id: string; session: Session; request: Request }): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await takeAuditChainLock(tx);
    const claimed = await tx.appSetting.findUnique({ where: { key: dailyProductAgentKey(scoutAgentId(input.id)) }, select: { value: true } });
    if (claimed && !canHandOffDailyProductTask(parseDailyProductState(claimed.value))) return false;
    const key = `${DAILY_PRODUCT_AGENT_PREFIX}amux.${input.id}`;
    const earlier = await tx.appSetting.findUnique({ where: { key }, select: { key: true } });
    if (earlier) return true;
    await tx.appSetting.create({ data: { key, value: "reserved" } });
    await writeAdminAuditLog({ tx, session: input.session, request: input.request,
      action: "product_research.suggestion.send_reserved", targetType: "product_research_suggestion", targetId: input.id,
      summary: "Scout suggestion reserved for an operator AMUX send.", metadata: {} });
    return true;
  });
}

export const SUGGESTION_AUDIT_TARGET = "product_research_suggestion";
export const SUGGESTION_AUDIT_ACTIONS = {
  dismissed: "product_research.suggestion.dismissed",
  sent: "product_research.suggestion.sent",
  completed: "product_research.suggestion.completed",
} as const;

/**
 * Moves an open suggestion on, with the operator's audit entry in the same
 * transaction. Answers false when it was no longer open (another tab got
 * there first), and then writes nothing.
 */
export async function closeSuggestion(input: {
  readonly session: Session;
  readonly request: Request;
  readonly id: string;
  readonly next: { readonly status: "dismissed" | "completed" } | { readonly status: "sent"; readonly amuxIdeaId: string };
}): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    const updated = await tx.productResearchSuggestion.updateMany({
      where: { id: input.id, status: "open" },
      data: {
        status: input.next.status,
        statusChangedAt: new Date(),
        amuxIdeaId: input.next.status === "sent" ? input.next.amuxIdeaId : null,
      },
    });
    if (updated.count !== 1) return false;
    await writeAdminAuditLog({
      session: input.session,
      request: input.request,
      action: SUGGESTION_AUDIT_ACTIONS[input.next.status],
      targetType: SUGGESTION_AUDIT_TARGET,
      targetId: input.id,
      summary: input.next.status === "sent" ? "Scout suggestion sent to AMUX as an idea"
        : input.next.status === "completed" ? "Scout suggestion completed after implementation and verification"
          : "Scout suggestion dismissed",
      metadata: input.next.status === "sent" ? { amuxIdeaId: input.next.amuxIdeaId } : {},
      tx,
    });
    return true;
  });
}

export type SuggestionCounts = { readonly open: number; readonly dismissed: number; readonly sent: number; readonly completed: number };

export async function suggestionCounts(): Promise<SuggestionCounts> {
  const groups = await prisma.productResearchSuggestion.groupBy({ by: ["status"], _count: { _all: true } });
  const count = (status: SuggestionStatus) => groups.find((group) => group.status === status)?._count._all ?? 0;
  return { open: count("open"), dismissed: count("dismissed"), sent: count("sent"), completed: count("completed") };
}
