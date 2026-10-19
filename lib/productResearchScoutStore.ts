/**
 * Storage for the product-research scout's suggestions (owner direction
 * 2026-10-19, LLM-first). One table, written by the scout route and changed by
 * the operator's dismiss and send-to-AMUX actions in Admin.
 */
import "server-only";

import type { Session } from "next-auth";

import { writeAdminAuditLog } from "@/lib/adminAudit";
import { prisma } from "@/lib/prisma";
import {
  SCOUT_EXISTING_TITLES_MAX,
  type ScoutSubjectKind,
  type ScoutSuggestion,
  type SuggestionStatus,
} from "@/lib/productResearchScoutCore";

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

export const SUGGESTION_LIST_LIMIT = 100;

/** Open suggestions first by severity then newest; the rest newest first. */
export async function listSuggestions(status: SuggestionStatus): Promise<StoredSuggestion[]> {
  const rows = await prisma.productResearchSuggestion.findMany({
    where: { status },
    orderBy: { createdAt: "desc" },
    take: SUGGESTION_LIST_LIMIT,
  });
  if (status !== "open") return rows;
  const rank = { high: 0, medium: 1, low: 2 } as Record<string, number>;
  return [...rows].sort((a, b) => (rank[a.severity] ?? 3) - (rank[b.severity] ?? 3));
}

export async function readSuggestion(id: string): Promise<StoredSuggestion | null> {
  return prisma.productResearchSuggestion.findUnique({ where: { id } });
}

export const SUGGESTION_AUDIT_TARGET = "product_research_suggestion";
export const SUGGESTION_AUDIT_ACTIONS = {
  dismissed: "product_research.suggestion.dismissed",
  sent: "product_research.suggestion.sent",
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
  readonly next: { readonly status: "dismissed" } | { readonly status: "sent"; readonly amuxIdeaId: string };
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
      summary: input.next.status === "sent" ? "Scout suggestion sent to AMUX as an idea" : "Scout suggestion dismissed",
      metadata: input.next.status === "sent" ? { amuxIdeaId: input.next.amuxIdeaId } : {},
      tx,
    });
    return true;
  });
}

export type SuggestionCounts = { readonly open: number; readonly dismissed: number; readonly sent: number };

export async function suggestionCounts(): Promise<SuggestionCounts> {
  const groups = await prisma.productResearchSuggestion.groupBy({ by: ["status"], _count: { _all: true } });
  const count = (status: SuggestionStatus) => groups.find((group) => group.status === status)?._count._all ?? 0;
  return { open: count("open"), dismissed: count("dismissed"), sent: count("sent") };
}
