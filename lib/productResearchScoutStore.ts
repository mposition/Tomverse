/**
 * Storage for the product-research scout's suggestions (owner direction
 * 2026-10-19, LLM-first). One table, written by the scout route and changed by
 * the operator's dismiss and send-to-AMUX actions in Admin.
 */
import "server-only";

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

/** Moves an open suggestion on. Answers false when it was no longer open. */
export async function closeSuggestion(
  id: string,
  next: { readonly status: "dismissed" } | { readonly status: "sent"; readonly amuxIdeaId: string },
): Promise<boolean> {
  const updated = await prisma.productResearchSuggestion.updateMany({
    where: { id, status: "open" },
    data: {
      status: next.status,
      statusChangedAt: new Date(),
      amuxIdeaId: next.status === "sent" ? next.amuxIdeaId : null,
    },
  });
  return updated.count === 1;
}
