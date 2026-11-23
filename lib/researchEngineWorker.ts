import "server-only";

import { Prisma, type ResearchWorkItem } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  RESEARCH_PROFILES, RESEARCH_RESOURCE_LIMITS, researchCoordinatorSchema, researchInputManifestSchema,
  researchInvestigateTurnSchema, researchPlanSchema, researchPrivateAnalysisSchema, researchReportDocumentSchema,
  researchSectionDraftSchema, researchSynthesisSchema, researchVerificationSchema, researchWorkPayloadSchema,
  type ResearchFinding, type ResearchInputManifest, type ResearchPlan, type ResearchPrivateManifestEntry,
  type ResearchQualityStatus, type ResearchReportDocument, type ResearchRevisionRequest, type ResearchWorkPayload,
} from "@/lib/researchEngineContract";
import {
  chunkEvidenceText, hostMatchesDomain, locateQuote, normalizeEvidenceText, researchUrlHost,
  republicationFingerprint, sha256, unmatchedClaimNumbers,
} from "@/lib/researchEngineEvidence";
import { extractResearchDocument } from "@/lib/researchEngineDocuments";
import { fetchResearchUrl, runResearchSearch } from "@/lib/researchEngineFetch";
import { callResearchModel, recordInvalidResearchOutput, type ResearchModelCallResult } from "@/lib/researchEngineModel";
import { settleResearchSegmentIfReady } from "@/lib/researchEngineFunding";
import {
  analystPrompt, coordinatorPrompt, plannerPrompt, researcherPrompt, verifierPrompt, writerSectionPrompt,
  writerSynthesisPrompt, type PublicEvidenceBlock, type PublicResearchContext, type PublicSourceLine,
} from "@/lib/researchEnginePrompts";
import {
  buildBibliography, describeSectionProblems, redactReportForPublic, renderReportMarkdown, validateSectionDraft, withholdRevokedSource,
  type ReportClaim, type ReportSource,
} from "@/lib/researchEngineReport";
import { researchEvidenceObjectKey, researchEvidenceStore, researchNow } from "@/lib/researchEngineRuntime";
import { loadResearchPrivateText, revalidateResearchPrivateEntry } from "@/lib/researchEngineSources";
import {
  beginResearchDispatch, bumpRunSequence, claimNextResearchWorkItem, completeResearchDispatch, enqueueResearchWorkItems,
  finishResearchWorkItem, heartbeatResearchWorkItem, latestResearchVersions, lockResearchRun, markResearchDispatchStarted,
  markResearchDispatchUnknown, recordResearchSourceVersion, registerPublicSources, RESEARCH_EVIDENCE_WRITE_GRACE_MS,
  requeueResearchWorkItem, type NewResearchWorkItem, type ResearchConcurrencyLimits, type ResearchItemFence,
} from "@/lib/researchEngineStore";
import { researchEngineLabels } from "@/locales/researchEngine";

const RESEARCH_KINDS = new Set(["investigate", "search", "read", "analyze_private", "coordinate"]);
const FINAL_KINDS = new Set(["verify", "write_section", "synthesize"]);
const OPEN = new Set(["queued", "running", "blocked"]);
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;

type RunRow = Awaited<ReturnType<typeof prisma.researchPreviewRun.findUniqueOrThrow>>;
type StoredFinding = ResearchFinding & {
  questionKey: string; privateDerived: boolean;
  resolved: Array<{ sourceKey: string; versionId?: string; chunkId?: string; level: "text" | "snippet"; start: number; end: number; quoteDigest: string; quote: string }>;
  droppedQuotes: number;
};

export const parseManifest = (run: Pick<RunRow, "inputManifest">) => researchInputManifestSchema.parse(run.inputManifest);

async function approvedPlan(run: Pick<RunRow, "id" | "approvedPlanRevision" | "planRevision">, any = false): Promise<ResearchPlan | null> {
  const revision = run.approvedPlanRevision ?? (any ? run.planRevision : null);
  if (!revision) return null;
  const row = await prisma.researchPlanRevision.findUnique({ where: { runId_revision: { runId: run.id, revision } } });
  return row ? researchPlanSchema.parse(row.plan) : null;
}

export function publicContextOf(manifest: ResearchInputManifest): PublicResearchContext {
  return {
    kind: "public", publicBrief: manifest.publicBrief,
    // Objective, constraints and priority notes are free text that may be private:
    // they reach search-capable roles only through the user's publicBrief.
    brief: { deliverable: manifest.brief.deliverable, searchLanguages: manifest.brief.searchLanguages,
      regions: manifest.brief.regions, period: manifest.brief.period, freshness: manifest.brief.freshness,
      includeDomains: manifest.brief.includeDomains,
      excludeDomains: [...manifest.brief.excludeDomains, ...manifest.amendments.flatMap((amendment) => amendment.excludeDomains)] },
    privateSourceCount: manifest.entries.filter((entry) => entry.type !== "url").length,
    currentDate: manifest.currentDate, locale: manifest.brief.outputLanguage ?? manifest.locale,
    // Added questions are, by the amendment contract, public research questions (like the question itself).
    addedQuestions: manifest.amendments.flatMap((amendment) => amendment.addQuestions),
  };
}

const excludedDomains = (manifest: ResearchInputManifest) =>
  [...manifest.brief.excludeDomains, ...manifest.amendments.flatMap((amendment) => amendment.excludeDomains)];
const excludedSourceKeys = (manifest: ResearchInputManifest) => new Set(manifest.amendments.flatMap((amendment) => amendment.excludeSourceKeys));

// ---------------------------------------------------------------------------
// Worker loop

export type ResearchWorkerOptions = { limits?: ResearchConcurrencyLimits; heartbeatMs?: number; cancelPollMs?: number };

/** Claims and runs one work item, then advances its run. Returns false when nothing was runnable. */
export async function processOneResearchWorkItem(ownerId: string, options: ResearchWorkerOptions = {}) {
  const item = await claimNextResearchWorkItem(ownerId, options.limits);
  if (!item) return false;
  const fence: ResearchItemFence = { itemId: item.id, ownerId, leaseEpoch: item.leaseEpoch };
  const abort = new AbortController();
  const heartbeat = setInterval(() => {
    void heartbeatResearchWorkItem(fence).then((alive) => { if (!alive) abort.abort(new DOMException("lease lost", "AbortError")); });
  }, options.heartbeatMs ?? 30_000);
  const cancelPoll = setInterval(() => {
    void prisma.researchPreviewRun.findUnique({ where: { id: item.runId }, select: { cancelRequestedAt: true } })
      .then((run) => { if (!run || run.cancelRequestedAt) abort.abort(new DOMException("cancelled", "AbortError")); }).catch(() => undefined);
  }, options.cancelPollMs ?? 1_000);
  try {
    const run = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: item.runId } });
    await handleItem(run, item, fence, abort.signal);
  } catch (error) {
    const code = (error as { code?: string }).code ?? (error instanceof Error ? error.name : "RESEARCH_ITEM_FAILED");
    if (process.env.RESEARCH_ENGINE_DEBUG === "1") console.error("research item failed", item.kind, error);
    await prisma.$transaction(async (tx) => {
      await lockResearchRun(tx, item.runId);
      await finishResearchWorkItem(tx, fence, { status: "failed", errorCode: String(code).slice(0, 80) });
    }).catch(() => undefined);
  } finally {
    clearInterval(heartbeat);
    clearInterval(cancelPoll);
  }
  await advanceResearchRun(item.runId);
  return true;
}

/** Runs up to `concurrency` slices in parallel until nothing is runnable. Used by the worker CLI and scale tests. */
export async function drainResearchWork(ownerPrefix: string, concurrency: number, options: ResearchWorkerOptions & { maxSlices?: number } = {}) {
  let slices = 0;
  // A lane that finds nothing claimable keeps waiting while other lanes are
  // still running items that may enqueue more; it stops when no work is open.
  const lane = async (index: number) => {
    let idle = 0;
    while (options.maxSlices === undefined || slices < options.maxSlices) {
      const processed = await processOneResearchWorkItem(`${ownerPrefix}:${index}`, options);
      if (processed) { slices += 1; idle = 0; continue; }
      // Only a running item can make more work claimable. With none running, a
      // few consecutive empty claims (spanning the advance that follows an item)
      // mean nothing is runnable now: blocked, paused or waiting on time.
      const running = await prisma.researchWorkItem.count({ where: { status: "running", leaseOwner: { startsWith: `${ownerPrefix}:` } } });
      idle = running ? 0 : idle + 1;
      if (idle >= 4) return;
      await new Promise((resolve) => setTimeout(resolve, running ? 5 : 25));
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, (_, index) => lane(index)));
  return slices;
}

async function handleItem(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence, signal: AbortSignal) {
  const payload = researchWorkPayloadSchema.parse(item.payload);
  const manifest = parseManifest(run);
  switch (payload.kind) {
    case "plan": return handlePlan(run, item, fence, payload, manifest, signal);
    case "investigate": return handleInvestigate(run, item, fence, payload, manifest, signal);
    case "search": return handleSearch(run, item, fence, payload, manifest, signal);
    case "read": return handleRead(run, item, fence, payload, manifest, signal);
    case "analyze_private": return handleAnalyzePrivate(run, item, fence, payload, manifest, signal);
    case "coordinate": return handleCoordinate(run, item, fence, payload, manifest, signal);
    case "verify": return handleVerify(run, item, fence, payload, manifest, signal);
    case "write_section": return handleWriteSection(run, item, fence, payload, manifest, signal);
    case "synthesize": return handleSynthesize(run, item, fence, payload, manifest, signal);
  }
}

/** Shared handling of a model call that did not produce usable output. */
async function settleModelRefusal(item: ResearchWorkItem, fence: ResearchItemFence, result: Exclude<ResearchModelCallResult<unknown>, { ok: true }>) {
  if (result.kind === "invalid_output" && result.generationId && result.usage) {
    await recordInvalidResearchOutput(result.generationId, result.usage);
    if (result.segmentId) await settleResearchSegmentIfReady(result.segmentId);
  }
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, item.runId);
    if (result.kind === "backpressure") await requeueResearchWorkItem(tx, fence, { delayMs: result.retryAfterMs ?? 30_000, refundAttempt: true, errorCode: result.code });
    else if (result.kind === "budget") await requeueResearchWorkItem(tx, fence, { blocked: true, refundAttempt: true, errorCode: result.code });
    else if (result.kind === "invalid_output" && item.attempts < 3) await requeueResearchWorkItem(tx, fence, { errorCode: result.code });
    else if (result.kind === "unknown") await finishResearchWorkItem(tx, fence, { status: "attention", errorCode: result.code });
    else await finishResearchWorkItem(tx, fence, { status: "failed", errorCode: result.code });
  });
}

const dispatchKeyFor = (item: ResearchWorkItem) => `${item.id}:model:${item.attempts}`;

// ---------------------------------------------------------------------------
// Handlers

async function handlePlan(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence, payload: Extract<ResearchWorkPayload, { kind: "plan" }>,
  manifest: ResearchInputManifest, signal: AbortSignal) {
  const prompt = plannerPrompt(publicContextOf(manifest), payload.feedback);
  const result = await callResearchModel({ run, fence, role: "planner", purpose: "plan", dispatchKey: dispatchKeyFor(item),
    ...prompt, toolName: "submit_research_plan", toolDescription: "Submit the structured research plan.",
    schema: researchPlanSchema, outputTokenCap: 6_000, signal });
  if (!result.ok) return settleModelRefusal(item, fence, result);
  const profile = RESEARCH_PROFILES[manifest.profile];
  const plan = { ...result.value, subquestions: result.value.subquestions.slice(0, profile.maxSubquestions),
    outline: result.value.outline.slice(0, profile.maxSections) };
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, result.generationId, result.usage);
    const current = await tx.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id }, select: { planRevision: true, inputRevision: true } });
    const revision = current.planRevision + 1;
    await tx.researchPlanRevision.create({ data: { runId: run.id, revision, author: "model", inputRevision: current.inputRevision, plan: json(plan) } });
    await bumpRunSequence(tx, run.id, { planRevision: revision });
    await finishResearchWorkItem(tx, fence, { status: "completed", result: { planRevision: revision } });
  });
  await settleResearchSegmentIfReady(result.segmentId);
}

async function questionFindings(runId: string, questionKey: string) {
  const items = await prisma.researchWorkItem.findMany({ where: { runId, kind: "investigate", status: "completed",
    payload: { path: ["questionKey"], equals: questionKey } }, orderBy: { createdAt: "asc" }, select: { result: true } });
  return items.flatMap((entry) => ((entry.result as { findings?: StoredFinding[] } | null)?.findings ?? []));
}

async function loadVersionText(versionObjectKey: string | null, cache: Map<string, string>) {
  if (!versionObjectKey) return null;
  const cached = cache.get(versionObjectKey);
  if (cached !== undefined) return cached;
  const store = await researchEvidenceStore();
  const text = await store.get(versionObjectKey, RESEARCH_RESOURCE_LIMITS.maxExtractedCharacters * 4 + 1024).catch(() => null);
  if (text !== null) cache.set(versionObjectKey, text);
  return text;
}

/** Resolves model-supplied quotes to stored spans. Fabricated or unread citations are dropped here. */
async function resolveFindings(runId: string, findings: readonly ResearchFinding[], questionKey: string,
  options: { allowPrivateKeys: ReadonlySet<string>; excluded: ReadonlySet<string> }) {
  const keys = [...new Set(findings.flatMap((finding) => finding.evidence.map((evidence) => evidence.sourceKey)))];
  const sources = await prisma.researchSource.findMany({ where: { runId, sourceKey: { in: keys }, status: "active" } });
  const byKey = new Map(sources.map((source) => [source.sourceKey, source]));
  const versions = await latestResearchVersions(runId, sources.map((source) => source.id));
  const cache = new Map<string, string>();
  const resolved: StoredFinding[] = [];
  for (const finding of findings) {
    const spans: StoredFinding["resolved"] = [];
    let dropped = 0;
    for (const evidence of finding.evidence) {
      const source = byKey.get(evidence.sourceKey);
      const allowed = source && !options.excluded.has(evidence.sourceKey) &&
        (source.visibility === "public" || options.allowPrivateKeys.has(evidence.sourceKey));
      if (!allowed) { dropped += 1; continue; }
      const version = versions.get(source.id);
      if (version?.readStatus === "read") {
        const text = await loadVersionText(version.objectKey, cache);
        const match = text ? locateQuote(text, version.chunks, evidence.quote) : null;
        if (match) {
          const chunk = version.chunks.find((entry) => entry.chunkIndex === match.chunkIndex)!;
          spans.push({ sourceKey: evidence.sourceKey, versionId: version.id, chunkId: chunk.id, level: "text", start: match.start, end: match.end,
            quoteDigest: sha256(text!.slice(match.start, match.end)), quote: text!.slice(match.start, match.end) });
          continue;
        }
      }
      const snippet = source.snippet ?? "";
      const needle = normalizeEvidenceText(evidence.quote);
      if (snippet && needle.length >= 12 && normalizeEvidenceText(snippet).includes(needle)) {
        const snippetVersion = await prisma.researchSourceVersion.findFirst({ where: { sourceId: source.id, readStatus: "snippet_only" }, select: { id: true } });
        spans.push({ sourceKey: evidence.sourceKey, ...(snippetVersion ? { versionId: snippetVersion.id } : {}), level: "snippet", start: 0,
          end: Math.max(1, snippet.length), quoteDigest: sha256(snippet), quote: evidence.quote });
        continue;
      }
      dropped += 1;
    }
    resolved.push({ ...finding, questionKey, privateDerived: spans.some((span) => span.sourceKey.startsWith("P")), resolved: spans,
      droppedQuotes: dropped, kind: spans.length ? finding.kind : "uncertain" });
  }
  return resolved;
}

async function evidenceBlocks(runId: string, requests: ReadonlyArray<{ sourceKey: string; fromChunk: number }>, budgetChars: number) {
  if (!requests.length) return [] as PublicEvidenceBlock[];
  const sources = await prisma.researchSource.findMany({ where: { runId, sourceKey: { in: requests.map((request) => request.sourceKey) }, status: "active" } });
  const versions = await latestResearchVersions(runId, sources.map((source) => source.id));
  const cache = new Map<string, string>();
  const blocks: PublicEvidenceBlock[] = [];
  let used = 0;
  for (const request of requests) {
    const source = sources.find((entry) => entry.sourceKey === request.sourceKey);
    const version = source ? versions.get(source.id) : undefined;
    if (!version || version.readStatus !== "read") continue;
    const text = await loadVersionText(version.objectKey, cache);
    if (!text) continue;
    const from = Math.min(request.fromChunk, Math.max(0, version.chunks.length - 1));
    const selected = version.chunks.slice(from, from + RESEARCH_RESOURCE_LIMITS.maxChunksPerPromptRead);
    let body = "";
    let to = from;
    for (const chunk of selected) {
      const piece = text.slice(chunk.charStart, chunk.charEnd);
      if (used + body.length + piece.length > budgetChars) break;
      body += piece; to = chunk.chunkIndex;
    }
    if (!body) continue;
    used += body.length;
    const locator = selected[0]?.locator as { type?: string; page?: number; heading?: string } | undefined;
    blocks.push({ sourceKey: request.sourceKey, fromChunk: from, toChunk: to, totalChunks: version.chunks.length,
      locator: locator?.type === "page" ? `page ${locator.page}` : locator?.type === "section" ? `section "${locator.heading}"` : "text",
      text: body, truncated: version.truncated || to + 1 < version.chunks.length });
  }
  return blocks;
}

async function handleInvestigate(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "investigate" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const profile = RESEARCH_PROFILES[manifest.profile];
  const previous = await prisma.researchWorkItem.findFirst({ where: { runId: run.id, kind: "investigate", status: "completed",
    payload: { path: ["questionKey"], equals: payload.questionKey } }, orderBy: { createdAt: "desc" }, select: { result: true } });
  const previousResult = (previous?.result ?? null) as { reads?: Array<{ sourceKey: string; fromChunk: number }>; openQuestions?: string[] } | null;
  const findings = await questionFindings(run.id, payload.questionKey);
  const excluded = excludedSourceKeys(manifest);
  const searchItems = await prisma.researchWorkItem.findMany({ where: { runId: run.id, kind: "search", status: "completed",
    payload: { path: ["questionKey"], equals: payload.questionKey } }, select: { result: true } });
  const relatedKeys = new Set(searchItems.flatMap((entry) => (entry.result as { sourceKeys?: string[] } | null)?.sourceKeys ?? []));
  for (const entry of manifest.entries) if (entry.type === "url") relatedKeys.add(entry.key);
  for (const read of previousResult?.reads ?? []) relatedKeys.add(read.sourceKey);
  // Links found on pages this sub-question read are candidates for it; links from
  // other sub-questions' pages are not shown here.
  const questionItems = await prisma.researchWorkItem.findMany({ where: { runId: run.id, kind: "investigate",
    payload: { path: ["questionKey"], equals: payload.questionKey } }, select: { id: true } });
  const readItems = questionItems.length ? await prisma.researchWorkItem.findMany({ where: { runId: run.id, kind: "read", status: "completed",
    OR: questionItems.map((entry) => ({ payload: { path: ["parentItemId"], equals: entry.id } })) }, select: { result: true } }) : [];
  for (const entry of readItems) for (const key of (entry.result as { discovered?: string[] } | null)?.discovered ?? []) relatedKeys.add(key);
  const sources = await prisma.researchSource.findMany({ where: { runId: run.id, visibility: "public", status: "active",
    sourceKey: { in: [...relatedKeys] } }, orderBy: { firstSeenAt: "desc" }, take: 80 });
  const versions = await latestResearchVersions(run.id, sources.map((source) => source.id));
  const keyById = new Map(sources.map((source) => [source.id, source.sourceKey]));
  const lines: PublicSourceLine[] = sources.filter((source) => !excluded.has(source.sourceKey)).map((source) => {
    const version = versions.get(source.id);
    return { sourceKey: source.sourceKey, title: source.title, host: researchUrlHost(source.canonicalUrl ?? ""), snippet: source.snippet,
      readStatus: version?.readStatus ?? (source.origin === "discovered_link" || source.origin === "user_url" ? "link_only" : "snippet_only"),
      publishedAt: source.publishedAt?.toISOString() ?? null,
      chunkCount: version?.readStatus === "read" ? version.chunkCount : 0,
      duplicateOf: source.duplicateOfSourceId ? keyById.get(source.duplicateOfSourceId) ?? null : null };
  });
  const evidence = await evidenceBlocks(run.id, previousResult?.reads ?? [], RESEARCH_RESOURCE_LIMITS.maxPromptEvidenceCharacters);
  const prompt = researcherPrompt(publicContextOf(manifest), {
    question: payload.question, turn: payload.turn, maxTurns: profile.maxInvestigateTurnsPerQuestion, sources: lines, evidence,
    findings: findings.map((finding) => `${finding.text}${finding.resolved.length ? ` [${finding.resolved.map((span) => span.sourceKey).join(", ")}]` : " [no verified quote]"}`),
    openQuestions: previousResult?.openQuestions ?? [], remainingSearches: profile.maxSearchesPerTurn, maxReads: profile.maxReadsPerTurn,
  });
  const result = await callResearchModel({ run, fence, role: "researcher", purpose: "work", dispatchKey: dispatchKeyFor(item), ...prompt,
    toolName: "submit_research_turn", toolDescription: "Request searches/reads and record quoted findings for this sub-question.",
    schema: researchInvestigateTurnSchema, outputTokenCap: 6_000, fundsSearch: true, signal });
  if (!result.ok) return settleModelRefusal(item, fence, result);
  const turn = result.value;
  const resolved = await resolveFindings(run.id, turn.findings, payload.questionKey, { allowPrivateKeys: new Set(), excluded });
  const queries = turn.searches.slice(0, profile.maxSearchesPerTurn);
  const known = await prisma.researchSource.findMany({ where: { runId: run.id, visibility: "public", status: "active",
    sourceKey: { in: turn.reads.map((read) => read.sourceKey) } }, include: { versions: { where: { readStatus: "read" }, select: { id: true }, take: 1 } } });
  const reads = turn.reads.filter((read) => known.some((source) => source.sourceKey === read.sourceKey) && !excluded.has(read.sourceKey))
    .slice(0, profile.maxReadsPerTurn);
  const children: NewResearchWorkItem[] = [];
  const childKeys: string[] = [];
  const base = `inv:${payload.requestRevision ?? 0}:${payload.questionKey}:t${payload.turn}`;
  queries.forEach((query, index) => {
    const key = `${base}:s${index}`;
    childKeys.push(key);
    children.push({ kind: "search", idempotencyKey: key, planRevision: item.planRevision, inputRevision: item.inputRevision, priority: 2,
      payload: { kind: "search", parentItemId: item.id, query: query.query, ...(query.searchLanguage ? { searchLanguage: query.searchLanguage } : {}),
        ...(query.country ? { country: query.country } : {}), ...(query.freshness ?? manifest.brief.freshness ? { freshness: query.freshness ?? manifest.brief.freshness } : {}),
        fundingSegmentId: result.segmentId, questionKey: payload.questionKey } });
  });
  for (const read of reads) {
    const source = known.find((entry) => entry.sourceKey === read.sourceKey)!;
    if (source.versions.length) continue;
    const key = `read:${payload.requestRevision ?? 0}:${read.sourceKey}`;
    childKeys.push(key);
    children.push({ kind: "read", idempotencyKey: key, planRevision: item.planRevision, inputRevision: item.inputRevision, priority: 3,
      payload: { kind: "read", parentItemId: item.id, sourceKey: read.sourceKey, refresh: false,
        ...(payload.requestRevision ? { requestRevision: payload.requestRevision } : {}) } });
  }
  const continueTurn = !turn.done && payload.turn < profile.maxInvestigateTurnsPerQuestion && (children.length > 0 || reads.length > 0);
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, result.generationId, { ...result.usage });
    const created = await enqueueResearchWorkItems(tx, run.id, children);
    if (continueTurn) {
      const dependsOn = created.filter((entry) => childKeys.includes(entry.idempotencyKey)).map((entry) => entry.id);
      await enqueueResearchWorkItems(tx, run.id, [{ kind: "investigate", idempotencyKey: `${base.replace(/:t\d+$/u, "")}:t${payload.turn + 1}`,
        planRevision: item.planRevision, inputRevision: item.inputRevision, dependsOn, providerKey: item.providerKey, priority: 1,
        payload: { ...payload, turn: payload.turn + 1 } }]);
    }
    await finishResearchWorkItem(tx, fence, { status: "completed", result: {
      turn: payload.turn, findings: resolved, openQuestions: turn.openQuestions, done: !continueTurn,
      reads: reads.map((read) => ({ sourceKey: read.sourceKey, fromChunk: read.fromChunk })), segmentId: result.segmentId,
    } });
    await bumpRunSequence(tx, run.id);
  });
  await settleResearchSegmentIfReady(result.segmentId);
}

async function handleSearch(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "search" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const fenced = { ...fence, runId: run.id };
  // A search is paid only from a segment that reserved the search surcharge.
  const funding = await prisma.researchFundingSegment.findFirst({ where: { id: payload.fundingSegmentId, runId: run.id }, select: { searchSurchargeCredits: true } });
  if (!funding || funding.searchSurchargeCredits <= 0) {
    await prisma.$transaction(async (tx) => {
      await lockResearchRun(tx, run.id);
      await finishResearchWorkItem(tx, fence, { status: "failed", errorCode: "RESEARCH_SEARCH_NOT_FUNDED" });
    });
    return;
  }
  const begun = await beginResearchDispatch(fenced, { kind: "search", dispatchKey: `${item.id}:search`, fundingSegmentId: payload.fundingSegmentId });
  if (begun.alreadyCompleted) {
    await prisma.$transaction(async (tx) => { await lockResearchRun(tx, run.id); await finishResearchWorkItem(tx, fence, { status: "completed", result: item.result ?? {} }); });
    return;
  }
  const generationId = begun.generation.id;
  await markResearchDispatchStarted(fenced, generationId);
  const filters = { searchLanguage: payload.searchLanguage, country: payload.country, freshness: payload.freshness,
    includeDomains: manifest.brief.includeDomains, excludeDomains: excludedDomains(manifest) };
  let outcome: Awaited<ReturnType<typeof runResearchSearch>>;
  try { outcome = await runResearchSearch(payload.query, filters, signal); }
  catch (error) {
    // The request may have reached the vendor: treated as unknown (conservative for money), but logged by type.
    console.error(JSON.stringify({ event: "research_engine_search_threw", name: error instanceof Error ? error.name : "unknown", aborted: signal.aborted }));
    outcome = { ok: false, reason: "backend_timeout", dispatched: true };
  }
  if (!outcome.ok) {
    const knownNotServed = !outcome.dispatched || ["backend_rate_limited", "backend_unauthorized"].includes(outcome.reason);
    await prisma.$transaction(async (tx) => {
      await lockResearchRun(tx, run.id);
      if (knownNotServed) await completeResearchDispatch(tx, generationId, { searchRequestCount: 0 });
      else await markResearchDispatchUnknown(tx, generationId);
      await finishResearchWorkItem(tx, fence, { status: knownNotServed ? "failed" : "attention", errorCode: `RESEARCH_SEARCH_${outcome.reason}`.toUpperCase().slice(0, 80) });
    });
    await settleResearchSegmentIfReady(payload.fundingSegmentId);
    return;
  }
  const registered = await registerPublicSources(run.id, outcome.results.map((result) => ({ url: result.url, origin: "web_search" as const,
    title: result.title, snippet: result.snippet, publishedAt: result.publishedAt })));
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, generationId, { searchRequestCount: 1 });
    await tx.researchPreviewRun.update({ where: { id: run.id }, data: { searchCount: { increment: 1 } } });
    await finishResearchWorkItem(tx, fence, { status: "completed", result: { sourceKeys: registered.map((entry) => entry.sourceKey),
      resultCount: registered.length, domainFiltering: outcome.domainFiltering } });
  });
  await settleResearchSegmentIfReady(payload.fundingSegmentId);
}

async function storeExtractedVersion(run: RunRow, sourceId: string, extracted: { text: string; method: string; truncated: boolean },
  meta: { finalUrl?: string; contentType?: string; byteLength?: number; title?: string; publishedAt?: string; modifiedAt?: string }) {
  const store = await researchEvidenceStore();
  const objectKey = researchEvidenceObjectKey({ userId: run.userId, runId: run.id, sourceId });
  // The key is queued for cleanup before the object exists; recording the version
  // removes that row in the same transaction. A crash or failure in between
  // therefore always leaves the object discoverable and deleted later.
  await prisma.researchEvidenceObjectCleanup.create({ data: { objectKey, reason: "write_pending",
    nextAttemptAt: new Date(Math.max(researchNow().getTime(), Date.now()) + RESEARCH_EVIDENCE_WRITE_GRACE_MS) } });
  await store.put(objectKey, extracted.text);
  const chunks = chunkEvidenceText(extracted.text, extracted.method);
  const fingerprint = republicationFingerprint(extracted.text);
  let duplicateOf: string | null = null;
  if (fingerprint) {
    const twin = await prisma.researchSourceVersion.findFirst({ where: { runId: run.id, leadFingerprint: fingerprint, sourceId: { not: sourceId } },
      orderBy: { createdAt: "asc" }, select: { sourceId: true } });
    duplicateOf = twin?.sourceId ?? null;
  }
  const date = (value?: string) => { const parsed = value ? new Date(value) : null; return parsed && Number.isFinite(parsed.getTime()) ? parsed : null; };
  try {
    const version = await recordResearchSourceVersion({ runId: run.id, sourceId, readStatus: "read", extractionMethod: extracted.method,
      finalUrl: meta.finalUrl, contentType: meta.contentType, sourceModifiedAt: date(meta.modifiedAt), contentDigest: sha256(extracted.text),
      byteLength: meta.byteLength, charLength: extracted.text.length, truncated: extracted.truncated, objectKey, chunks,
      publishedAt: date(meta.publishedAt), title: meta.title, duplicateOfSourceId: duplicateOf });
    if (fingerprint) await prisma.researchSourceVersion.update({ where: { id: version.id }, data: { leadFingerprint: fingerprint } });
    return version;
  } catch (error) {
    // Delete now if possible; otherwise the queued row makes maintenance retry it.
    // If cleanup already fenced or removed the row, a fresh row is queued so a
    // failed delete here never leaves the object untracked.
    const removed = await store.delete(objectKey).then(() => true, () => false);
    if (removed) await prisma.researchEvidenceObjectCleanup.deleteMany({ where: { objectKey, reason: "write_pending" } }).catch(() => undefined);
    else await prisma.researchEvidenceObjectCleanup.upsert({ where: { objectKey },
      create: { objectKey, reason: "write_abandoned" }, update: { nextAttemptAt: new Date() } }).catch(() => undefined);
    throw error;
  }
}

async function handleRead(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "read" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const source = await prisma.researchSource.findUnique({ where: { runId_sourceKey: { runId: run.id, sourceKey: payload.sourceKey } } });
  const finish = (status: "completed" | "failed", result: unknown, errorCode?: string) => prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await finishResearchWorkItem(tx, fence, { status, result, errorCode });
    await bumpRunSequence(tx, run.id);
  });
  if (!source || source.visibility !== "public" || source.status !== "active" || !source.canonicalUrl) return finish("failed", {}, "RESEARCH_SOURCE_UNAVAILABLE");
  const host = researchUrlHost(source.canonicalUrl);
  if (excludedDomains(manifest).some((domain) => hostMatchesDomain(host, domain))) return finish("failed", {}, "RESEARCH_SOURCE_EXCLUDED");
  if (!payload.refresh && await prisma.researchSourceVersion.count({ where: { sourceId: source.id, readStatus: "read" } })) {
    return finish("completed", { reused: true });
  }
  const fenced = { ...fence, runId: run.id };
  const begun = await beginResearchDispatch(fenced, { kind: "read", dispatchKey: `${item.id}:read` });
  if (begun.alreadyCompleted) return finish("completed", item.result ?? {});
  await markResearchDispatchStarted(fenced, begun.generation.id);
  const fetched = await fetchResearchUrl(source.canonicalUrl, signal);
  const completeDispatch = () => prisma.$transaction(async (tx) => { await completeResearchDispatch(tx, begun.generation.id, { readCount: 1 }); });
  if (!fetched.ok) {
    await completeDispatch();
    await recordResearchSourceVersion({ runId: run.id, sourceId: source.id, readStatus: "unavailable", extractionMethod: "none", failureReason: fetched.reason });
    return finish("completed", { status: "unavailable", reason: fetched.reason });
  }
  const extracted = await extractResearchDocument(fetched.bytes, fetched.mediaType, fetched.finalUrl);
  await completeDispatch();
  if (!extracted.ok) {
    await recordResearchSourceVersion({ runId: run.id, sourceId: source.id, readStatus: "unavailable", extractionMethod: "none",
      failureReason: extracted.reason, finalUrl: fetched.finalUrl, contentType: fetched.mediaType, byteLength: fetched.bytes.byteLength });
    return finish("completed", { status: "unavailable", reason: extracted.reason });
  }
  const version = await storeExtractedVersion(run, source.id, extracted, { finalUrl: fetched.finalUrl, contentType: fetched.mediaType,
    byteLength: fetched.bytes.byteLength, title: extracted.title, publishedAt: extracted.publishedAt, modifiedAt: extracted.modifiedAt ?? fetched.lastModified });
  const links = (extracted.links ?? []).filter((link) => {
    const linkHost = researchUrlHost(link.url);
    return !excludedDomains(manifest).some((domain) => hostMatchesDomain(linkHost, domain)) &&
      (!manifest.brief.includeDomains.length || manifest.brief.includeDomains.some((domain) => hostMatchesDomain(linkHost, domain)));
  });
  const discovered = await registerPublicSources(run.id, links.map((link) => ({ url: link.url, origin: "discovered_link" as const, title: link.label })));
  await prisma.researchPreviewRun.update({ where: { id: run.id }, data: { readCount: { increment: 1 } } });
  return finish("completed", { status: "read", versionId: version.id, chunkCount: version.chunkCount, truncated: version.truncated,
    discovered: discovered.filter((entry) => entry.created).map((entry) => entry.sourceKey).slice(0, RESEARCH_RESOURCE_LIMITS.maxDiscoveredLinksPerPage) });
}

async function handleAnalyzePrivate(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "analyze_private" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const entry = manifest.entries.find((candidate) => candidate.key === payload.sourceKey && candidate.type !== "url") as ResearchPrivateManifestEntry | undefined;
  const failed = (code: string) => prisma.$transaction(async (tx) => { await lockResearchRun(tx, run.id); await finishResearchWorkItem(tx, fence, { status: "failed", errorCode: code }); });
  if (!entry || excludedSourceKeys(manifest).has(payload.sourceKey)) return failed("RESEARCH_SOURCE_UNAVAILABLE");
  let source = await prisma.researchSource.findUnique({ where: { runId_sourceKey: { runId: run.id, sourceKey: entry.key } } });
  if (!source || source.status !== "active") return failed("RESEARCH_SOURCE_REVOKED");
  let versions = await latestResearchVersions(run.id, [source.id]);
  let version = versions.get(source.id);
  if (!version || version.readStatus !== "read") {
    const loaded = await loadResearchPrivateText(run.userId, entry);
    if ("unavailable" in loaded) {
      if (loaded.unavailable === "revoked") await revokePrivateSource(run, source.id);
      return failed(loaded.unavailable === "revoked" ? "RESEARCH_SOURCE_REVOKED" : "RESEARCH_SOURCE_UNREADABLE");
    }
    await storeExtractedVersion(run, source.id, loaded, {});
    versions = await latestResearchVersions(run.id, [source.id]);
    version = versions.get(source.id)!;
    source = await prisma.researchSource.findUniqueOrThrow({ where: { id: source.id } });
  }
  const evidence = await evidenceBlocks(run.id, [{ sourceKey: entry.key, fromChunk: payload.fromChunk }], RESEARCH_RESOURCE_LIMITS.maxPromptEvidenceCharacters);
  const prompt = analystPrompt({ question: manifest.brief.question, sourceKey: entry.key, label: entry.label, evidence });
  const result = await callResearchModel({ run, fence, role: "analyst", purpose: "work", dispatchKey: dispatchKeyFor(item), ...prompt,
    toolName: "submit_research_private_analysis", toolDescription: "Record quoted findings from this private source.",
    schema: researchPrivateAnalysisSchema, outputTokenCap: 5_000, signal,
    revalidate: () => revalidateResearchPrivateEntry(run.userId, entry) });
  if (!result.ok) {
    if (result.kind === "scope_revoked") await revokePrivateSource(run, source.id);
    return settleModelRefusal(item, fence, result);
  }
  const resolved = await resolveFindings(run.id, result.value.findings, "private", { allowPrivateKeys: new Set([entry.key]), excluded: excludedSourceKeys(manifest) });
  const nextChunk = (evidence[0]?.toChunk ?? version.chunkCount) + 1;
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, result.generationId, result.usage);
    if (nextChunk < version!.chunkCount && nextChunk < 200) {
      await enqueueResearchWorkItems(tx, run.id, [{ kind: "analyze_private", idempotencyKey: `priv:${entry.key}:c${nextChunk}`,
        planRevision: item.planRevision, inputRevision: item.inputRevision, providerKey: item.providerKey,
        payload: { kind: "analyze_private", sourceKey: entry.key, fromChunk: nextChunk } }]);
    }
    await finishResearchWorkItem(tx, fence, { status: "completed", result: { findings: resolved.map((finding) => ({ ...finding, privateDerived: true })),
      limitations: result.value.limitations } });
    await bumpRunSequence(tx, run.id);
  });
  await settleResearchSegmentIfReady(result.segmentId);
}

/** A revoked private source: stop using it, drop its stored text, and withhold everything derived from it. */
export async function revokePrivateSource(run: Pick<RunRow, "id">, sourceId: string) {
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    // Labels of private sources are copied from the original (a Memory title is its
    // first words), so every stored copy goes with the grant: the source row, the
    // manifest entry, each report revision's bibliography and the chat answer.
    const source = await tx.researchSource.update({ where: { id: sourceId }, data: { status: "revoked", title: null, snippet: null } });
    const runRow = await tx.researchPreviewRun.findUniqueOrThrow({ where: { id: run.id }, select: { inputManifest: true, assistantMessageId: true, currentReportRevision: true } });
    const manifest = researchInputManifestSchema.parse(runRow.inputManifest);
    const labels = researchEngineLabels(manifest.brief.outputLanguage ?? manifest.locale);
    const placeholder = labels.report.privateSource;
    const entries = manifest.entries.map((entry) => entry.key === source.sourceKey && entry.type !== "url" ? { ...entry, label: placeholder } : entry);
    await tx.researchPreviewRun.update({ where: { id: run.id }, data: { inputManifest: json({ ...manifest, entries }) } });
    // Text derived from the source goes with it too: claim text, the report blocks,
    // conflicts and summary resting on those claims, and the stored analysis findings
    // (which hold verbatim quotes). Evidence references stay; they hold no text.
    const claims = await tx.researchClaim.findMany({ where: { runId: run.id } });
    const cites = (claim: { evidence: unknown }) => (claim.evidence as Array<{ sourceKey: string }>).some((evidence) => evidence.sourceKey === source.sourceKey);
    let currentChanged = false;
    for (const revision of await tx.researchReportRevision.findMany({ where: { runId: run.id }, select: { id: true, revision: true, document: true } })) {
      const own = claims.filter((claim) => claim.revisionId === revision.id).map((claim) => ({ claimKey: claim.claimKey, evidence: claim.evidence as ReportClaim["evidence"] }));
      const withheld = withholdRevokedSource(researchReportDocumentSchema.parse(revision.document), own, source.sourceKey,
        { note: labels.redactedNote, privateSource: placeholder });
      if (!withheld) continue;
      await tx.researchReportRevision.update({ where: { id: revision.id }, data: { document: json(withheld.document) } });
      if (revision.revision === runRow.currentReportRevision) currentChanged = true;
    }
    for (const claim of claims) {
      if (cites(claim)) {
        await tx.researchClaim.update({ where: { id: claim.id }, data: { text: labels.redactedNote, verification: "unsupported", checks: json({ revoked: source.sourceKey }) } });
      }
    }
    await tx.researchWorkItem.updateMany({ where: { runId: run.id, kind: "analyze_private", payload: { path: ["sourceKey"], equals: source.sourceKey } },
      data: { result: json({ findings: [], limitations: [], revoked: true }) } });
    const versions = await tx.researchSourceVersion.findMany({ where: { sourceId }, select: { objectKey: true } });
    for (const version of versions) if (version.objectKey) {
      await tx.researchEvidenceObjectCleanup.upsert({ where: { objectKey: version.objectKey },
        create: { objectKey: version.objectKey, reason: "source_revoked" }, update: {} });
    }
    // Version rows stay (a read version must keep its key); reads refuse a revoked
    // source and the queued cleanup deletes the stored object.
    // The chat answer is re-rendered from the cleaned current revision, so it carries
    // neither the copied label nor the old verification.
    if (currentChanged) {
      const current = await tx.researchReportRevision.findUnique({ where: { runId_revision: { runId: run.id, revision: runRow.currentReportRevision } }, include: { claims: true } });
      const message = await tx.message.findUnique({ where: { id: runRow.assistantMessageId }, select: { id: true } });
      if (current && message) {
        const claimMap = new Map<string, ReportClaim>(current.claims.map((claim) => [claim.claimKey, { claimKey: claim.claimKey, sectionKey: claim.sectionKey,
          text: claim.text, kind: claim.kind as ReportClaim["kind"], verification: claim.verification as ReportClaim["verification"],
          privateDerived: claim.privateDerived, evidence: claim.evidence as ReportClaim["evidence"] }]));
        const markdown = renderReportMarkdown(researchReportDocumentSchema.parse(current.document), claimMap,
          current.qualityStatus as "complete" | "partial" | "insufficient_evidence", labels.report);
        await tx.message.update({ where: { id: message.id }, data: { content: markdown } });
      }
    }
    await bumpRunSequence(tx, run.id);
  });
}

/**
 * Re-checks one stored private source against its original (owner, lock, deletion,
 * Memory settings) and revokes it when the grant is gone. Used by evidence reads
 * and the maintenance sweep, so copies stop being served even with no further model call.
 */
export async function ensureResearchPrivateSourceGranted(run: Pick<RunRow, "id" | "userId" | "inputManifest">, source: { id: string; sourceKey: string }) {
  const manifest = parseManifest(run);
  const entry = manifest.entries.find((candidate) => candidate.key === source.sourceKey && candidate.type !== "url") as ResearchPrivateManifestEntry | undefined;
  if (entry && await revalidateResearchPrivateEntry(run.userId, entry)) return true;
  await revokePrivateSource(run, source.id);
  return false;
}

/** After a dispatch refused for scope: revoke every private entry that no longer passes re-validation. */
async function revokeFailedPrivateEntries(run: RunRow, entries: ResearchPrivateManifestEntry[]) {
  for (const entry of entries) {
    if (await revalidateResearchPrivateEntry(run.userId, entry)) continue;
    const source = await prisma.researchSource.findFirst({ where: { runId: run.id, sourceKey: entry.key, status: { not: "revoked" } }, select: { id: true } });
    if (source) await revokePrivateSource(run, source.id);
  }
}

async function handleCoordinate(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "coordinate" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const plan = await approvedPlan(run);
  if (!plan) return prisma.$transaction(async (tx) => { await lockResearchRun(tx, run.id); await finishResearchWorkItem(tx, fence, { status: "failed", errorCode: "RESEARCH_PLAN_MISSING" }); });
  const profile = RESEARCH_PROFILES[manifest.profile];
  const investigates = await prisma.researchWorkItem.findMany({ where: { runId: run.id, kind: "investigate", status: "completed" }, select: { payload: true, result: true } });
  const byQuestion = new Map<string, { question: string; findings: string[]; open: string[] }>();
  for (const entry of investigates) {
    const value = researchWorkPayloadSchema.parse(entry.payload) as Extract<ResearchWorkPayload, { kind: "investigate" }>;
    const result = entry.result as { findings?: StoredFinding[]; openQuestions?: string[] } | null;
    const current = byQuestion.get(value.questionKey) ?? { question: value.question, findings: [], open: [] };
    current.findings.push(...(result?.findings ?? []).filter((finding) => finding.resolved.length).map((finding) => finding.text));
    current.open = result?.openQuestions ?? current.open;
    byQuestion.set(value.questionKey, current);
  }
  const distinctQuestions = byQuestion.size;
  const summaries = [...byQuestion.entries()].map(([key, value]) =>
    `${key}: ${value.question}\n  findings: ${value.findings.slice(0, 12).join(" | ") || "none"}\n  open: ${value.open.join(" | ") || "none"}`);
  const prompt = coordinatorPrompt(publicContextOf(manifest), { plan, round: payload.round, maxRounds: profile.maxCoordinatorRounds,
    questionSummaries: summaries, remainingSubquestions: Math.max(0, profile.maxSubquestions * 2 - distinctQuestions) });
  const result = await callResearchModel({ run, fence, role: "coordinator", purpose: "work", dispatchKey: dispatchKeyFor(item), ...prompt,
    toolName: "submit_research_coverage", toolDescription: "Decide whether to continue and which gaps to research.",
    schema: researchCoordinatorSchema, outputTokenCap: 3_000, signal });
  if (!result.ok) return settleModelRefusal(item, fence, result);
  const decision = result.value;
  const room = Math.max(0, profile.maxSubquestions * 2 - distinctQuestions);
  const additions = decision.decision === "continue" ? decision.newSubquestions.filter((entry) => !byQuestion.has(entry.key)).slice(0, room) : [];
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, result.generationId, result.usage);
    await enqueueResearchWorkItems(tx, run.id, additions.map((entry) => ({ kind: "investigate" as const,
      idempotencyKey: `inv:0:${entry.key}:t1`, planRevision: item.planRevision, inputRevision: item.inputRevision, providerKey: item.providerKey, priority: 1,
      payload: { kind: "investigate" as const, questionKey: entry.key, question: entry.question, queries: entry.queries, turn: 1 } })));
    await finishResearchWorkItem(tx, fence, { status: "completed", result: { decision: additions.length ? "continue" : "finish",
      coverage: decision.coverage, added: additions.map((entry) => entry.key) } });
    await bumpRunSequence(tx, run.id);
  });
  await settleResearchSegmentIfReady(result.segmentId);
}

async function claimContext(runId: string, claims: Array<{ evidence: unknown }>) {
  const spans = claims.flatMap((claim) => claim.evidence as StoredFinding["resolved"]);
  const versionIds = [...new Set(spans.map((span) => span.versionId).filter(Boolean))] as string[];
  const versions = await prisma.researchSourceVersion.findMany({ where: { runId, id: { in: versionIds }, source: { status: { not: "revoked" } } },
    select: { id: true, objectKey: true } });
  const sources = await prisma.researchSource.findMany({ where: { runId, sourceKey: { in: [...new Set(spans.map((span) => span.sourceKey))] } },
    select: { sourceKey: true, snippet: true, duplicateOfSourceId: true, id: true } });
  const cache = new Map<string, string>();
  const texts = new Map<string, string | null>();
  for (const version of versions) texts.set(version.id, await loadVersionText(version.objectKey, cache));
  return { texts, sources: new Map(sources.map((source) => [source.sourceKey, source])) };
}

async function handleVerify(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "verify" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const revision = await draftRevision(run.id);
  const claims = await prisma.researchClaim.findMany({ where: { revisionId: revision.id, claimKey: { in: payload.claimKeys } } });
  const { texts, sources } = await claimContext(run.id, claims);
  // Re-check private grants for every private source quoted to the verifier.
  const privateKeys = [...new Set(claims.flatMap((claim) => (claim.evidence as StoredFinding["resolved"]).map((span) => span.sourceKey)).filter((key) => key.startsWith("P")))];
  const entries = manifest.entries.filter((entry) => privateKeys.includes(entry.key) && entry.type !== "url") as ResearchPrivateManifestEntry[];
  const revalidate = async () => (await Promise.all(entries.map((entry) => revalidateResearchPrivateEntry(run.userId, entry)))).every(Boolean);
  const verifierClaims = claims.map((claim) => {
    const evidence = claim.evidence as StoredFinding["resolved"];
    const quotes = evidence.map((span) => {
      const text = span.versionId ? texts.get(span.versionId) : null;
      const context = span.level === "text" && text ? text.slice(Math.max(0, span.start - 300), Math.min(text.length, span.end + 300))
        : sources.get(span.sourceKey)?.snippet ?? span.quote;
      return { sourceKey: span.sourceKey, level: span.level, quote: span.quote, context };
    });
    return { claimKey: claim.claimKey, text: claim.text, kind: claim.kind, quotes, numberWarnings: unmatchedClaimNumbers(claim.text, quotes.map((quote) => quote.context)) };
  });
  const result = await callResearchModel({ run, fence, role: "verifier", purpose: "finalization", dispatchKey: dispatchKeyFor(item), ...verifierPrompt({ claims: verifierClaims }),
    toolName: "submit_research_verification", toolDescription: "Return a verdict for each claim.", schema: researchVerificationSchema,
    outputTokenCap: 6_000, signal, ...(entries.length ? { revalidate } : {}) });
  if (!result.ok) {
    if (result.kind === "scope_revoked") await revokeFailedPrivateEntries(run, entries);
    return settleModelRefusal(item, fence, result);
  }
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, result.generationId, result.usage);
    for (const claim of claims) {
      const verdict = result.value.verdicts.find((entry) => entry.claimKey === claim.claimKey);
      const evidence = claim.evidence as StoredFinding["resolved"];
      const textLevel = evidence.some((span) => span.level === "text");
      const groups = new Set(evidence.map((span) => { const source = sources.get(span.sourceKey); return source?.duplicateOfSourceId ?? source?.id ?? span.sourceKey; }));
      let verification = verdict?.verification ?? "unverified";
      // Deterministic boundary: snippet-only support is never presented as verified original text,
      // and a numeric mismatch can never stand as "supported".
      if (!textLevel && (verification === "supported" || verification === "partial")) verification = "unverified";
      if (verdict?.numericCheck === "mismatch" && verification === "supported") verification = verdict.revisedText ? "partial" : "unsupported";
      if (!evidence.length) verification = "unsupported";
      await tx.researchClaim.update({ where: { id: claim.id }, data: {
        verification, ...(verdict?.revisedText && verification !== "unsupported" ? { text: verdict.revisedText } : {}),
        checks: json({ numericCheck: verdict?.numericCheck ?? "not_applicable", independentSources: groups.size,
          textEvidence: textLevel, note: verdict?.note }) } });
    }
    await finishResearchWorkItem(tx, fence, { status: "completed", result: { verdicts: result.value.verdicts.length } });
    await bumpRunSequence(tx, run.id);
  });
  await settleResearchSegmentIfReady(result.segmentId);
}

async function draftRevision(runId: string) {
  const revision = await prisma.researchReportRevision.findFirst({ where: { runId }, orderBy: { revision: "desc" } });
  if (!revision) throw Object.assign(new Error("RESEARCH_REPORT_DRAFT_MISSING"), { code: "RESEARCH_REPORT_DRAFT_MISSING" });
  return revision;
}

async function handleWriteSection(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "write_section" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const revision = await draftRevision(run.id);
  const plan = await approvedPlan(run, true);
  const outline = plan?.outline.find((entry) => entry.key === payload.sectionKey);
  const document = researchReportDocumentSchema.parse(revision.document);
  const heading = outline?.heading ?? document.sections.find((section) => section.key === payload.sectionKey)?.heading ?? payload.sectionKey;
  const claims = await prisma.researchClaim.findMany({ where: { revisionId: revision.id, OR: [{ sectionKey: payload.sectionKey }, { sectionKey: "all" }] } });
  const citable = claims.filter((claim) => claim.verification !== "unsupported");
  const privateEntries = manifest.entries.filter((entry) => entry.type !== "url" &&
    citable.some((claim) => (claim.evidence as Array<{ sourceKey: string }>).some((evidence) => evidence.sourceKey === entry.key))) as ResearchPrivateManifestEntry[];
  const prompt = writerSectionPrompt({ heading, purpose: outline?.purpose ?? heading, question: manifest.brief.question,
    locale: manifest.brief.outputLanguage ?? manifest.locale, table: outline?.table ?? false,
    claims: citable.map((claim) => ({ claimKey: claim.claimKey, text: claim.text, verification: claim.verification, kind: claim.kind })),
    feedback: payload.feedback, instruction: payload.instruction });
  const result = await callResearchModel({ run, fence, role: "writer", purpose: "finalization", dispatchKey: dispatchKeyFor(item), ...prompt,
    toolName: "submit_research_section", toolDescription: "Submit this report section.", schema: researchSectionDraftSchema,
    outputTokenCap: 8_000, signal, ...(privateEntries.length ? { revalidate: async () =>
      (await Promise.all(privateEntries.map((entry) => revalidateResearchPrivateEntry(run.userId, entry)))).every(Boolean) } : {}) });
  if (!result.ok) {
    if (result.kind === "scope_revoked") await revokeFailedPrivateEntries(run, privateEntries);
    return settleModelRefusal(item, fence, result);
  }
  const claimMap = new Map(claims.map((claim) => [claim.claimKey, { verification: claim.verification as ReportClaim["verification"] }]));
  const problems = validateSectionDraft(result.value, claimMap, citable.length > 0);
  const profile = RESEARCH_PROFILES[manifest.profile];
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, result.generationId, result.usage);
    if (problems.length && payload.attempt <= profile.maxRepairAttempts) {
      await enqueueResearchWorkItems(tx, run.id, [{ kind: "write_section", idempotencyKey: `ws:${revision.revision}:${payload.sectionKey}:a${payload.attempt + 1}`,
        planRevision: item.planRevision, inputRevision: item.inputRevision, providerKey: item.providerKey, priority: 4,
        payload: { ...payload, attempt: payload.attempt + 1, feedback: describeSectionProblems(problems) } }]);
      // The synthesis item waits on this section's latest attempt.
      const repair = await tx.researchWorkItem.findUniqueOrThrow({ where: { runId_idempotencyKey: { runId: run.id,
        idempotencyKey: `ws:${revision.revision}:${payload.sectionKey}:a${payload.attempt + 1}` } } });
      const synth = await tx.researchWorkItem.findFirst({ where: { runId: run.id, kind: "synthesize", status: { in: ["queued", "blocked"] } } });
      if (synth) await tx.researchWorkItem.update({ where: { id: synth.id }, data: { dependsOn: [...synth.dependsOn, repair.id] } });
      await finishResearchWorkItem(tx, fence, { status: "completed", result: { accepted: false, problems: problems.length } });
      return;
    }
    await tx.$queryRaw`SELECT "id" FROM "ResearchReportRevision" WHERE "id" = ${revision.id} FOR UPDATE`;
    const current = researchReportDocumentSchema.parse((await tx.researchReportRevision.findUniqueOrThrow({ where: { id: revision.id } })).document);
    const blocks = problems.length ? [] : result.value.blocks;
    const sections = current.sections.some((section) => section.key === payload.sectionKey)
      ? current.sections.map((section) => section.key === payload.sectionKey ? { ...section, heading: result.value.heading, blocks, status: blocks.length ? "written" as const : "missing" as const } : section)
      : [...current.sections, { key: payload.sectionKey, heading: result.value.heading, blocks, status: blocks.length ? "written" as const : "missing" as const }];
    await tx.researchReportRevision.update({ where: { id: revision.id }, data: { document: json({ ...current, sections }) } });
    await finishResearchWorkItem(tx, fence, { status: "completed", result: { accepted: problems.length === 0 } });
    await bumpRunSequence(tx, run.id);
  });
  await settleResearchSegmentIfReady(result.segmentId);
}

async function handleSynthesize(run: RunRow, item: ResearchWorkItem, fence: ResearchItemFence,
  payload: Extract<ResearchWorkPayload, { kind: "synthesize" }>, manifest: ResearchInputManifest, signal: AbortSignal) {
  const revision = await prisma.researchReportRevision.findUniqueOrThrow({ where: { runId_revision: { runId: run.id, revision: payload.reportRevision } } });
  const document = researchReportDocumentSchema.parse(revision.document);
  const claims = await prisma.researchClaim.findMany({ where: { revisionId: revision.id } });
  const plan = await approvedPlan(run, true);
  const limitations = await deterministicLimitations(run.id, manifest);
  // Sections and claims may carry private-derived content: re-check every private
  // source they cite immediately before sending them to the provider.
  const citedPrivate = new Set(claims.flatMap((claim) => (claim.evidence as Array<{ sourceKey: string }>).map((evidence) => evidence.sourceKey))
    .filter((key) => key.startsWith("P")));
  const privateEntries = manifest.entries.filter((entry) => entry.type !== "url" &&
    (citedPrivate.has(entry.key) || claims.some((claim) => claim.privateDerived))) as ResearchPrivateManifestEntry[];
  const result = await callResearchModel({ run, fence, role: "writer", purpose: "finalization", dispatchKey: dispatchKeyFor(item),
    ...(privateEntries.length ? { revalidate: async () =>
      (await Promise.all(privateEntries.map((entry) => revalidateResearchPrivateEntry(run.userId, entry)))).every(Boolean) } : {}),
    ...writerSynthesisPrompt({ question: manifest.brief.question, locale: manifest.brief.outputLanguage ?? manifest.locale,
      sections: document.sections.map((section) => `## ${section.heading}\n${section.blocks.map((block) => block.type === "paragraph" ? block.text : block.caption).join("\n").slice(0, 3_000)}`),
      criteria: plan?.completionCriteria ?? [], claims: claims.filter((claim) => ["conflicting", "unverified", "partial"].includes(claim.verification))
        .slice(0, 80).map((claim) => ({ claimKey: claim.claimKey, text: claim.text, verification: claim.verification })),
      limitations, instruction: payload.instruction }),
    toolName: "submit_research_synthesis", toolDescription: "Submit the report summary and closing sections.", schema: researchSynthesisSchema,
    outputTokenCap: 6_000, signal });
  if (!result.ok) {
    if (result.kind === "scope_revoked") await revokeFailedPrivateEntries(run, privateEntries);
    if (result.kind === "budget" || result.kind === "unknown" || result.kind === "refused" || result.kind === "profile_changed" || result.kind === "scope_revoked" ||
        (result.kind === "invalid_output" && item.attempts >= 3)) {
      // Never lose the written sections: assemble a model-free partial report.
      await settleModelRefusal(item, fence, result.kind === "budget" ? { ...result, kind: "refused" } : result);
      await finalizeReport(run.id, revision.id, null, manifest);
      return;
    }
    return settleModelRefusal(item, fence, result);
  }
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, run.id);
    await completeResearchDispatch(tx, result.generationId, result.usage);
    await finishResearchWorkItem(tx, fence, { status: "completed", result: { revision: revision.revision } });
  });
  await settleResearchSegmentIfReady(result.segmentId);
  await finalizeReport(run.id, revision.id, result.value, manifest);
}

async function deterministicLimitations(runId: string, manifest: ResearchInputManifest) {
  const labels = researchEngineLabels(manifest.brief.outputLanguage ?? manifest.locale);
  const [unavailable, truncated, snippetOnlyClaims, failedItems] = await Promise.all([
    prisma.researchSourceVersion.count({ where: { runId, readStatus: "unavailable" } }),
    prisma.researchSourceVersion.count({ where: { runId, readStatus: "read", truncated: true } }),
    prisma.researchClaim.count({ where: { runId, verification: "unverified" } }),
    prisma.researchWorkItem.count({ where: { runId, status: { in: ["failed", "attention", "blocked", "superseded"] }, kind: { in: [...RESEARCH_KINDS] } } }),
  ]);
  return [
    unavailable ? labels.limitUnavailable.replace("{count}", String(unavailable)) : "",
    truncated ? labels.limitTruncated.replace("{count}", String(truncated)) : "",
    snippetOnlyClaims ? labels.limitUnverified.replace("{count}", String(snippetOnlyClaims)) : "",
    failedItems ? labels.limitIncompleteWork.replace("{count}", String(failedItems)) : "",
  ].filter(Boolean);
}

/** Decides report quality from structure, not from the model's own assessment alone. */
export function decideResearchQuality(document: ResearchReportDocument, claims: ReadonlyArray<{ verification: string }>): ResearchQualityStatus {
  const backed = claims.filter((claim) => claim.verification === "supported" || claim.verification === "partial").length;
  if (!backed) return "insufficient_evidence";
  const missing = document.sections.some((section) => section.status === "missing");
  const unmet = document.criteria.some((criterion) => !criterion.met);
  const weak = claims.length ? claims.filter((claim) => claim.verification === "unverified" || claim.verification === "unsupported").length / claims.length : 1;
  return missing || unmet || weak > 0.3 ? "partial" : "complete";
}

async function finalizeReport(runId: string, revisionId: string, synthesis: ReturnType<typeof researchSynthesisSchema.parse> | null, manifest: ResearchInputManifest) {
  const run = await prisma.researchPreviewRun.findUniqueOrThrow({ where: { id: runId } });
  const revision = await prisma.researchReportRevision.findUniqueOrThrow({ where: { id: revisionId } });
  const claims = await prisma.researchClaim.findMany({ where: { revisionId } });
  const labels = researchEngineLabels(manifest.brief.outputLanguage ?? manifest.locale);
  const base = researchReportDocumentSchema.parse(revision.document);
  const extraLimitations = await deterministicLimitations(runId, manifest);
  const document: ResearchReportDocument = {
    ...base,
    title: synthesis?.title ?? base.title,
    summary: synthesis?.summary ?? labels.partialSummary,
    scope: { ...base.scope, note: synthesis?.scopeNote ?? base.scope.note },
    conflicts: (synthesis?.conflicts ?? []).map((conflict) => ({ ...conflict, claimKeys: conflict.claimKeys.filter((key) => claims.some((claim) => claim.claimKey === key)) }))
      .filter((conflict) => conflict.claimKeys.length),
    limitations: [...new Set([...(synthesis?.limitations ?? []), ...extraLimitations, ...(synthesis ? [] : [labels.limitNoSynthesis])])].slice(0, 30),
    nextQuestions: synthesis?.nextQuestions ?? [],
    criteria: synthesis?.criteria ?? [],
    bibliography: [],
  };
  const reportClaims = new Map<string, ReportClaim>(claims.map((claim) => [claim.claimKey, {
    claimKey: claim.claimKey, sectionKey: claim.sectionKey, text: claim.text, kind: claim.kind as ReportClaim["kind"],
    verification: claim.verification as ReportClaim["verification"], privateDerived: claim.privateDerived,
    evidence: claim.evidence as ReportClaim["evidence"] }]));
  const sources = await reportSources(runId);
  document.bibliography = buildBibliography(document, reportClaims, sources);
  const quality = synthesis ? decideResearchQuality(document, claims) : claims.some((claim) => ["supported", "partial"].includes(claim.verification)) ? "partial" : "insufficient_evidence";
  const parsed = researchReportDocumentSchema.parse(document);
  const markdown = renderReportMarkdown(parsed, reportClaims, quality, labels.report);
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, runId);
    const current = await tx.researchPreviewRun.findUniqueOrThrow({ where: { id: runId } });
    if (["completed", "cancelled", "failed"].includes(current.status) && current.currentReportRevision >= revision.revision) return;
    await tx.researchReportRevision.update({ where: { id: revisionId }, data: { document: json(parsed), qualityStatus: quality,
      // Conservative: once any private source was selected, model-written prose may
      // carry it even if no private claim survived. Sharing then needs the
      // model-free public redaction.
      containsPrivate: claims.some((claim) => claim.privateDerived) || manifest.entries.some((entry) => entry.type !== "url") } });
    const metadata = json({ research: { version: 3, mode: "engine", runId, revision: revision.revision, qualityStatus: quality } });
    const existing = await tx.message.findUnique({ where: { id: run.assistantMessageId }, select: { id: true } });
    if (existing) await tx.message.update({ where: { id: run.assistantMessageId }, data: { content: markdown, searchMetadata: metadata, status: "normal" } });
    else await tx.message.create({ data: { id: run.assistantMessageId, role: "assistant", content: markdown, status: "normal",
      modelId: run.modelId, searchMetadata: metadata, conversationId: run.conversationId, researchRunId: run.id } });
    const unknown = await tx.researchPreviewGeneration.count({ where: { runId, status: "outcome_unknown" } });
    await bumpRunSequence(tx, runId, { status: "completed", qualityStatus: quality, currentReportRevision: revision.revision,
      stopReason: quality === "complete" ? "report_submitted" : "partial_report", completedAt: researchNow(),
      lastErrorCode: unknown ? "RESEARCH_SOME_OUTCOMES_UNKNOWN" : null });
    await tx.researchWorkItem.updateMany({ where: { runId, status: { in: ["queued", "blocked"] } }, data: { status: "superseded" } });
  });
}

async function reportSources(runId: string) {
  const rows = await prisma.researchSource.findMany({ where: { runId }, include: { versions: { orderBy: { version: "desc" } } } });
  const keyById = new Map(rows.map((row) => [row.id, row.sourceKey]));
  const map = new Map<string, ReportSource>();
  for (const row of rows) {
    const version = row.versions.find((entry) => entry.readStatus === "read") ?? row.versions[0];
    if (!version) continue;
    map.set(row.sourceKey, { sourceKey: row.sourceKey, versionId: version.id, title: row.title ?? row.canonicalUrl ?? row.sourceKey,
      ...(row.canonicalUrl ? { url: row.canonicalUrl } : {}), private: row.visibility === "private",
      readStatus: version.readStatus as ReportSource["readStatus"], retrievedAt: version.retrievedAt.toISOString(),
      ...(row.publishedAt ? { publishedAt: row.publishedAt.toISOString() } : {}),
      ...(row.duplicateOfSourceId && keyById.get(row.duplicateOfSourceId) ? { duplicateOf: keyById.get(row.duplicateOfSourceId)! } : {}) });
  }
  return map;
}

// ---------------------------------------------------------------------------
// Orchestration

const openRequest = (manifest: ResearchInputManifest, finalizedInputRevision: number): ResearchRevisionRequest | null =>
  manifest.revisionRequests.find((request) => request.inputRevision > finalizedInputRevision) ?? null;

/**
 * Deterministic phase advancement, serialised per run. Called after every
 * item and by maintenance; idempotent. Semantic choices (what to research,
 * whether coverage is enough) were made by the model in item results.
 */
export async function advanceResearchRun(runId: string) {
  let finalizeDraft: { id: string; manifest: ResearchInputManifest } | null = null;
  await prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, runId);
    const run = await tx.researchPreviewRun.findUnique({ where: { id: runId } });
    if (!run || run.engineVersion !== 2) return;
    const items = await tx.researchWorkItem.findMany({ where: { runId }, select: { id: true, kind: true, status: true, payload: true, result: true, inputRevision: true, idempotencyKey: true } });
    const running = items.filter((entry) => entry.status === "running").length;
    const now = researchNow();
    if (run.cancelRequestedAt) {
      await tx.researchWorkItem.updateMany({ where: { runId, status: { in: ["queued", "blocked"] } }, data: { status: "cancelled", completedAt: now } });
      if (running || ["cancelled", "attention"].includes(run.status)) return;
      const unknown = await tx.researchPreviewGeneration.count({ where: { runId, status: { in: ["dispatch_started", "outcome_unknown"] } } });
      await bumpRunSequence(tx, runId, { status: unknown ? "attention" : "cancelled", stopReason: unknown ? "outcome_unknown" : "cancelled", completedAt: now });
      return;
    }
    if (run.pauseRequestedAt) {
      if (!running && run.status !== "paused") await bumpRunSequence(tx, runId, { status: "paused", pausedAt: now });
      return;
    }
    const budgetWait = run.status === "awaiting_input" && run.lastErrorCode === "RESEARCH_RUN_BUDGET_REACHED" && Boolean(run.approvedPlanRevision);
    if (!["planning", "queued", "running", "finalizing"].includes(run.status) && !budgetWait) return;
    const manifest = researchInputManifestSchema.parse(run.inputManifest);
    if (budgetWait) {
      // Waiting for the user to add credits or finish now; the run deadline finishes it with what exists.
      if (!(run.runDeadlineAt && run.runDeadlineAt <= researchNow())) return;
      await tx.researchWorkItem.updateMany({ where: { runId, status: { in: ["blocked", "queued"] }, kind: { in: [...RESEARCH_KINDS] } }, data: { status: "superseded", errorCode: "RESEARCH_RUN_DEADLINE" } });
      const finalized = await tx.researchReportRevision.findFirst({ where: { runId, revision: run.currentReportRevision }, select: { inputRevision: true } });
      const scopedRequest = run.currentReportRevision ? openRequest(manifest, finalized?.inputRevision ?? 0) : null;
      await beginFinalization(tx, run, manifest, items.filter((entry) => scopedRequest ? entry.inputRevision >= scopedRequest.inputRevision : true), scopedRequest);
      return;
    }
    if (run.status === "planning") {
      const plan = items.filter((entry) => entry.kind === "plan").at(-1);
      if (!plan || OPEN.has(plan.status)) {
        if (plan?.status === "blocked") await bumpRunSequence(tx, runId, { status: "awaiting_input", lastErrorCode: "RESEARCH_RUN_BUDGET_REACHED" });
        return;
      }
      if (plan.status !== "completed") { await bumpRunSequence(tx, runId, { status: "awaiting_input", lastErrorCode: "RESEARCH_PLAN_FAILED" }); return; }
      const revision = await tx.researchPlanRevision.findUnique({ where: { runId_revision: { runId, revision: run.planRevision } } });
      const parsed = revision ? researchPlanSchema.safeParse(revision.plan) : null;
      const blocking = parsed?.success && parsed.data.clarifications.some((entry) => entry.blocking);
      if (manifest.autoStart && parsed?.success && !blocking) {
        await startResearchFromPlan(tx, run, manifest, parsed.data, run.planRevision);
        return;
      }
      await bumpRunSequence(tx, runId, { status: "awaiting_input", lastErrorCode: null });
      return;
    }
    const finalized = await tx.researchReportRevision.findFirst({ where: { runId, revision: run.currentReportRevision }, select: { inputRevision: true } });
    const request = run.currentReportRevision ? openRequest(manifest, finalized?.inputRevision ?? 0) : null;
    const scoped = (entry: { inputRevision: number; payload: unknown }) =>
      request ? (entry.payload as { requestRevision?: number }).requestRevision === request.inputRevision || entry.inputRevision >= request.inputRevision : true;
    const research = items.filter((entry) => RESEARCH_KINDS.has(entry.kind));
    const finalItems = items.filter((entry) => FINAL_KINDS.has(entry.kind));
    const deadline = run.runDeadlineAt && run.runDeadlineAt <= now;
    if (run.status === "queued" || run.status === "running") {
      const pending = research.filter((entry) => entry.status === "queued" || entry.status === "running");
      if (deadline && pending.some((entry) => entry.status === "queued")) {
        await tx.researchWorkItem.updateMany({ where: { runId, status: "queued", kind: { in: [...RESEARCH_KINDS] } }, data: { status: "superseded", errorCode: "RESEARCH_RUN_DEADLINE" } });
      }
      if (pending.some((entry) => entry.status === "running") || (!deadline && pending.length)) return;
      const blocked = research.some((entry) => entry.status === "blocked");
      const coordinates = research.filter((entry) => entry.kind === "coordinate");
      const last = coordinates.at(-1);
      const profile = RESEARCH_PROFILES[manifest.profile];
      const lastDecision = (last?.result as { decision?: string } | null)?.decision;
      const finishRequested = run.lastErrorCode === "RESEARCH_FINALIZE_REQUESTED";
      if (blocked && !deadline && !finishRequested) {
        // Research ran out of approved credits. The finalization reserve stays
        // untouched; the user decides: add credits, or finish with what exists.
        await bumpRunSequence(tx, runId, { status: "awaiting_input", lastErrorCode: "RESEARCH_RUN_BUDGET_REACHED" });
        return;
      }
      if (!request && !deadline && !blocked && !finishRequested && coordinates.length < profile.maxCoordinatorRounds &&
          (!last || (last.status === "completed" && lastDecision === "continue"))) {
        const round = coordinates.length + 1;
        const providerKey = providerFor(run, "coordinator");
        await enqueueResearchWorkItems(tx, runId, [{ kind: "coordinate", idempotencyKey: `coord:${round}`, planRevision: run.approvedPlanRevision ?? run.planRevision,
          inputRevision: run.inputRevision, providerKey, payload: { kind: "coordinate", round } }]);
        return;
      }
      if (blocked) await tx.researchWorkItem.updateMany({ where: { runId, status: "blocked", kind: { in: [...RESEARCH_KINDS] } }, data: { status: "superseded", errorCode: "RESEARCH_RUN_BUDGET_REACHED" } });
      await beginFinalization(tx, run, manifest, items.filter(scoped), request);
      return;
    }
    // finalizing
    const synth = finalItems.filter((entry) => entry.kind === "synthesize").at(-1);
    if (synth && !OPEN.has(synth.status)) return; // finalizeReport owns the terminal write.
    const anyRunning = finalItems.some((entry) => entry.status === "running");
    const anyBlocked = finalItems.some((entry) => entry.status === "blocked");
    if (!anyRunning && (anyBlocked || deadline)) {
      // Out of approved credits (or past the run deadline) during finalization:
      // keep what was written and assemble a partial report with no further paid call.
      await tx.researchWorkItem.updateMany({ where: { runId, status: { in: ["queued", "blocked"] }, kind: { in: [...FINAL_KINDS] } },
        data: { status: "superseded", errorCode: anyBlocked ? "RESEARCH_RUN_BUDGET_REACHED" : "RESEARCH_RUN_DEADLINE" } });
      const draft = await tx.researchReportRevision.findFirst({ where: { runId }, orderBy: { revision: "desc" } });
      if (draft) finalizeDraft = { id: draft.id, manifest };
    }
  });
  if (finalizeDraft) {
    const { id, manifest } = finalizeDraft as { id: string; manifest: ResearchInputManifest };
    await finalizeReport(runId, id, null, manifest);
  }
}

export function providerFor(run: Pick<RunRow, "executionProfile">, role: string) {
  const roles = (run.executionProfile as { roles?: Record<string, { provider?: string }> } | null)?.roles;
  return roles?.[role]?.provider ?? null;
}

/** Turns an approved plan into the first research items. */
export async function startResearchFromPlan(tx: Prisma.TransactionClient, run: RunRow, manifest: ResearchInputManifest, plan: ResearchPlan, planRevision: number) {
  const researcher = providerFor(run, "researcher");
  const analyst = providerFor(run, "analyst");
  const items: NewResearchWorkItem[] = plan.subquestions.map((question) => ({ kind: "investigate", idempotencyKey: `inv:0:${question.key}:t1`,
    planRevision, inputRevision: run.inputRevision, providerKey: researcher, priority: 1,
    payload: { kind: "investigate", questionKey: question.key, question: question.question, queries: question.queries, turn: 1 } }));
  for (const entry of manifest.entries) {
    if (entry.type === "url") items.push({ kind: "read", idempotencyKey: `read:0:${entry.key}`, planRevision, inputRevision: run.inputRevision, priority: 3,
      payload: { kind: "read", sourceKey: entry.key, refresh: false } });
    else items.push({ kind: "analyze_private", idempotencyKey: `priv:${entry.key}:c0`, planRevision, inputRevision: run.inputRevision,
      providerKey: analyst, payload: { kind: "analyze_private", sourceKey: entry.key, fromChunk: 0 } });
  }
  await enqueueResearchWorkItems(tx, run.id, items);
  // The deadline counts research time only: it starts when research starts, not while the plan waits for review.
  await bumpRunSequence(tx, run.id, { status: "queued", approvedPlanRevision: planRevision, lastErrorCode: null,
    runDeadlineAt: researchRunDeadline(manifest, researchNow()) });
}

/** The end of one research window for this run's profile, counted from now. */
export function researchRunDeadline(manifest: Pick<ResearchInputManifest, "profile">, now: Date) {
  return new Date(now.getTime() + RESEARCH_PROFILES[manifest.profile].runDeadlineMinutes * 60_000);
}

async function beginFinalization(tx: Prisma.TransactionClient, run: RunRow, manifest: ResearchInputManifest,
  items: Array<{ id: string; kind: string; status: string; payload: unknown; result: unknown; inputRevision: number }>, request: ResearchRevisionRequest | null) {
  const plan = run.approvedPlanRevision ? await tx.researchPlanRevision.findUnique({ where: { runId_revision: { runId: run.id, revision: run.approvedPlanRevision } } }) : null;
  const outline = plan ? researchPlanSchema.parse(plan.plan).outline : [{ key: "findings", heading: "Findings", purpose: "Findings", subquestionKeys: [], table: false }];
  const sectionFor = new Map<string, string>();
  for (const section of outline) for (const key of section.subquestionKeys) if (!sectionFor.has(key)) sectionFor.set(key, section.key);
  const parent = request ? await tx.researchReportRevision.findUnique({ where: { runId_revision: { runId: run.id, revision: request.parentRevision } }, include: { claims: true } }) : null;
  const latest = await tx.researchReportRevision.aggregate({ where: { runId: run.id }, _max: { revision: true } });
  const revisionNumber = (latest._max.revision ?? 0) + 1;
  const parentDocument = parent ? researchReportDocumentSchema.parse(parent.document) : null;
  const targetSections = request && request.sectionKeys.length && request.kind !== "refresh" && request.kind !== "conditions"
    ? new Set(request.sectionKeys) : new Set(outline.map((section) => section.key));
  const excluded = new Set(manifest.amendments.flatMap((amendment) => amendment.excludeSourceKeys));
  const document: ResearchReportDocument = {
    version: 1, title: parentDocument?.title ?? manifest.brief.question.slice(0, 200), summary: parentDocument?.summary ?? "-",
    scope: { question: manifest.brief.question, assumptions: plan ? researchPlanSchema.parse(plan.plan).assumptions : [], note: parentDocument?.scope.note ?? "",
      currentDate: manifest.currentDate },
    sections: outline.map((section) => {
      const kept = parentDocument?.sections.find((entry) => entry.key === section.key);
      return kept && !targetSections.has(section.key) ? kept : { key: section.key, heading: section.heading, blocks: [], status: "missing" as const };
    }),
    conflicts: [], limitations: [], nextQuestions: [], criteria: [], bibliography: [],
  };
  const created = await tx.researchReportRevision.create({ data: { runId: run.id, revision: revisionNumber, parentRevision: parent?.revision ?? null,
    planRevision: run.approvedPlanRevision ?? run.planRevision, inputRevision: run.inputRevision,
    author: request ? (request.kind === "format" ? "user_edit" : "follow_up") : "model", qualityStatus: "insufficient_evidence", document: json(document) } });
  // Claims: carried from the parent (refresh re-locates them in newer versions), plus new findings.
  type ClaimRow = { claimKey: string; sectionKey: string; text: string; kind: string; verification: string; privateDerived: boolean; evidence: unknown; checks?: unknown };
  const rows: ClaimRow[] = [];
  const needsVerify: string[] = [];
  // Parent claims keep their keys: kept sections still cite them. New findings
  // continue after the highest parent key.
  const claimNumber = (key: string) => Number(key.replace(/^C/, "")) || 0;
  const parentClaims = [...(parent?.claims ?? [])].sort((a, b) => claimNumber(a.claimKey) - claimNumber(b.claimKey));
  let next = parentClaims.reduce((max, claim) => Math.max(max, claimNumber(claim.claimKey)), 0) + 1;
  for (const claim of parentClaims) {
    rows.push({ claimKey: claim.claimKey, sectionKey: claim.sectionKey, text: claim.text, kind: claim.kind, verification: claim.verification,
      privateDerived: claim.privateDerived, evidence: claim.evidence, checks: claim.checks ?? undefined });
    if (request?.kind === "refresh" || request?.kind === "conditions") needsVerify.push(rows.at(-1)!.claimKey);
  }
  const findingItems = items.filter((entry) => (entry.kind === "investigate" || entry.kind === "analyze_private") && entry.status === "completed");
  for (const entry of findingItems) {
    const findings = ((entry.result as { findings?: StoredFinding[] } | null)?.findings ?? []);
    for (const finding of findings) {
      if (rows.length >= RESEARCH_RESOURCE_LIMITS.maxClaimsPerRevision) break;
      const evidence = finding.resolved.filter((span) => !excluded.has(span.sourceKey)).map((span) => { const { quote, ...stored } = span; void quote; return stored; });
      const sectionKey = finding.privateDerived ? "all" : sectionFor.get(finding.questionKey) ?? outline[0]!.key;
      const key = `C${next++}`;
      rows.push({ claimKey: key, sectionKey, text: finding.text, kind: evidence.length ? finding.kind : "uncertain",
        verification: evidence.length ? "unverified" : "unsupported", privateDerived: finding.privateDerived || evidence.some((span) => span.sourceKey.startsWith("P")),
        evidence, checks: { droppedQuotes: finding.droppedQuotes } });
      if (evidence.length) needsVerify.push(key);
    }
  }
  if (rows.length) await tx.researchClaim.createMany({ data: rows.map((row) => ({ revisionId: created.id, runId: run.id, claimKey: row.claimKey,
    sectionKey: row.sectionKey, text: row.text.slice(0, 2_000), kind: row.kind, verification: row.verification, privateDerived: row.privateDerived,
    evidence: json(row.evidence), ...(row.checks ? { checks: json(row.checks) } : {}) })) });
  if (request?.kind === "refresh") await relocateClaimsToLatestVersions(tx, run.id, created.id);
  const planRevision = run.approvedPlanRevision ?? run.planRevision;
  const verifyItems: NewResearchWorkItem[] = [];
  // Private and public claims are never verified together: a public claim's
  // revised text must not be written by a call that saw private material.
  const privateKeys = new Set(rows.filter((row) => row.privateDerived).map((row) => row.claimKey));
  const groups = [needsVerify.filter((key) => !privateKeys.has(key)), needsVerify.filter((key) => privateKeys.has(key))];
  let batch = 0;
  for (const group of groups) for (let index = 0; index < group.length; index += 30) {
    verifyItems.push({ kind: "verify", idempotencyKey: `verify:${revisionNumber}:${batch}`, planRevision, inputRevision: run.inputRevision,
      providerKey: providerFor(run, "verifier"), priority: 4, payload: { kind: "verify", batch, claimKeys: group.slice(index, index + 30) } });
    batch += 1;
  }
  const verifyIds = (await enqueueResearchWorkItems(tx, run.id, verifyItems)).map((entry) => entry.id);
  const writeItems: NewResearchWorkItem[] = outline.filter((section) => targetSections.has(section.key)).map((section) => ({
    kind: "write_section", idempotencyKey: `ws:${revisionNumber}:${section.key}:a1`, planRevision, inputRevision: run.inputRevision,
    providerKey: providerFor(run, "writer"), priority: 4, dependsOn: verifyIds,
    payload: { kind: "write_section", sectionKey: section.key, attempt: 1, ...(request?.instruction ? { instruction: request.instruction } : {}) } }));
  const writeIds = (await enqueueResearchWorkItems(tx, run.id, writeItems)).map((entry) => entry.id);
  await enqueueResearchWorkItems(tx, run.id, [{ kind: "synthesize", idempotencyKey: `synth:${revisionNumber}`, planRevision, inputRevision: run.inputRevision,
    providerKey: providerFor(run, "writer"), priority: 5, dependsOn: [...verifyIds, ...writeIds],
    payload: { kind: "synthesize", reportRevision: revisionNumber, author: request ? "follow_up" : "model", ...(request?.instruction ? { instruction: request.instruction } : {}) } }]);
  await bumpRunSequence(tx, run.id, { status: "finalizing" });
}

/** For "update to latest": a claim keeps its evidence only if the quote is still in the newest read version. */
async function relocateClaimsToLatestVersions(tx: Prisma.TransactionClient, runId: string, revisionId: string) {
  const claims = await tx.researchClaim.findMany({ where: { revisionId } });
  const sources = await tx.researchSource.findMany({ where: { runId }, include: { versions: { where: { readStatus: "read" }, orderBy: { version: "desc" }, take: 1,
    include: { chunks: { orderBy: { chunkIndex: "asc" } } } } } });
  const cache = new Map<string, string>();
  for (const claim of claims) {
    const evidence = claim.evidence as StoredFinding["resolved"];
    const moved: typeof evidence = [];
    for (const span of evidence) {
      const source = sources.find((entry) => entry.sourceKey === span.sourceKey);
      const latest = source?.versions[0];
      if (!latest || latest.id === span.versionId || span.level !== "text" || !span.versionId) { moved.push(span); continue; }
      const old = await tx.researchSourceVersion.findUnique({ where: { id: span.versionId }, select: { objectKey: true } });
      const oldText = await loadVersionText(old?.objectKey ?? null, cache);
      const newText = await loadVersionText(latest.objectKey, cache);
      const quote = oldText?.slice(span.start, span.end);
      const match = quote && newText ? locateQuote(newText, latest.chunks, quote) : null;
      if (match) moved.push({ ...span, versionId: latest.id, chunkId: latest.chunks.find((chunk) => chunk.chunkIndex === match.chunkIndex)!.id,
        start: match.start, end: match.end, quoteDigest: sha256(newText!.slice(match.start, match.end)) });
    }
    await tx.researchClaim.update({ where: { id: claim.id }, data: { evidence: json(moved),
      verification: moved.length ? "unverified" : "unsupported", checks: json({ ...(claim.checks as object ?? {}), refreshed: true, lostEvidence: evidence.length - moved.length }) } });
  }
}

/** Builds a public redaction revision without any model call. */
export async function createPublicRedaction(runId: string, parentRevision: number) {
  return prisma.$transaction(async (tx) => {
    await lockResearchRun(tx, runId);
    const run = await tx.researchPreviewRun.findUniqueOrThrow({ where: { id: runId } });
    const manifest = researchInputManifestSchema.parse(run.inputManifest);
    const parent = await tx.researchReportRevision.findUniqueOrThrow({ where: { runId_revision: { runId, revision: parentRevision } }, include: { claims: true } });
    const claims = new Map<string, ReportClaim>(parent.claims.map((claim) => [claim.claimKey, { claimKey: claim.claimKey, sectionKey: claim.sectionKey,
      text: claim.text, kind: claim.kind as ReportClaim["kind"], verification: claim.verification as ReportClaim["verification"],
      privateDerived: claim.privateDerived, evidence: claim.evidence as ReportClaim["evidence"] }]));
    const labels = researchEngineLabels(manifest.brief.outputLanguage ?? manifest.locale);
    const { document } = redactReportForPublic(researchReportDocumentSchema.parse(parent.document), claims, {
      title: manifest.publicBrief.slice(0, 200), summary: labels.redactedNote, removedNote: labels.redactedNote, publicQuestion: manifest.publicBrief });
    const latest = await tx.researchReportRevision.aggregate({ where: { runId }, _max: { revision: true } });
    const revision = (latest._max.revision ?? 0) + 1;
    const created = await tx.researchReportRevision.create({ data: { runId, revision, parentRevision, planRevision: parent.planRevision,
      inputRevision: parent.inputRevision, author: "redaction", qualityStatus: parent.qualityStatus, visibility: "public", containsPrivate: false,
      document: json(document) } });
    const publicClaims = parent.claims.filter((claim) => !claim.privateDerived);
    if (publicClaims.length) await tx.researchClaim.createMany({ data: publicClaims.map((claim) => ({ revisionId: created.id, runId,
      claimKey: claim.claimKey, sectionKey: claim.sectionKey, text: claim.text, kind: claim.kind, verification: claim.verification,
      privateDerived: false, evidence: json(claim.evidence), ...(claim.checks ? { checks: json(claim.checks) } : {}) })) });
    await bumpRunSequence(tx, runId);
    return created;
  });
}
