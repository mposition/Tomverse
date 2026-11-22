import "server-only";

import { prisma } from "@/lib/prisma";
import { researchInputManifestSchema, researchReportDocumentSchema } from "@/lib/researchEngineContract";
import { parseResearchPreviewMetadata } from "@/lib/researchPreviewMetadata";
import { researchEvidenceStore } from "@/lib/researchEngineRuntime";
import { createHash } from "node:crypto";

/**
 * Offline comparison of Research runs that already exist: Preview (v1) and the
 * expanded engine (v2) answering the same brief. It reads stored rows and
 * evidence only; it never starts a run, calls a model or a search backend.
 * Every metric is reported separately: structure and money are counted here,
 * while whether a claim is actually supported is left to the human review
 * sheet, never to a model grading itself.
 */

export type ResearchRunMetrics = {
  runId: string; engineVersion: 1 | 2; briefDigest: string; status: string; quality: string | null;
  criteria: { met: number; total: number } | null;
  claims: Record<"supported" | "partial" | "conflicting" | "unverified" | "unsupported", number> | null;
  citedSources: number; independentCitedSources: number | null; snippetOnlyCitations: number;
  unavailableReads: number; truncatedReads: number; conflicts: number | null; limitations: number | null; reportCharacters: number;
  money: { settledCredits: number; unknownCredits: number; reservedAtPeak: number | null; settledToReservedRatio: number | null };
  work: { modelGenerations: number; searches: number; reads: number; unknownDispatches: number };
  wallTimeMs: number | null;
};

const digest = (text: string) => `sha256:${createHash("sha256").update(text.trim(), "utf8").digest("hex")}`;

export async function researchRunMetrics(runId: string): Promise<ResearchRunMetrics> {
  const run = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: runId }, include: {
    sourceUserMessage: { select: { content: true } }, message: { select: { content: true, searchMetadata: true } },
    reservation: { select: { reservedCredits: true, settledCredits: true, status: true } } } });
  const wallTimeMs = run.startedAt && run.completedAt ? run.completedAt.getTime() - run.startedAt.getTime() : null;
  if (run.engineVersion !== 2) {
    const metadata = parseResearchPreviewMetadata((run.message?.searchMetadata as Record<string, unknown> | null)?.research);
    const sources = (metadata?.sources ?? []) as Array<{ pageRead?: { status: string; truncated: boolean } }>;
    const generations = await prisma.researchPreviewGeneration.findMany({ where: { runId }, select: { status: true } });
    return {
      runId, engineVersion: 1, briefDigest: digest(run.sourceUserMessage.content), status: run.status, quality: metadata?.outcome ?? null,
      criteria: null, claims: null, citedSources: sources.length, independentCitedSources: null,
      snippetOnlyCitations: sources.filter((source) => source.pageRead?.status !== "read").length,
      unavailableReads: sources.filter((source) => source.pageRead?.status === "unavailable").length,
      truncatedReads: sources.filter((source) => source.pageRead?.truncated).length,
      // The Preview stores no structured conflicts or limitations; reported as unknown, not zero.
      conflicts: null, limitations: null,
      reportCharacters: run.message?.content.length ?? 0,
      money: { settledCredits: run.reservation?.status === "reserved" ? 0 : run.reservation?.settledCredits ?? 0, unknownCredits: 0,
        reservedAtPeak: run.reservation?.reservedCredits ?? null,
        settledToReservedRatio: run.reservation?.reservedCredits ? (run.reservation.settledCredits ?? 0) / run.reservation.reservedCredits : null },
      work: { modelGenerations: generations.filter((entry) => entry.status === "completed").length, searches: run.searchCount, reads: run.readCount,
        unknownDispatches: generations.filter((entry) => entry.status === "outcome_unknown").length },
      wallTimeMs,
    };
  }
  const manifest = researchInputManifestSchema.parse(run.inputManifest);
  const revision = run.currentReportRevision ? await prisma.researchReportRevision.findUnique({
    where: { runId_revision: { runId, revision: run.currentReportRevision } }, include: { claims: true } }) : null;
  const document = revision ? researchReportDocumentSchema.parse(revision.document) : null;
  const [segments, generations, versions, sources] = await Promise.all([
    prisma.researchFundingSegment.findMany({ where: { runId } }),
    prisma.researchPreviewGeneration.findMany({ where: { runId }, select: { kind: true, status: true } }),
    prisma.researchSourceVersion.findMany({ where: { runId }, select: { readStatus: true, truncated: true } }),
    prisma.researchSource.findMany({ where: { runId }, select: { sourceKey: true, duplicateOfSourceId: true, id: true } }),
  ]);
  const claims = { supported: 0, partial: 0, conflicting: 0, unverified: 0, unsupported: 0 };
  for (const claim of revision?.claims ?? []) claims[claim.verification as keyof typeof claims] += 1;
  const bibliography = document?.bibliography ?? [];
  const byKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const groups = new Set(bibliography.map((entry) => { const source = byKey.get(entry.sourceKey); return source?.duplicateOfSourceId ?? source?.id ?? entry.sourceKey; }));
  const settled = segments.filter((segment) => segment.status === "settled");
  const reservedTotal = segments.filter((segment) => segment.status !== "released").reduce((sum, segment) => sum + segment.reservedCredits, 0);
  const settledTotal = settled.reduce((sum, segment) => sum + (segment.settledCredits ?? 0), 0);
  return {
    runId, engineVersion: 2, briefDigest: digest(manifest.brief.question), status: run.status, quality: run.qualityStatus,
    criteria: document ? { met: document.criteria.filter((criterion) => criterion.met).length, total: document.criteria.length } : null,
    claims, citedSources: bibliography.length, independentCitedSources: groups.size,
    snippetOnlyCitations: bibliography.filter((entry) => entry.readStatus === "snippet_only").length,
    unavailableReads: versions.filter((version) => version.readStatus === "unavailable").length,
    truncatedReads: versions.filter((version) => version.readStatus === "read" && version.truncated).length,
    conflicts: document?.conflicts.length ?? 0, limitations: document?.limitations.length ?? 0,
    reportCharacters: run.message?.content.length ?? 0,
    money: { settledCredits: settledTotal,
      unknownCredits: segments.filter((segment) => segment.status === "unknown" ||
        (segment.status === "settled" && (segment.settlementUsage as { usageFromProvider?: boolean } | null)?.usageFromProvider === false))
        .reduce((sum, segment) => sum + (segment.settledCredits ?? segment.reservedCredits), 0),
      reservedAtPeak: reservedTotal, settledToReservedRatio: reservedTotal ? settledTotal / reservedTotal : null },
    work: { modelGenerations: generations.filter((entry) => entry.kind === "model" && entry.status === "completed").length,
      searches: generations.filter((entry) => entry.kind === "search" && entry.status === "completed").length,
      reads: versions.filter((version) => version.readStatus === "read").length,
      unknownDispatches: generations.filter((entry) => entry.status === "outcome_unknown").length },
    wallTimeMs,
  };
}

/** Pairs runs answering the same brief so baseline and engine are compared like for like. */
export function pairResearchRuns(metrics: readonly ResearchRunMetrics[]) {
  const byBrief = new Map<string, ResearchRunMetrics[]>();
  for (const entry of metrics) byBrief.set(entry.briefDigest, [...(byBrief.get(entry.briefDigest) ?? []), entry]);
  return [...byBrief.entries()].map(([briefDigest, runs]) => ({ briefDigest,
    baseline: runs.filter((run) => run.engineVersion === 1), engine: runs.filter((run) => run.engineVersion === 2) }));
}

/**
 * One row per claim with the exact evidence span it cites, for a person to
 * judge support. Private spans appear only in the owner's local sheet.
 */
export async function researchReviewSheet(runId: string) {
  const run = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: runId } });
  if (run.engineVersion !== 2 || !run.currentReportRevision) return [];
  const revision = await prisma.researchReportRevision.findUniqueOrThrow({ where: { runId_revision: { runId, revision: run.currentReportRevision } }, include: { claims: true } });
  const store = await researchEvidenceStore();
  const cache = new Map<string, string | null>();
  const rows: Array<Record<string, string>> = [];
  for (const claim of revision.claims) {
    const spans = claim.evidence as Array<{ sourceKey: string; versionId?: string; level: string; start: number; end: number }>;
    if (!spans.length) rows.push({ runId, claimKey: claim.claimKey, verification: claim.verification, claim: claim.text, sourceKey: "", level: "", quote: "", humanSupport: "", humanNote: "" });
    for (const span of spans) {
      let quote = "";
      if (span.versionId && span.level === "text") {
        const version = await prisma.researchSourceVersion.findUnique({ where: { id: span.versionId }, select: { objectKey: true } });
        if (version?.objectKey && !cache.has(version.objectKey)) cache.set(version.objectKey, await store.get(version.objectKey, 64 * 1024 * 1024).catch(() => null));
        quote = (version?.objectKey ? cache.get(version.objectKey) : null)?.slice(span.start, span.end) ?? "";
      }
      rows.push({ runId, claimKey: claim.claimKey, verification: claim.verification, claim: claim.text, sourceKey: span.sourceKey,
        level: span.level, quote, humanSupport: "", humanNote: "" });
    }
  }
  return rows;
}

export const researchReviewSheetCsv = (rows: ReadonlyArray<Record<string, string>>) => {
  if (!rows.length) return "";
  const headers = Object.keys(rows[0]!);
  const cell = (value: string) => (/[",\r\n]/u.test(value) || /^[=+\-@]/u.test(value) ? `"${(/^[=+\-@]/u.test(value) ? `'${value}` : value).replaceAll("\"", "\"\"")}"` : value);
  return [headers.join(","), ...rows.map((row) => headers.map((header) => cell(row[header] ?? "")).join(","))].join("\r\n");
};
