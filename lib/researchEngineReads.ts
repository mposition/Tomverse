import "server-only";

import { prisma } from "@/lib/prisma";
import { hasConversationUnlockGrant } from "@/lib/conversationLock";
import { ResearchPreviewRunError } from "@/lib/deepResearchSettlementHandoff";
import { workbookSpecSchema, ARTIFACT_LIMITS } from "@/lib/generatedArtifactCore";
import { renderDocumentArtifact, renderSpreadsheetArtifact } from "@/lib/generatedArtifactRenderers";
import { researchInputManifestSchema, researchReportDocumentSchema } from "@/lib/researchEngineContract";
import { renderReportMarkdown, reportTablesCsv, type ReportClaim } from "@/lib/researchEngineReport";
import { reportDocumentSpec } from "@/lib/researchEngineTaskOutput";
import { researchEvidenceStore } from "@/lib/researchEngineRuntime";
import { researchEngineLabels } from "@/locales/researchEngine";

/**
 * Owner-only reads of a v2 run: paginated sources, one evidence span, a report
 * revision, and exports. Every read re-checks ownership and the conversation
 * lock; private text is returned only to the owner and never in a public
 * projection.
 */

const refuse = (status: number, code: string, message: string) => new ResearchPreviewRunError(status, code, message);

async function ownedRun(userId: string, runId: string, request?: Request) {
  const run = await prisma.researchPreviewRun.findFirst({ where: { id: runId, userId, engineVersion: 2 },
    include: { conversation: { select: { password: true, passwordVersion: true } } } });
  if (!run) throw refuse(404, "RESEARCH_RUN_NOT_FOUND", "Research run not found.");
  if (run.conversation.password != null && !(request && hasConversationUnlockGrant(request, userId, run.conversationId, run.conversation.passwordVersion))) {
    throw refuse(423, "RESEARCH_CONVERSATION_LOCKED", "Unlock this conversation before reading Research.");
  }
  return run;
}

/**
 * Private labels and copies are shown only while the original still grants them:
 * a source whose original is gone is revoked before anything about it is returned.
 * Returns the run's revoked private source keys.
 */
export async function revalidateRunPrivateSources(run: { id: string; userId: string; inputManifest: unknown }) {
  const privateSources = await prisma.researchSource.findMany({ where: { runId: run.id, visibility: "private" }, select: { id: true, sourceKey: true, status: true } });
  // Every copy that is not already revoked is checked, excluded ones included:
  // excluding a source from the scope does not stop its label being stored.
  const live = privateSources.filter((source) => source.status !== "revoked");
  const revoked = new Set(privateSources.filter((source) => source.status === "revoked").map((source) => source.sourceKey));
  if (live.length) {
    const { ensureResearchPrivateSourceGranted } = await import("@/lib/researchEngineWorker");
    for (const source of live) if (!(await ensureResearchPrivateSourceGranted(run as never, source))) revoked.add(source.sourceKey);
  }
  return revoked;
}

/** Re-checks every private source of a user's v2 runs; used before account export. */
export async function revalidateUserPrivateResearchSources(userId: string) {
  const runs = await prisma.researchPreviewRun.findMany({ where: { userId, engineVersion: 2,
    sources: { some: { visibility: "private", status: { not: "revoked" } } } }, select: { id: true, userId: true, inputManifest: true } });
  for (const run of runs) await revalidateRunPrivateSources(run);
}

export async function listResearchSources(input: { userId: string; runId: string; request?: Request; cursor?: string; limit?: number; visibility?: "public" | "private" }) {
  const run = await ownedRun(input.userId, input.runId, input.request);
  const limit = Math.min(200, Math.max(1, input.limit ?? 50));
  await revalidateRunPrivateSources(run);
  const rows = await prisma.researchSource.findMany({
    where: { runId: input.runId, ...(input.visibility ? { visibility: input.visibility } : {}) },
    orderBy: [{ firstSeenAt: "asc" }, { id: "asc" }], take: limit + 1, ...(input.cursor ? { cursor: { id: input.cursor }, skip: 1 } : {}),
    include: { versions: { orderBy: { version: "desc" }, select: { id: true, version: true, readStatus: true, extractionMethod: true,
      retrievedAt: true, truncated: true, failureReason: true, chunkCount: true, sourceModifiedAt: true, finalUrl: true } } },
  });
  const keyById = new Map((await prisma.researchSource.findMany({ where: { runId: input.runId, id: { in: rows.map((row) => row.duplicateOfSourceId).filter(Boolean) as string[] } },
    select: { id: true, sourceKey: true } })).map((row) => [row.id, row.sourceKey]));
  const page = rows.slice(0, limit);
  return {
    sources: page.map((row) => ({
      id: row.id, sourceKey: row.sourceKey, origin: row.origin, visibility: row.visibility, status: row.status,
      ...(row.visibility === "private" && row.status === "revoked" ? { title: null, snippet: null } : { title: row.title, snippet: row.snippet }),
      url: row.visibility === "public" ? row.canonicalUrl : null,
      publishedAt: row.publishedAt?.toISOString() ?? null, duplicateOf: row.duplicateOfSourceId ? keyById.get(row.duplicateOfSourceId) ?? null : null,
      versions: row.versions.map((version) => ({ ...version, retrievedAt: version.retrievedAt.toISOString(),
        sourceModifiedAt: version.sourceModifiedAt?.toISOString() ?? null })),
    })),
    nextCursor: rows.length > limit ? page.at(-1)!.id : null,
  };
}

/** One located span, returned only to the run's owner. */
export async function readResearchEvidence(input: { userId: string; runId: string; chunkId: string; request?: Request; start?: number; end?: number }) {
  const run = await ownedRun(input.userId, input.runId, input.request);
  const chunk = await prisma.researchEvidenceChunk.findFirst({ where: { id: input.chunkId, runId: input.runId },
    include: { version: { include: { source: { select: { id: true, sourceKey: true, status: true, visibility: true, title: true, canonicalUrl: true } } } } } });
  const unavailable = () => refuse(404, "RESEARCH_EVIDENCE_UNAVAILABLE", "This evidence is no longer available.");
  if (!chunk || chunk.version.source.status === "revoked" || !chunk.version.objectKey) throw unavailable();
  // A private copy is served only while the original still grants it: deleted,
  // re-locked or Memory-off material is revoked here and queued for deletion.
  if (chunk.version.source.visibility === "private") {
    const { ensureResearchPrivateSourceGranted } = await import("@/lib/researchEngineWorker");
    if (!(await ensureResearchPrivateSourceGranted(run, chunk.version.source))) throw unavailable();
  }
  const store = await researchEvidenceStore();
  const text = await store.get(chunk.version.objectKey, 64 * 1024 * 1024);
  const start = Math.max(chunk.charStart, Math.min(chunk.charEnd, input.start ?? chunk.charStart));
  const end = Math.min(chunk.charEnd, Math.max(start + 1, input.end ?? chunk.charEnd));
  return {
    sourceKey: chunk.version.source.sourceKey, visibility: chunk.version.source.visibility, title: chunk.version.source.title,
    url: chunk.version.source.visibility === "public" ? chunk.version.source.canonicalUrl : null,
    versionId: chunk.versionId, retrievedAt: chunk.version.retrievedAt.toISOString(), locator: chunk.locator,
    text: text.slice(chunk.charStart, chunk.charEnd), highlight: { start: start - chunk.charStart, end: end - chunk.charStart },
  };
}

export async function readResearchReport(input: { userId: string; runId: string; revision?: number; request?: Request }) {
  const run = await ownedRun(input.userId, input.runId, input.request);
  const revisionNumber = input.revision ?? run.currentReportRevision;
  if (!revisionNumber) throw refuse(404, "RESEARCH_REPORT_NOT_READY", "The report is not ready yet.");
  // Re-check first: a revocation here rewrites the stored report and its claims,
  // and the response must reflect it.
  const revokedKeys = await revalidateRunPrivateSources(run);
  const revision = await prisma.researchReportRevision.findUnique({ where: { runId_revision: { runId: run.id, revision: revisionNumber } }, include: { claims: true } });
  if (!revision) throw refuse(404, "RESEARCH_REPORT_NOT_FOUND", "Report revision not found.");
  const manifestForLabels = researchInputManifestSchema.parse(run.inputManifest);
  const privateLabel = researchEngineLabels(manifestForLabels.brief.outputLanguage ?? manifestForLabels.locale).report.privateSource;
  const stored = researchReportDocumentSchema.parse(revision.document);
  // A revoked private source keeps its place in the bibliography but not its copied label.
  const document = { ...stored, bibliography: stored.bibliography.map((entry) => entry.private && revokedKeys.has(entry.sourceKey)
    ? { ...entry, title: privateLabel } : entry) };
  const claims = revision.claims.map((claim) => ({ claimKey: claim.claimKey, sectionKey: claim.sectionKey, text: claim.text, kind: claim.kind,
    verification: claim.verification, privateDerived: claim.privateDerived, evidence: claim.evidence, checks: claim.checks }));
  const revisions = await prisma.researchReportRevision.findMany({ where: { runId: run.id }, orderBy: { revision: "asc" },
    select: { revision: true, parentRevision: true, author: true, qualityStatus: true, visibility: true, containsPrivate: true, createdAt: true } });
  const manifest = researchInputManifestSchema.parse(run.inputManifest);
  const labels = researchEngineLabels(manifest.brief.outputLanguage ?? manifest.locale);
  const claimMap = toClaimMap(revision.claims);
  return {
    revision: revision.revision, parentRevision: revision.parentRevision, author: revision.author, qualityStatus: revision.qualityStatus,
    visibility: revision.visibility, containsPrivate: revision.containsPrivate, document, claims,
    markdown: renderReportMarkdown(document, claimMap, revision.qualityStatus as "complete" | "partial" | "insufficient_evidence", labels.report),
    revisions: revisions.map((entry) => ({ ...entry, createdAt: entry.createdAt.toISOString() })),
  };
}

const toClaimMap = (claims: ReadonlyArray<{ claimKey: string; sectionKey: string; text: string; kind: string; verification: string; privateDerived: boolean; evidence: unknown }>) =>
  new Map<string, ReportClaim>(claims.map((claim) => [claim.claimKey, { claimKey: claim.claimKey, sectionKey: claim.sectionKey, text: claim.text,
    kind: claim.kind as ReportClaim["kind"], verification: claim.verification as ReportClaim["verification"], privateDerived: claim.privateDerived,
    evidence: claim.evidence as ReportClaim["evidence"] }]));

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max - 1)}…` : value);

export async function exportResearchReport(input: { userId: string; runId: string; revision?: number; format: "md" | "pdf" | "docx" | "csv" | "xlsx"; request?: Request }) {
  const report = await readResearchReport(input);
  const run = await ownedRun(input.userId, input.runId, input.request);
  const manifest = researchInputManifestSchema.parse(run.inputManifest);
  const labels = researchEngineLabels(manifest.brief.outputLanguage ?? manifest.locale);
  const claims = toClaimMap(report.claims as never);
  const filename = `research-${run.id.slice(0, 8)}-r${report.revision}`;
  const quality = report.qualityStatus as "complete" | "partial" | "insufficient_evidence";
  if (input.format === "md") {
    return { filename: `${filename}.md`, mediaType: "text/markdown; charset=utf-8", bytes: new TextEncoder().encode(report.markdown) };
  }
  if (input.format === "csv") {
    const tables = reportTablesCsv(report.document);
    if (!tables.length) throw refuse(404, "RESEARCH_REPORT_NO_TABLES", "This report has no tables.");
    return { filename: `${filename}.csv`, mediaType: "text/csv; charset=utf-8",
      bytes: new TextEncoder().encode(tables.map((table) => `# ${table.name}\r\n${table.csv}`).join("\r\n\r\n")) };
  }
  if (input.format === "xlsx") {
    const sheets = report.document.sections.flatMap((section) => section.blocks.filter((block) => block.type === "table").map((block, index) => ({ section, block, index })));
    if (!sheets.length) throw refuse(404, "RESEARCH_REPORT_NO_TABLES", "This report has no tables.");
    const spec = workbookSpecSchema.parse({ filename, format: "xlsx", worksheets: sheets.slice(0, ARTIFACT_LIMITS.maxWorksheets).map(({ section, block, index }) => {
      if (block.type !== "table") throw new Error("unreachable");
      return { name: clip(`${section.key}-${index + 1}`, 31), title: clip(block.caption, ARTIFACT_LIMITS.maxTitleLength),
        columns: block.columns.map((header) => ({ header: clip(header, ARTIFACT_LIMITS.maxTextLength) })), rows: block.rows };
    }) });
    const rendered = renderSpreadsheetArtifact(spec);
    return { filename: `${filename}.xlsx`, mediaType: rendered.mediaType, bytes: rendered.bytes };
  }
  const rendered = renderDocumentArtifact(reportDocumentSpec(report.document, claims, input.format, labels, quality, filename));
  return { filename: `${filename}.${input.format}`, mediaType: rendered.mediaType, bytes: rendered.bytes };
}

/**
 * What a public share may carry for a v2 report message. A report without
 * private-derived content shares as is; one with private content shares only
 * its public redaction revision, and without one the share is refused so the
 * owner is told before anything leaves.
 */
export async function researchShareContent(runId: string): Promise<{ ok: true; content: string } | { ok: false; code: "RESEARCH_SHARE_PRIVATE" } | null> {
  const run = await prisma.researchPreviewRun.findUnique({ where: { id: runId } });
  if (!run || run.engineVersion !== 2 || !run.currentReportRevision) return null;
  const current = await prisma.researchReportRevision.findUnique({ where: { runId_revision: { runId, revision: run.currentReportRevision } } });
  if (!current) return null;
  const publicRevision = current.containsPrivate
    ? await prisma.researchReportRevision.findFirst({ where: { runId, parentRevision: current.revision, visibility: "public", containsPrivate: false },
      orderBy: { revision: "desc" }, include: { claims: true } })
    : await prisma.researchReportRevision.findUnique({ where: { id: current.id }, include: { claims: true } });
  if (!publicRevision) return { ok: false, code: "RESEARCH_SHARE_PRIVATE" };
  if (publicRevision.claims.some((claim) => claim.privateDerived)) return { ok: false, code: "RESEARCH_SHARE_PRIVATE" };
  const manifest = researchInputManifestSchema.parse(run.inputManifest);
  const labels = researchEngineLabels(manifest.brief.outputLanguage ?? manifest.locale);
  const document = researchReportDocumentSchema.parse(publicRevision.document);
  return { ok: true, content: renderReportMarkdown({ ...document, bibliography: document.bibliography.filter((entry) => !entry.private) },
    toClaimMap(publicRevision.claims), publicRevision.qualityStatus as "complete" | "partial" | "insufficient_evidence", labels.report) };
}
