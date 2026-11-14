import { z } from "zod";

export const RESEARCH_PREVIEW_OUTCOMES = [
  "complete", "partial", "insufficient_evidence", "failed", "cancelled",
] as const;

export const RESEARCH_PREVIEW_STOP_REASONS = [
  "report_submitted", "invalid_report", "unknown_source", "missing_report",
  "budget_exhausted", "usage_unknown", "timeout", "aborted", "provider_error",
] as const;

const isoTimestamp = z.string().datetime({ offset: true });
const safeUrl = z.string().max(2048).url().refine((value) => {
  try { return ["http:", "https:"].includes(new URL(value).protocol); }
  catch { return false; }
});

const researchSourceSchema = z.object({
  sourceId: z.string().regex(/^R(?:[1-9]|1\d|2[0-5])$/),
  referenceNumber: z.number().int().min(1).max(15),
  url: safeUrl,
  title: z.string().max(200).optional(),
  excerpt: z.string().max(400).optional(),
  publishedAt: isoTimestamp.optional(),
  retrievedAt: isoTimestamp,
}).strict();

/** Public, bounded fields only. No queries, internal budget, or provider payload. */
export const researchPreviewMetadataSchema = z.object({
  version: z.literal(1),
  mode: z.literal("preview"),
  evidenceLevel: z.literal("search_snippets"),
  outcome: z.enum(RESEARCH_PREVIEW_OUTCOMES),
  startedAt: isoTimestamp,
  completedAt: isoTimestamp,
  stopReason: z.enum(RESEARCH_PREVIEW_STOP_REASONS),
  sources: z.array(researchSourceSchema).max(15).optional(),
}).strict();

export type ResearchPreviewMetadata = z.infer<typeof researchPreviewMetadataSchema>;

/** Curate persisted/untrusted JSON, including forward-compatible extra fields. */
export function parseResearchPreviewMetadata(value: unknown): ResearchPreviewMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const sources = Array.isArray(row.sources) ? row.sources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) return null;
    const entry = source as Record<string, unknown>;
    return {
      sourceId: entry.sourceId, referenceNumber: entry.referenceNumber, url: entry.url,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.excerpt !== undefined ? { excerpt: entry.excerpt } : {}),
      ...(entry.publishedAt !== undefined ? { publishedAt: entry.publishedAt } : {}),
      retrievedAt: entry.retrievedAt,
    };
  }) : undefined;
  const parsed = researchPreviewMetadataSchema.safeParse({
    version: row.version, mode: row.mode, evidenceLevel: row.evidenceLevel,
    outcome: row.outcome, startedAt: row.startedAt, completedAt: row.completedAt,
    stopReason: row.stopReason, ...(sources !== undefined ? { sources } : {}),
  });
  if (!parsed.success) return null;
  const entries = parsed.data.sources ?? [];
  if (entries.some((source, index) => source.referenceNumber !== index + 1) ||
      new Set(entries.map((source) => source.sourceId)).size !== entries.length ||
      new Set(entries.map((source) => source.url)).size !== entries.length) return null;
  return parsed.data;
}

export function buildResearchPreviewMetadata(input: {
  outcome: ResearchPreviewMetadata["outcome"];
  startedAt: string;
  completedAt: string;
  stopReason: ResearchPreviewMetadata["stopReason"];
  citedSources?: readonly {
    sourceId: string; url: string; title?: string; snippet?: string;
    publishedAt?: string; retrievedAt: string;
  }[];
}): ResearchPreviewMetadata {
  const metadata = {
    version: 1 as const, mode: "preview" as const, evidenceLevel: "search_snippets" as const,
    outcome: input.outcome, startedAt: input.startedAt, completedAt: input.completedAt,
    stopReason: input.stopReason,
    ...(input.citedSources?.length ? {
      sources: input.citedSources.map((source, index) => ({
        sourceId: source.sourceId, referenceNumber: index + 1, url: source.url,
        ...(source.title ? { title: source.title } : {}),
        ...(source.snippet ? { excerpt: source.snippet } : {}),
        ...(source.publishedAt ? { publishedAt: source.publishedAt } : {}),
        retrievedAt: source.retrievedAt,
      })),
    } : {}),
  };
  const parsed = parseResearchPreviewMetadata(metadata);
  if (!parsed) throw new Error("Invalid Research Preview metadata");
  return parsed;
}

/** The account export includes only the Research projection, never the search cost basis. */
export function researchPreviewExportFields(searchMetadata: unknown): {
  research?: ResearchPreviewMetadata;
} {
  const research = searchMetadata && typeof searchMetadata === "object"
    ? parseResearchPreviewMetadata((searchMetadata as Record<string, unknown>).research) : null;
  return research ? { research } : {};
}

/** Existing ordinary search metadata is unchanged; Research is always curated. */
export function projectResearchSearchMetadata(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value) || !("research" in value)) return value;
  const { research, ...search } = value as Record<string, unknown>;
  const parsed = parseResearchPreviewMetadata(research);
  return { ...search, ...(parsed ? { research: parsed } : {}) };
}
