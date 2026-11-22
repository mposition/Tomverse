import "server-only";

import { createHash } from "node:crypto";
import { z } from "zod";
import { RESEARCH_EVALUATION_CASES, researchEvaluationDigest, researchEvaluationMeasuredCost, type ResearchEvaluationManifest } from "./researchPreviewEvaluation";
import { createResearchEvidenceRegistry, researchEvidenceSourceSchema, researchPreviewReportSchema, validateAndRenderResearchReport,
  type ResearchPreviewReport } from "./researchPreviewReport";
import { parseResearchPreviewMetadata } from "./researchPreviewMetadata";
import { curateResearchPageEvidence, type ResearchPageEvidence } from "./researchPreviewPageEvidence";

/**
 * Offline, read-only quality review of Research Preview runs that already happened.
 * It projects journals, stored public reports and human verdicts; it never calls a
 * model, search backend, page reader or database, and it never judges a claim itself.
 */
export const RESEARCH_REVIEW_VERSION = 1;
export const RESEARCH_REVIEW_ORIGINS = ["historical_cli", "historical_dev_ui", "current_replay", "synthetic", "preview_only"] as const;
export const RESEARCH_REVIEW_CLAIM_VERDICTS = ["supported", "partial support", "unsupported", "not checked"] as const;
export const RESEARCH_REVIEW_VERDICT_PROVENANCE = ["human", "historical_review_record", "synthetic"] as const;
export type ResearchReviewOrigin = (typeof RESEARCH_REVIEW_ORIGINS)[number];
type ClaimVerdict = (typeof RESEARCH_REVIEW_CLAIM_VERDICTS)[number];
type Outcome = ResearchPreviewReport["status"];
/** Only independent past executions are measurements; replays, synthetic rows and previews are not. */
const MEASURED_ORIGINS = new Set<ResearchReviewOrigin>(["historical_cli", "historical_dev_ui"]);

type Requirement = { id: string; text: string; check?: "machine_original_read" };
/** Pre-registered before any verdict. Changing a word changes the digest and refuses older verdicts. */
export const RESEARCH_REVIEW_CRITERIA = {
  version: "2026-11-23.1",
  keyClaimRule: "Key claims are the summary, every fact or inference statement and every contradiction. Uncertain statements and limitations are disclosures: listed for review, not counted as key claims.",
  substantiveCompletionRule: "A submitted report is substantively complete only when every case requirement is met and every key claim is rated supported by a human. Any unmet requirement or partially supported, unsupported or contradicted key claim makes it not complete; anything else unrated keeps it pending.",
  cases: {
    "official-compact-original": {
      originalRequired: true,
      requirements: [
        { id: "original_read_before_report", check: "machine_original_read", text: "An RFC Editor original (HTML or text) has status=read without being the only claimed evidence of a failed read, was read in a generation before report submission, and is cited by a page_text statement." },
        { id: "purpose_located", text: "The stated purpose is tied to the original's Status of this Memo / Overview text." },
        { id: "limitations_located", text: "The stated limitations are tied to locations in the original text." },
        { id: "publication_vs_evidence_date", text: "Publication date (1 April 1990) and the run's evidence/retrieval date are stated and kept distinct." },
        { id: "read_failures_disclosed", text: "Every failed or truncated page read is disclosed; snippet-only sources are not described as read." },
      ] as Requirement[],
      insufficientExpectation: "With snippets only, claiming the original was read fails; the honest answer marks the original-read requirement unmet and answers only what the snippets show.",
    },
    "official-runtime-support": {
      originalRequired: false,
      requirements: [
        { id: "classification_complete", text: "Each supported major line is classified as Current, Active LTS or Maintenance LTS as of the manifest's currentDate." },
        { id: "transition_dates_match", text: "Each stated transition or end-of-life date matches the dated official schedule or release announcement." },
        { id: "no_eol_as_supported", text: "No end-of-life line is described as supported." },
        { id: "announcement_vs_effective_date", text: "Announcement dates are not presented as transition effective dates (or the difference is explained)." },
        { id: "evidence_date_stated", text: "The evidence date is stated." },
      ] as Requirement[],
      insufficientExpectation: "If only LTS labels were visible, say which distinctions could not be made. If the official page has changed and the dated revision is unavailable, rate the claim not checked.",
    },
    "official-web-accessibility": {
      originalRequired: false,
      requirements: [
        { id: "criterion_number_level", text: "Each Korean claim names the WCAG 2.2 success criterion number and level that W3C assigns (e.g. 2.1.1 Keyboard A, 2.4.7 Focus Visible AA)." },
        { id: "scope_and_exceptions", text: "Scope and exceptions of each criterion match the normative text." },
        { id: "normative_vs_advisory", text: "Normative success criteria are distinguished from informative Understanding/Techniques guidance." },
        { id: "no_single_technique_as_required", text: "No single advisory technique is presented as the only required implementation." },
        { id: "unread_parts_marked", text: "Parts not read in the original are marked as needing confirmation." },
      ] as Requirement[],
      insufficientExpectation: "When only part of the original was read, separate what was read from what still needs confirmation.",
    },
  } as Record<string, { originalRequired: boolean; requirements: Requirement[]; insufficientExpectation: string }>,
};
export const researchReviewCriteriaDigest = (caseId: string) => {
  const entry = RESEARCH_REVIEW_CRITERIA.cases[caseId];
  return entry ? researchEvaluationDigest({ version: RESEARCH_REVIEW_CRITERIA.version, keyClaimRule: RESEARCH_REVIEW_CRITERIA.keyClaimRule,
    substantiveCompletionRule: RESEARCH_REVIEW_CRITERIA.substantiveCompletionRule, caseId, ...entry }) : null;
};
export const researchReviewContentDigest = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

/** Files already read by the CLI. Absent input stays absent; it is never invented. */
export type ResearchReviewRunInput = {
  origin: ResearchReviewOrigin; label?: string; runId?: string; caseId?: string; modelId?: string; runKey?: string;
  journalLines?: unknown[]; journalIssues?: string[]; manifest?: unknown; snapshots?: unknown[];
  reportInput?: unknown; allowedSources?: unknown; renderedReport?: string; storedMessage?: unknown;
  manualClaims?: unknown; fieldOverrides?: unknown; verification?: unknown; replay?: boolean;
  statementPatches?: unknown; derivedFrom?: string;
  inputStatus?: Record<string, "available" | "not_available">;
};

type PageRead = ResearchPageEvidence & { sourceId: string; url: string; contentCharacters?: number; contentDigest?: string; firstSeenAfterGeneration?: number };
type Source = {
  sourceId: string | null; displayNumber: number | null; url: string; title?: string; publishedAt?: string; retrievedAt?: string;
  snippet: "retained" | "not_retained"; pageRead: PageRead | null | "unknown"; modelSaw: string;
  readBeforeReport: boolean | "unknown"; verification?: Record<string, unknown>;
};
type Claim = {
  claimId: string; section: "summary" | "finding" | "contradiction" | "limitation"; heading?: string; text: string;
  kind?: string; evidenceLevel?: string; sourceIds: string[]; displayNumbers: number[]; key: boolean;
  sources: Source[]; claimDigest: string; evidenceDigest: string; mapping: "tool_input" | "manual";
};
type Field<T> = { value: T; source: string; note?: string };
const unknownField = <T>(value: T): Field<T> => ({ value, source: "unknown" });

const record = (value: unknown): Record<string, unknown> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const nonNegative = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : null;
const normalizeText = (text: string) => text.replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
  .replaceAll("&amp;", "&").replace(/​/g, "").replace(/\s+/g, " ").trim();
const outcomeLabels: Record<string, Outcome> = { "Complete": "complete", "Limited report": "partial", "Insufficient evidence": "insufficient_evidence",
  "완료": "complete", "제한적 보고서": "partial", "근거 부족": "insufficient_evidence" };

function modelSaw(page: PageRead | null | "unknown", snippet: boolean) {
  if (page === "unknown") return "unknown";
  if (page?.status === "read") return page.truncated ? "page_text_truncated" : "page_text";
  if (page?.status === "unavailable") return `page_read_failed:${page.reason}`;
  return snippet ? "search_snippet" : "search_snippet_not_retained";
}

function curatedPage(value: unknown): PageRead | null {
  const entry = record(value); const page = curateResearchPageEvidence(value);
  if (!entry || !page || typeof entry.sourceId !== "string" || typeof entry.url !== "string") return null;
  return { ...page, sourceId: entry.sourceId, url: entry.url,
    ...(nonNegative(entry.contentCharacters ?? entry.characters) !== null ? { contentCharacters: nonNegative(entry.contentCharacters ?? entry.characters)! } : {}),
    ...(typeof (entry.contentDigest ?? entry.digest) === "string" ? { contentDigest: String(entry.contentDigest ?? entry.digest) } : {}) };
}

type Execution = {
  status: "not_run" | "not_started" | "in_progress" | "attention" | "interrupted" | "cancelled" | "submit_failed" | "report_submitted" | "not_applicable";
  planned: boolean; dispatched: number; completedGenerations: number; outcomeUnknownGeneration: boolean;
  stopReason: Field<string | null>; rejection: string | null; terminalContent?: string; terminalOutcome: Field<Outcome | null | "unknown">;
  terminalCited: Field<Array<{ sourceId: string | null; url: string; pageRead?: ResearchPageEvidence }> | "unknown">;
  usage: Field<Record<string, number> | null>; search: { attempts: number | null; succeeded: number | null };
  pageReads: { attempts: number | null; succeeded: number | null; reads: PageRead[] | "unknown" };
  cost: { knownMicroUsd: number | null; knownSource: string; reservedMicroUsd: number | null; reservedSource: string; unknownCostPossible: boolean };
  latencyMs: number | null; finalGeneration: number | null; simulated?: boolean;
  resume?: { checkpointedObservations: number; resumedSteps: number; completedAfterResume: boolean; reloadObservations: number; reservations: number };
};
const emptyExecution = (status: Execution["status"], planned: boolean): Execution => ({ status, planned, dispatched: 0, completedGenerations: 0,
  outcomeUnknownGeneration: false, stopReason: unknownField(null), rejection: null, terminalOutcome: unknownField("unknown"),
  terminalCited: unknownField("unknown"), usage: unknownField(null), search: { attempts: null, succeeded: null },
  pageReads: { attempts: null, succeeded: null, reads: "unknown" },
  cost: { knownMicroUsd: null, knownSource: "unknown", reservedMicroUsd: null, reservedSource: "unknown", unknownCostPossible: false },
  latencyMs: null, finalGeneration: null });

type ManifestCase = ResearchEvaluationManifest["cases"][number];
/** Projects only kind/runKey/counter fields. `approval` is dropped by the CLI before this point. */
function analyzeJournal(lines: Record<string, unknown>[], manifest: ResearchEvaluationManifest | null, anomalies: string[]) {
  const cases = new Map<string, ManifestCase>((manifest?.cases ?? []).map(entry => [entry.runKey, entry]));
  const reserved = lines.some(line => line.kind === "reserved");
  const scoped = new Map<string, Record<string, unknown>[]>();
  const order: Array<{ runKey: string; at: number; kind: string }> = [];
  for (const line of lines) {
    if (!["dispatch_intent", "checkpoint", "terminal"].includes(String(line.kind))) continue;
    const entry = cases.get(String(line.runKey));
    if (!entry || line.modelId !== entry.modelId || (line.caseId !== undefined && line.caseId !== entry.id)) {
      anomalies.push(`unknown_dispatch:${String(line.kind)}:${String(line.runKey)}`); continue;
    }
    scoped.set(entry.runKey, [...(scoped.get(entry.runKey) ?? []), line]);
    order.push({ runKey: entry.runKey, at: Date.parse(String(line.at)), kind: String(line.kind) });
  }
  const attention = lines.filter(line => line.kind === "attention").map(line => Date.parse(String(line.at)));
  const completed = lines.some(line => line.kind === "evaluation_completed");
  // Attention belongs to the run with the latest scoped event at or before it, by timestamp rather than file order.
  const attentionRuns = new Set(attention.map(at => order.filter(event => event.at <= at).sort((a, b) => a.at - b.at).at(-1)?.runKey).filter(Boolean));
  const result = new Map<string, Execution>();
  for (const [runKey, entry] of cases) {
    const events = scoped.get(runKey) ?? [];
    const exec = emptyExecution(reserved ? "not_started" : "not_run", reserved);
    exec.cost.reservedMicroUsd = nonNegative(entry.reservedMicroUsd); exec.cost.reservedSource = "manifest_case_reservation";
    const dispatches = new Map<number, Record<string, unknown>>();
    const checkpoints = new Map<number, Record<string, unknown>>();
    const terminals: Record<string, unknown>[] = [];
    for (const line of events) {
      if (line.kind === "dispatch_intent") {
        const generation = nonNegative(line.generation) ?? -1;
        if (dispatches.has(generation)) anomalies.push(`duplicate_dispatch_intent:${runKey}:${generation}`); else dispatches.set(generation, line);
      } else if (line.kind === "checkpoint") {
        const steps = nonNegative(line.completedSteps) ?? -1;
        if (checkpoints.has(steps)) anomalies.push(`conflicting_checkpoint:${runKey}:${steps}`); else checkpoints.set(steps, line);
      } else terminals.push(line);
    }
    if (terminals.length > 1) anomalies.push(`duplicate_terminal:${runKey}`);
    exec.dispatched = dispatches.size; exec.completedGenerations = checkpoints.size;
    const lastSteps = Math.max(0, ...checkpoints.keys());
    const last = checkpoints.get(lastSteps);
    const terminal = terminals[0];
    exec.finalGeneration = dispatches.size ? Math.max(...dispatches.keys()) : null;
    exec.outcomeUnknownGeneration = (exec.finalGeneration ?? 0) > lastSteps;
    if (last) {
      const usage = record(last.usage);
      if (usage && ["inputTokens", "outputTokens", "cachedInputTokens", "cacheWriteTokens"].every(key => nonNegative(usage[key]) !== null)) {
        exec.usage = { value: usage as Record<string, number>, source: "journal_last_checkpoint_cumulative" };
      }
      exec.search.attempts = nonNegative(last.searchCount);
      // A checkpoint is only followed by another dispatch or a terminal after the CLI verified every search succeeded.
      if (terminal || dispatches.has(lastSteps + 1)) exec.search.succeeded = exec.search.attempts;
      exec.pageReads.attempts = nonNegative(last.pageReadCount);
      if (Array.isArray(last.pageReads)) {
        const reads: PageRead[] = [];
        for (const [steps, checkpoint] of [...checkpoints].sort(([a], [b]) => a - b)) {
          for (const raw of Array.isArray(checkpoint.pageReads) ? checkpoint.pageReads : []) {
            const page = curatedPage(raw);
            if (page && !reads.some(read => read.sourceId === page.sourceId)) reads.push({ ...page, firstSeenAfterGeneration: steps });
          }
        }
        exec.pageReads.reads = reads; exec.pageReads.succeeded = reads.filter(read => read.status === "read").length;
      }
    }
    if (terminal) {
      exec.status = terminal.stopReason === "report_submitted" ? "report_submitted" : "submit_failed";
      exec.stopReason = { value: String(terminal.stopReason), source: "journal_terminal" };
      exec.rejection = record(terminal.reportRejection)?.code ? String(record(terminal.reportRejection)!.code) : null;
      if (typeof terminal.content === "string") exec.terminalContent = terminal.content;
      if ("outcome" in terminal) exec.terminalOutcome = { value: terminal.outcome as Outcome | null, source: "journal_terminal" };
      if (Array.isArray(terminal.citedSources)) exec.terminalCited = { value: terminal.citedSources.flatMap(raw => {
        const entry = record(raw); if (!entry || typeof entry.url !== "string") return [];
        const pageRead = entry.pageRead ? curateResearchPageEvidence(entry.pageRead) : null;
        return [{ sourceId: typeof entry.sourceId === "string" ? entry.sourceId : null, url: entry.url, ...(pageRead ? { pageRead } : {}) }];
      }), source: "journal_terminal" };
      exec.latencyMs = nonNegative(terminal.latencyMs);
      const measured = nonNegative(terminal.measuredCostMicroUsd);
      if (measured !== null) { exec.cost.knownMicroUsd = measured; exec.cost.knownSource = "journal_terminal_frozen_rate"; }
    } else if (dispatches.size) {
      exec.status = attentionRuns.has(runKey) ? "attention" : completed ? "interrupted" : "in_progress";
      if (exec.status === "interrupted") anomalies.push(`missing_terminal:${runKey}`);
    }
    if (exec.cost.knownMicroUsd === null && exec.usage.value && exec.search.succeeded !== null && "budget" in entry) {
      const usage = exec.usage.value;
      const cost = researchEvaluationMeasuredCost({ inputTokens: usage.inputTokens, outputTokens: usage.outputTokens,
        cachedInputTokens: usage.cachedInputTokens, cacheWriteTokens: usage.cacheWriteTokens }, entry, exec.search.succeeded);
      if (cost !== null) { exec.cost.knownMicroUsd = cost; exec.cost.knownSource = "frozen_rate_last_confirmed_checkpoint"; }
    }
    exec.cost.unknownCostPossible = exec.outcomeUnknownGeneration;
    result.set(runKey, exec);
  }
  return result;
}

function analyzeSnapshots(snapshots: Record<string, unknown>[], anomalies: string[]): { exec: Execution; runId: string | null; latest: Record<string, unknown> | null } {
  const ordered = [...snapshots].sort((a, b) => Date.parse(String(a.at)) - Date.parse(String(b.at)));
  const runIds = new Set(ordered.map(entry => entry.runId).filter(Boolean));
  if (runIds.size > 1) anomalies.push("snapshot_run_id_conflict");
  const latest = ordered.at(-1) ?? null;
  const exec = emptyExecution("not_started", true);
  if (!latest) return { exec, runId: null, latest };
  const generations = new Map<string, Record<string, unknown>>();
  for (const snapshot of ordered) for (const raw of Array.isArray(snapshot.generations) ? snapshot.generations : []) {
    const entry = record(raw); if (entry && typeof entry.id === "string") generations.set(entry.id, entry);
  }
  exec.dispatched = generations.size;
  exec.completedGenerations = [...generations.values()].filter(entry => entry.status === "completed").length;
  exec.finalGeneration = nonNegative(latest.stepCount);
  const status = String(latest.status);
  exec.status = status === "completed" && latest.stopReason === "report_submitted" ? "report_submitted" : status === "failed" ? "submit_failed" :
    status === "attention" ? "attention" : status === "cancelled" ? "cancelled" : generations.size ? "in_progress" : "not_started";
  exec.outcomeUnknownGeneration = [...generations.values()].some(entry => entry.status === "outcome_unknown");
  exec.stopReason = { value: latest.stopReason === null || latest.stopReason === undefined ? null : String(latest.stopReason), source: "run_snapshot" };
  exec.search.attempts = nonNegative(latest.searchCount);
  if (exec.status === "report_submitted") exec.search.succeeded = exec.search.attempts;
  exec.pageReads.attempts = nonNegative(latest.readCount);
  const reads: PageRead[] = [];
  for (const snapshot of ordered) for (const raw of Array.isArray(snapshot.pageReads) ? snapshot.pageReads : []) {
    const page = curatedPage({ readAt: snapshot.at, ...(record(raw) ?? {}) });
    if (page && !reads.some(read => read.sourceId === page.sourceId)) reads.push({ ...page, firstSeenAfterGeneration: nonNegative(snapshot.stepCount) ?? undefined });
  }
  if (reads.length) { exec.pageReads.reads = reads; exec.pageReads.succeeded = reads.filter(read => read.status === "read").length; }
  const reservation = record(latest.reservation);
  const settledIn = nonNegative(reservation?.settledInputTokens), settledOut = nonNegative(reservation?.settledOutputTokens);
  if (reservation?.status === "settled" && settledIn !== null && settledOut !== null) {
    exec.usage = { value: { inputTokens: settledIn, outputTokens: settledOut }, source: "reservation_settlement" };
    const model = nonNegative(reservation.settledCostMicroUsd);
    const search = nonNegative(record(record(record(latest.report)?.searchMetadata)?.costMetadata)?.searchBackendCostMicroUsd);
    if (model !== null && search !== null) { exec.cost.knownMicroUsd = model + search; exec.cost.knownSource = "reservation_settlement_plus_search_backend"; }
  }
  exec.cost.reservedMicroUsd = nonNegative(reservation?.reservedCostMicroUsd); exec.cost.reservedSource = "model_reservation_only";
  exec.cost.unknownCostPossible = exec.outcomeUnknownGeneration;
  const checkpointed = ordered.filter(entry => entry.status === "checkpointed");
  const steps = new Set(checkpointed.map(entry => entry.stepCount));
  const reservations = Math.max(0, ...ordered.map(entry => nonNegative(entry.reservationCount) ?? 0));
  if (reservations > 1) anomalies.push("multiple_reservations_for_one_run");
  exec.resume = { checkpointedObservations: checkpointed.length, resumedSteps: steps.size,
    completedAfterResume: steps.size > 0 && exec.status === "report_submitted",
    reloadObservations: ordered.filter(entry => /reload/.test(String(entry.phase))).length, reservations };
  return { exec, runId: typeof latest.runId === "string" ? latest.runId : null, latest };
}

const manifestCase = (manifest: ResearchEvaluationManifest | null, runKey?: string) => manifest?.cases.find(entry => entry.runKey === runKey);

function overrides(value: unknown, anomalies: string[]) {
  const map = new Map<string, Field<unknown>>();
  for (const raw of Array.isArray(value) ? value : []) {
    const entry = record(raw);
    if (!entry || typeof entry.field !== "string" || typeof entry.source !== "string" || !entry.source.trim()) { anomalies.push("field_override_invalid"); continue; }
    map.set(entry.field, { value: entry.value, source: `override:${entry.source}`, ...(typeof entry.note === "string" ? { note: entry.note.slice(0, 500) } : {}) });
  }
  return map;
}

function buildClaims(input: { report: ResearchPreviewReport | null; manual: Record<string, unknown> | null; reportDigest: string | null;
  normalizedContent: string | null; identity: string; sources: Map<string, Source>; display: Map<number, Source>; anomalies: string[] }): Claim[] {
  const claims: Omit<Claim, "claimDigest" | "evidenceDigest" | "sources">[] = [];
  if (input.report) {
    claims.push({ claimId: "S", section: "summary", text: input.report.summary, sourceIds: [], displayNumbers: [], key: true, mapping: "tool_input" });
    input.report.findings.forEach((finding, f) => finding.statements.forEach((statement, s) => claims.push({ claimId: `F${f + 1}S${s + 1}`, section: "finding",
      heading: finding.heading, text: statement.text, kind: statement.kind, ...(statement.evidenceLevel ? { evidenceLevel: statement.evidenceLevel } : {}),
      sourceIds: statement.sourceIds, displayNumbers: [], key: statement.kind !== "uncertain", mapping: "tool_input" })));
    input.report.contradictions.forEach((entry, c) => claims.push({ claimId: `C${c + 1}`, section: "contradiction", text: entry.text, sourceIds: entry.sourceIds,
      displayNumbers: [], key: true, mapping: "tool_input" }));
    input.report.limitations.forEach((text, l) => claims.push({ claimId: `L${l + 1}`, section: "limitation", text, sourceIds: [], displayNumbers: [], key: false, mapping: "tool_input" }));
    if (input.manual) input.anomalies.push("manual_claims_ignored_tool_input_present");
  } else if (input.manual) {
    if (input.manual.reportDigest !== input.reportDigest) input.anomalies.push("manual_claims_report_digest_mismatch");
    else for (const raw of Array.isArray(input.manual.claims) ? input.manual.claims : []) {
      const entry = record(raw);
      const section = entry?.section;
      if (!entry || typeof entry.claimId !== "string" || !/^[A-Z][A-Z0-9]{0,11}$/.test(entry.claimId) || typeof entry.text !== "string" ||
          !["summary", "finding", "contradiction", "limitation"].includes(String(section)) || claims.some(claim => claim.claimId === entry.claimId)) {
        input.anomalies.push("manual_claim_invalid"); continue;
      }
      if (!input.normalizedContent?.includes(normalizeText(entry.text))) { input.anomalies.push(`manual_claim_text_not_in_report:${entry.claimId}`); continue; }
      const displayNumbers = Array.isArray(entry.displayNumbers) ? entry.displayNumbers.filter((n): n is number => Number.isSafeInteger(n)) : [];
      const kind = typeof entry.kind === "string" ? entry.kind : undefined;
      claims.push({ claimId: entry.claimId, section: section as Claim["section"], text: entry.text, ...(kind ? { kind } : {}),
        ...(typeof entry.heading === "string" ? { heading: entry.heading } : {}),
        sourceIds: displayNumbers.map(n => input.display.get(n)?.sourceId).filter((id): id is string => !!id), displayNumbers,
        key: section === "summary" || section === "contradiction" || (section === "finding" && kind !== "uncertain"), mapping: "manual" });
    }
  }
  return claims.map(claim => {
    const sources = claim.mapping === "manual"
      ? claim.displayNumbers.map(n => input.display.get(n) ?? { sourceId: null, displayNumber: n, url: "unknown", snippet: "not_retained" as const, pageRead: "unknown" as const, modelSaw: "unknown", readBeforeReport: "unknown" as const })
      : claim.sourceIds.map(id => input.sources.get(id) ?? { sourceId: id, displayNumber: null, url: "unknown", snippet: "not_retained" as const, pageRead: "unknown" as const, modelSaw: "unknown", readBeforeReport: "unknown" as const });
    const displayNumbers = claim.mapping === "manual" ? claim.displayNumbers : sources.map(source => source.displayNumber).filter((n): n is number => n !== null);
    const claimDigest = researchEvaluationDigest({ identity: input.identity, reportDigest: input.reportDigest, claimId: claim.claimId, section: claim.section,
      text: claim.text, kind: claim.kind, evidenceLevel: claim.evidenceLevel, sourceIds: claim.sourceIds, displayNumbers });
    const evidenceDigest = researchEvaluationDigest(sources.map(source => ({ sourceId: source.sourceId, url: source.url, modelSaw: source.modelSaw,
      publishedAt: source.publishedAt, retrievedAt: source.retrievedAt, contentDigest: source.pageRead && source.pageRead !== "unknown" ? source.pageRead.contentDigest : undefined })));
    return { ...claim, displayNumbers, sources, claimDigest, evidenceDigest };
  });
}

const hex64 = z.string().regex(/^[a-f0-9]{64}$/);
const reviewDate = z.string().regex(/^\d{4}-\d{2}-\d{2}(?:T[\d:.]+(?:Z|[+-]\d{2}:\d{2}))?$/);
const verdictFileSchema = z.object({
  version: z.literal(1), provenance: z.enum(RESEARCH_REVIEW_VERDICT_PROVENANCE), reviewer: z.string().trim().min(1).max(100),
  reviewedAt: reviewDate, reference: z.string().max(500).optional(),
  entries: z.array(z.object({
    runIdentity: z.string().min(1).max(300), reportDigest: hex64, criteriaDigest: hex64,
    expectedOutcome: z.enum(["complete", "partial", "insufficient_evidence", "not_checked"]).optional(), note: z.string().max(1000).optional(),
    requirements: z.array(z.object({ id: z.string().max(80), verdict: z.enum(["met", "not_met", "not_checked"]), reason: z.string().max(1000).optional() }).strict()).max(20).default([]),
    claims: z.array(z.object({
      claimId: z.string().max(12), claimDigest: hex64, evidenceDigest: hex64, verdict: z.enum(RESEARCH_REVIEW_CLAIM_VERDICTS),
      reason: z.string().max(1000).optional(), contradicted: z.boolean().optional(),
      evidence: z.array(z.object({
        sourceId: z.string().regex(/^R(?:[1-9]|1\d|2[0-5])$/).optional(), url: z.string().url().max(2048), location: z.string().min(1).max(200),
        edition: z.string().max(200).optional(), quote: z.string().max(300).optional(), publishedAt: z.string().max(40).optional(),
        checkedAt: reviewDate, changedSinceRun: z.boolean().optional(),
        basis: z.enum(["model_seen_page", "model_seen_snippet", "current_official_page", "dated_official_revision", "historical_review_record"]),
      }).strict()).max(5).default([]),
    }).strict()).max(60).default([]),
  }).strict()).max(100),
}).strict();

type RunReview = ReturnType<typeof reviewRun>;
function reviewRun(input: ResearchReviewRunInput, exec: Execution, ids: { identity: string; caseId: string | null; modelId: string | null; runKey?: string; manifestDigest?: string },
  manifest: ResearchEvaluationManifest | null, anomalies: string[], latestSnapshot: Record<string, unknown> | null) {
  const fieldOverrides = overrides(input.fieldOverrides, anomalies);
  const stored = record(input.storedMessage ?? latestSnapshot?.report);
  const storedContent = typeof stored?.content === "string" ? stored.content : undefined;
  const metadata = parseResearchPreviewMetadata(record(stored?.searchMetadata)?.research);
  if (stored?.searchMetadata && !metadata) anomalies.push("stored_research_metadata_invalid");
  let report: ResearchPreviewReport | null = null;
  if (input.reportInput !== undefined) {
    let candidate = input.reportInput;
    if (input.statementPatches !== undefined) {
      if (input.origin !== "synthetic") anomalies.push("statement_patch_refused_non_synthetic");
      else {
        candidate = structuredClone(candidate);
        const findings = record(candidate)?.findings;
        for (const raw of Array.isArray(input.statementPatches) ? input.statementPatches : []) {
          const patch = record(raw); const match = /^F(\d+)S(\d+)$/.exec(String(patch?.claimId));
          const finding = match && Array.isArray(findings) ? record(findings[Number(match[1]) - 1]) : null;
          const statement = match && finding && Array.isArray(finding.statements) ? record(finding.statements[Number(match[2]) - 1]) : null;
          if (!statement || typeof patch?.text !== "string") anomalies.push("statement_patch_invalid"); else statement.text = patch.text;
        }
      }
    }
    const parsed = researchPreviewReportSchema.safeParse(candidate);
    if (parsed.success) report = parsed.data; else anomalies.push("report_input_schema_invalid");
  }
  const allowed = Array.isArray(input.allowedSources) ? input.allowedSources.filter(source => researchEvidenceSourceSchema.safeParse(source).success) as Array<z.infer<typeof researchEvidenceSourceSchema>> : null;
  if (Array.isArray(input.allowedSources) && allowed?.length !== input.allowedSources.length) anomalies.push("allowed_source_invalid");
  let replay: { performed: boolean; ok?: boolean; outcome?: string; reason?: string; contentDigest?: string; matchesArchive?: boolean | null } = { performed: false };
  let replayCited: Array<{ sourceId: string; url: string; pageRead?: ResearchPageEvidence }> | null = null;
  let replayContent: string | undefined;
  const locale = (manifestCase(manifest, ids.runKey)?.locale) ?? RESEARCH_EVALUATION_CASES.find(entry => entry.id === ids.caseId)?.locale ?? "en";
  if (input.replay && report && allowed) {
    try {
      const registry = createResearchEvidenceRegistry(allowed);
      const rendered = validateAndRenderResearchReport({ report, registry, allowedSourceIds: allowed.map(source => source.sourceId), locale, allowedEvidenceSources: allowed });
      replay = rendered.ok ? { performed: true, ok: true, outcome: rendered.outcome, contentDigest: researchReviewContentDigest(rendered.content) } : { performed: true, ok: false, reason: rendered.reason };
      if (rendered.ok) { replayCited = rendered.citedSources; replayContent = rendered.content; }
    } catch { replay = { performed: true, ok: false, reason: "evidence_snapshot_invalid" }; }
  }
  const archived = [exec.terminalContent && { source: "journal_terminal", text: exec.terminalContent }, storedContent && { source: "stored_message", text: storedContent },
    input.renderedReport !== undefined && { source: "rendered_report_file", text: input.renderedReport }].filter(Boolean) as Array<{ source: string; text: string }>;
  if (new Set(archived.map(entry => entry.text)).size > 1) anomalies.push(`report_content_mismatch:${archived.map(entry => entry.source).join("+")}`);
  const primary = archived[0] ?? (input.origin === "synthetic" && replayContent ? { source: "synthetic_replay", text: replayContent } : null);
  if (replay.performed && replay.ok && primary && primary.source !== "synthetic_replay") replay.matchesArchive = replay.contentDigest === researchReviewContentDigest(primary.text);
  if (replay.matchesArchive === false) anomalies.push("replay_differs_from_archived_report");
  const reportDigest = primary ? researchReviewContentDigest(primary.text) : null;
  const header = primary ? /\*\*([^*]+)\*\*/.exec(primary.text)?.[1] : undefined;
  const pick = <T>(candidates: Array<Field<T> | null | undefined | false>) => candidates.find((entry): entry is Field<T> => !!entry && entry.source !== "unknown");
  const declared = pick<Outcome | null | "unknown">([exec.terminalOutcome, metadata && { value: metadata.outcome as Outcome, source: "stored_research_metadata" },
    replay.ok && replay.matchesArchive !== false && { value: replay.outcome as Outcome, source: replay.matchesArchive ? "current_replay_matching_archive" : "current_replay" },
    fieldOverrides.get("outcome") as Field<Outcome> | undefined]) ?? unknownField<Outcome | null | "unknown">("unknown");
  const reportHeaderOutcome = header ? outcomeLabels[header] ?? null : null;
  if (declared.value && declared.value !== "unknown" && reportHeaderOutcome && reportHeaderOutcome !== declared.value) anomalies.push("declared_outcome_differs_from_report_header");
  if (fieldOverrides.has("stopReason") && exec.stopReason.source === "unknown") exec.stopReason = fieldOverrides.get("stopReason") as Field<string | null>;
  // Cited sources keep their original R IDs; display numbers follow first-citation order and are a separate column.
  const reads = new Map<string, PageRead>(exec.pageReads.reads === "unknown" ? [] : exec.pageReads.reads.map(read => [read.sourceId, read]));
  const allowedById = new Map((allowed ?? []).map(source => [source.sourceId, source]));
  const citedOverride = fieldOverrides.get("citedSources");
  const cited = pick<Array<{ sourceId: string | null; url: string; displayNumber?: number; pageRead?: unknown }>>([
    exec.terminalCited.source !== "unknown" && exec.terminalCited.value !== "unknown" && { value: exec.terminalCited.value, source: exec.terminalCited.source },
    metadata?.sources && { value: metadata.sources.map(source => ({ sourceId: source.sourceId, url: source.url, displayNumber: source.referenceNumber, pageRead: "pageRead" in source ? source.pageRead : undefined, publishedAt: source.publishedAt, retrievedAt: source.retrievedAt, title: source.title, snippet: source.excerpt })), source: "stored_research_metadata" },
    replayCited && { value: replayCited, source: "current_replay" },
    citedOverride && Array.isArray(citedOverride.value) && citedOverride as Field<Array<{ sourceId: string | null; url: string }>>]) ?? unknownField<Array<{ sourceId: string | null; url: string }>>([]);
  const finalGeneration = exec.finalGeneration;
  const sources = new Map<string, Source>(); const display = new Map<number, Source>();
  cited.value.forEach((raw, index) => {
    const entry = raw as Record<string, unknown> & { sourceId: string | null; url: string };
    const snapshot = entry.sourceId ? allowedById.get(entry.sourceId) : undefined;
    if (snapshot && snapshot.url !== entry.url) anomalies.push(`cited_source_url_mismatch:${entry.sourceId}`);
    const journalRead = entry.sourceId ? reads.get(entry.sourceId) : undefined;
    const declaredPage = entry.pageRead !== undefined ? curateResearchPageEvidence(entry.pageRead) : snapshot?.pageRead ?? null;
    const pageRead: PageRead | null | "unknown" = journalRead ? { ...journalRead, ...(declaredPage ? { readAt: declaredPage.readAt } : {}) } : (declaredPage ? { ...declaredPage, sourceId: entry.sourceId ?? "?", url: entry.url } :
      cited.source.startsWith("override") && entry.pageRead === undefined ? "unknown" : null);
    const snippet = typeof (snapshot?.snippet ?? entry.snippet) === "string";
    const displayNumber = nonNegative(entry.displayNumber) ?? index + 1;
    const readBeforeReport: boolean | "unknown" = pageRead === "unknown" ? "unknown" : !pageRead || pageRead.status !== "read" ? false :
      pageRead.firstSeenAfterGeneration !== undefined && finalGeneration !== null ? pageRead.firstSeenAfterGeneration < finalGeneration : "unknown";
    const verification = (Array.isArray(input.verification) ? input.verification : []).map(record).find(item => item && (item.sourceId === entry.sourceId || item.url === entry.url));
    const source: Source = { sourceId: entry.sourceId, displayNumber, url: entry.url,
      ...(typeof (snapshot?.title ?? entry.title) === "string" ? { title: String(snapshot?.title ?? entry.title) } : {}),
      ...(typeof (snapshot?.publishedAt ?? entry.publishedAt) === "string" ? { publishedAt: String(snapshot?.publishedAt ?? entry.publishedAt) } : {}),
      ...(typeof (snapshot?.retrievedAt ?? entry.retrievedAt) === "string" ? { retrievedAt: String(snapshot?.retrievedAt ?? entry.retrievedAt) } : {}),
      snippet: snippet ? "retained" : "not_retained", pageRead, modelSaw: modelSaw(pageRead, snippet), readBeforeReport,
      ...(verification ? { verification: { checkedAt: verification.checkedAt, status: verification.status, truncated: verification.truncated,
        characters: verification.characters, contentDigest: verification.contentDigest, excerpt: typeof verification.excerpt === "string" ? verification.excerpt.slice(0, 400) : undefined,
        digestMatchesRun: typeof verification.contentDigest === "string" && pageRead && pageRead !== "unknown" && pageRead.contentDigest ? verification.contentDigest === pageRead.contentDigest : "unknown" } } : {}) };
    if (entry.sourceId) sources.set(entry.sourceId, source);
    display.set(displayNumber, source);
  });
  if (report && reads.size) for (const id of report.findings.flatMap(finding => finding.statements.flatMap(statement => statement.sourceIds))) {
    if (!sources.has(id)) anomalies.push(`citation_missing_from_snapshot:${id}`);
  }
  const manual = record(input.manualClaims);
  if (manual && !report) for (const raw of Array.isArray(manual.citations) ? manual.citations : []) {
    const entry = record(raw); const n = nonNegative(entry?.displayNumber);
    if (n !== null && !display.has(n) && typeof entry?.url === "string") display.set(n, { sourceId: typeof entry.sourceId === "string" ? entry.sourceId : null, displayNumber: n,
      url: entry.url, snippet: "not_retained", pageRead: "unknown", modelSaw: "unknown", readBeforeReport: "unknown" });
  }
  const claims = buildClaims({ report, manual, reportDigest, normalizedContent: primary ? normalizeText(primary.text) : null,
    identity: ids.identity, sources, display, anomalies });
  return { identity: ids.identity, label: input.label ?? null, origin: input.origin, caseId: ids.caseId, modelId: ids.modelId, runKey: ids.runKey ?? null,
    manifestDigest: ids.manifestDigest ?? null, derivedFrom: input.derivedFrom ?? null, inputStatus: input.inputStatus ?? {},
    measured: MEASURED_ORIGINS.has(input.origin), execution: exec, declaredOutcome: declared, reportHeaderOutcome,
    report: primary ? { digest: reportDigest, characters: primary.text.length, source: primary.source } : null, replay,
    citedSourcesSource: cited.source, sources: [...display.values()].sort((a, b) => (a.displayNumber ?? 0) - (b.displayNumber ?? 0)), claims,
    criteriaDigest: ids.caseId ? researchReviewCriteriaDigest(ids.caseId) : null, anomalies };
}

function machineOriginalRead(run: RunReview) {
  if (run.execution.status !== "report_submitted") return { verdict: "not_checked" as const, reason: "no submitted report" };
  if (!run.claims.some(claim => claim.mapping === "tool_input")) return { verdict: "not_checked" as const, reason: "statement evidence levels are not in this record (no report tool input)" };
  const pageCited = new Set(run.claims.filter(claim => claim.evidenceLevel === "page_text").flatMap(claim => claim.sourceIds));
  const hit = run.sources.find(source => source.sourceId && pageCited.has(source.sourceId) && /^https:\/\/www\.rfc-editor\.org\//.test(source.url) &&
    source.pageRead && source.pageRead !== "unknown" && source.pageRead.status === "read" && source.readBeforeReport === true);
  if (hit) return { verdict: "met" as const, reason: `${hit.sourceId} ${hit.url} status=read truncated=${(hit.pageRead as PageRead).truncated} before final generation` };
  const unknown = run.sources.some(source => source.pageRead === "unknown" || source.readBeforeReport === "unknown");
  return unknown ? { verdict: "not_checked" as const, reason: "page-read fields unknown in this record" } : { verdict: "not_met" as const, reason: "no cited RFC Editor original read before submission" };
}

export function buildResearchQualityReview(input: { runs: ResearchReviewRunInput[]; verdictFiles?: unknown[]; generatedAt: string; observedUntil?: string; bundleDigest?: string }) {
  const runs: RunReview[] = []; const globalAnomalies: string[] = [];
  const seen = new Map<string, { digest: string; bare: boolean; execution: string }>();
  /** One identity is one run: re-entered journals, reloads and resumes never add a second row, cost or call. */
  const add = (run: RunReview, digest: string, bare: boolean) => {
    const execution = researchEvaluationDigest(run.execution);
    const previous = seen.get(run.identity);
    if (!previous) { seen.set(run.identity, { digest, bare, execution }); runs.push(run); return; }
    if (previous.digest === digest || (bare && previous.execution === execution)) { globalAnomalies.push(`duplicate_input_ignored:${run.identity}`); return; }
    if (previous.bare && previous.execution === execution) {
      runs[runs.findIndex(entry => entry.identity === run.identity)] = run; seen.set(run.identity, { digest, bare, execution }); return;
    }
    globalAnomalies.push(`conflicting_inputs:${run.identity}`);
    for (const existing of [...runs.filter(entry => entry.identity === run.identity), run]) {
      existing.execution.status = "not_applicable"; existing.anomalies.push("conflicting_inputs_excluded");
    }
    runs.push(run);
  };
  for (const entry of input.runs) {
    const anomalies = [...(entry.journalIssues ?? [])];
    const inputDigest = researchEvaluationDigest({ ...entry, label: undefined, inputStatus: undefined });
    const lines = (entry.journalLines ?? []).map(record).filter((line): line is Record<string, unknown> => !!line);
    const unique = [...new Map(lines.map(line => [researchEvaluationDigest(line), line])).values()];
    if (unique.length < lines.length) anomalies.push(`duplicate_journal_lines:${lines.length - unique.length}`);
    const journalManifest = record(unique.find(line => line.kind === "reserved")?.manifest);
    const supplied = record(entry.manifest);
    if (journalManifest && supplied && journalManifest.manifestDigest !== supplied.manifestDigest) anomalies.push("supplied_manifest_differs_from_journal");
    const manifestRaw = journalManifest ?? supplied;
    let manifest: ResearchEvaluationManifest | null = null;
    if (manifestRaw) {
      const { manifestDigest, ...body } = manifestRaw;
      if (researchEvaluationDigest(body) !== manifestDigest || !Array.isArray(manifestRaw.cases)) anomalies.push("manifest_digest_invalid");
      else manifest = manifestRaw as unknown as ResearchEvaluationManifest;
    }
    if (entry.snapshots) {
      const snapshotAnomalies = [...anomalies];
      const { exec, runId, latest } = analyzeSnapshots(entry.snapshots.map(record).filter((value): value is Record<string, unknown> => !!value), snapshotAnomalies);
      const identity = `devui:${runId ?? entry.runId ?? "unknown"}`;
      add(reviewRun(entry, exec, { identity, caseId: entry.caseId ?? null, modelId: entry.modelId ?? (latest?.modelId as string) ?? null }, null, snapshotAnomalies, latest), inputDigest, false);
    } else if (manifest) {
      if (entry.origin !== "preview_only" && !unique.length) anomalies.push("journal_not_available");
      const executions = analyzeJournal(unique, manifest, anomalies);
      for (const manifestEntry of manifest.cases) {
        const attach = entry.runKey ? entry.runKey === manifestEntry.runKey : manifest.cases.length === 1;
        const scoped: ResearchReviewRunInput = attach ? entry : { origin: entry.origin, inputStatus: entry.inputStatus };
        const prefix = entry.origin === "preview_only" ? "preview" : "manifest";
        add(reviewRun(scoped, executions.get(manifestEntry.runKey)!, { identity: `${prefix}:${manifest.manifestDigest}:${manifestEntry.runKey}`, caseId: manifestEntry.id,
          modelId: manifestEntry.modelId, runKey: manifestEntry.runKey, manifestDigest: manifest.manifestDigest }, manifest, [...anomalies], null),
        researchEvaluationDigest({ inputDigest, runKey: manifestEntry.runKey, attach }), !attach);
      }
    } else {
      // Synthetic or replay rows without a journal simulate one submitted report; they have no calls and never enter measured totals.
      const simulated = (entry.origin === "synthetic" || entry.origin === "current_replay") && entry.reportInput !== undefined;
      const exec = emptyExecution(simulated ? "report_submitted" : "not_run", simulated);
      exec.simulated = simulated;
      add(reviewRun(entry, exec, { identity: `${entry.origin}:${entry.runId ?? "unknown"}`, caseId: entry.caseId ?? null, modelId: entry.modelId ?? null }, null, anomalies, null), inputDigest, false);
    }
  }
  // Human verdicts: bound to run, report, claim, evidence and criteria digests. Anything else is refused, never carried over.
  const rejected: Array<{ file: number; runIdentity?: string; claimId?: string; requirementId?: string; reason: string }> = [];
  type RunVerdicts = { provenance: string; reviewer: string; reviewedAt: string; reference?: string; expectedOutcome?: string; note?: string;
    requirements: Map<string, { verdict: string; reason?: string }>; claims: Map<string, { verdict: ClaimVerdict; reason?: string; contradicted?: boolean; evidence: unknown[] }> };
  const verdicts = new Map<string, RunVerdicts>();
  (input.verdictFiles ?? []).forEach((raw, file) => {
    const parsed = verdictFileSchema.safeParse(raw);
    if (!parsed.success) { rejected.push({ file, reason: "verdict_file_schema_invalid" }); return; }
    for (const entry of parsed.data.entries) {
      const run = runs.find(candidate => candidate.identity === entry.runIdentity);
      const reject = (reason: string, extra: Record<string, string> = {}) => rejected.push({ file, runIdentity: entry.runIdentity, ...extra, reason });
      if (!run || run.execution.status === "not_applicable" && run.anomalies.includes("conflicting_inputs_excluded")) { reject("unknown_run"); continue; }
      if (!run.report || entry.reportDigest !== run.report.digest) { reject("report_digest_mismatch"); continue; }
      if (entry.criteriaDigest !== run.criteriaDigest) { reject("criteria_digest_mismatch"); continue; }
      if (parsed.data.provenance === "synthetic" && run.measured) { reject("synthetic_verdict_on_measured_run"); continue; }
      const target: RunVerdicts = verdicts.get(run.identity) ?? { provenance: parsed.data.provenance, reviewer: parsed.data.reviewer, reviewedAt: parsed.data.reviewedAt,
        ...(parsed.data.reference ? { reference: parsed.data.reference } : {}), requirements: new Map(), claims: new Map() };
      if (verdicts.has(run.identity) && target.provenance !== parsed.data.provenance) { reject("mixed_verdict_provenance"); continue; }
      if (entry.expectedOutcome && entry.expectedOutcome !== "not_checked") target.expectedOutcome = entry.expectedOutcome;
      if (entry.note) target.note = entry.note;
      const requirements = RESEARCH_REVIEW_CRITERIA.cases[run.caseId ?? ""]?.requirements ?? [];
      for (const requirement of entry.requirements) {
        const known = requirements.find(item => item.id === requirement.id);
        if (!known) reject("unknown_requirement", { requirementId: requirement.id });
        else if (known.check) reject("machine_requirement_not_overridable", { requirementId: requirement.id });
        else if (target.requirements.has(requirement.id)) reject("duplicate_verdict", { requirementId: requirement.id });
        else target.requirements.set(requirement.id, { verdict: requirement.verdict, ...(requirement.reason ? { reason: requirement.reason } : {}) });
      }
      for (const claimVerdict of entry.claims) {
        const claim = run.claims.find(item => item.claimId === claimVerdict.claimId);
        const reason = !claim ? "unknown_claim" : claimVerdict.claimDigest !== claim.claimDigest ? "claim_digest_mismatch" :
          claimVerdict.evidenceDigest !== claim.evidenceDigest ? "evidence_digest_mismatch" : target.claims.has(claim.claimId) ? "duplicate_verdict" :
          claimVerdict.contradicted && (!claimVerdict.reason || !["unsupported", "partial support"].includes(claimVerdict.verdict)) ? "contradiction_requires_reason_and_non_supported_verdict" :
          claimVerdict.verdict !== "not checked" && claimVerdict.verdict !== "supported" && !claimVerdict.reason ? "reason_required" :
          claimVerdict.evidence.some(item => item.sourceId && !claim.sourceIds.includes(item.sourceId)) ? "evidence_source_not_cited_by_claim" :
          claimVerdict.verdict !== "not checked" && !claimVerdict.evidence.length ? "evidence_location_required" : null;
        if (reason) { reject(reason, { claimId: claimVerdict.claimId }); continue; }
        target.claims.set(claim!.claimId, { verdict: claimVerdict.verdict, ...(claimVerdict.reason ? { reason: claimVerdict.reason } : {}),
          ...(claimVerdict.contradicted ? { contradicted: true } : {}), evidence: claimVerdict.evidence });
      }
      verdicts.set(run.identity, target);
    }
  });
  const evaluated = runs.map(run => {
    const verdict = verdicts.get(run.identity);
    const criteria = RESEARCH_REVIEW_CRITERIA.cases[run.caseId ?? ""];
    const requirements = (criteria?.requirements ?? []).map(requirement => requirement.check
      ? { id: requirement.id, text: requirement.text, ...machineOriginalRead(run), source: "machine_from_run_record" }
      : { id: requirement.id, text: requirement.text, ...(verdict?.requirements.get(requirement.id) ?? { verdict: "not_checked" }), source: verdict?.requirements.has(requirement.id) ? verdict.provenance : "manual_review_pending" });
    const claims = run.claims.map(claim => ({ ...claim, review: verdict?.claims.get(claim.claimId) ?? { verdict: "not checked" as ClaimVerdict, evidence: [] },
      reviewSource: verdict?.claims.has(claim.claimId) ? verdict.provenance : "manual_review_pending" }));
    const key = claims.filter(claim => claim.key);
    const submitted = run.execution.status === "report_submitted";
    const failing = requirements.some(requirement => requirement.verdict === "not_met") ||
      key.some(claim => claim.review.verdict === "unsupported" || claim.review.verdict === "partial support" || claim.review.contradicted);
    const substantive = !submitted ? "not_applicable" : failing ? "not_complete" :
      requirements.length && requirements.every(requirement => requirement.verdict === "met") && key.length && key.every(claim => claim.review.verdict === "supported") ? "complete" : "pending";
    const declared = run.declaredOutcome.value;
    const expected = verdict?.expectedOutcome;
    const honesty = !submitted || declared === null || declared === "unknown" ? "not_applicable" :
      declared === "complete" ? substantive === "not_complete" || (expected && expected !== "complete") ? "overclaim" :
        substantive === "complete" && expected === "complete" ? "accurate_complete" : "pending" :
      !expected ? "pending" : declared === expected ? "honest_shortfall" :
      expected === "complete" ? "underclaim" : "shortfall_kind_mismatch";
    const originalAcquired = run.sources.some(source => source.modelSaw.startsWith("page_text"));
    return { ...run, requirements, claims, substantive, honesty, expectedOutcome: expected ?? "manual_review_pending",
      verdictSource: verdict ? { provenance: verdict.provenance, reviewer: verdict.reviewer, reviewedAt: verdict.reviewedAt, reference: verdict.reference ?? null, note: verdict.note ?? null } : null,
      originalRequired: criteria?.originalRequired ?? false, originalAcquired };
  });
  const groups = new Map<string, ReturnType<typeof emptyGroup>>();
  function emptyGroup(origin: string, caseId: string, modelId: string) {
    return { origin, caseId, modelId, measured: MEASURED_ORIGINS.has(origin as ResearchReviewOrigin), planned: 0, started: 0, checkpointed: 0, submitted: 0, submitFailed: 0,
      attention: 0, interrupted: 0, cancelled: 0, inProgress: 0, notStarted: 0, notRun: 0, excluded: 0, requirementsAllMet: 0,
      substantiveComplete: 0, substantiveNotComplete: 0, substantivePending: 0, accurateComplete: 0, honestShortfall: 0, overclaim: 0, underclaim: 0,
      shortfallMismatch: 0, honestyPending: 0, keyClaims: 0, keyReviewed: 0, supported: 0, partialSupport: 0, unsupported: 0, contradicted: 0, notChecked: 0,
      originalRequired: 0, originalAcquired: 0, modelAttempts: 0, modelCompleted: 0, searchAttempts: 0, searchSucceeded: 0, searchUnknown: 0,
      pageReadAttempts: 0, pageReadSucceeded: 0, pageReadUnknown: 0, knownCostMicroUsd: 0, knownCostRuns: 0, unknownCostRuns: 0, reservedMicroUsd: 0 };
  }
  for (const run of evaluated) {
    const key = `${run.origin}|${run.caseId ?? "unknown"}|${run.modelId ?? "unknown"}`;
    const group = groups.get(key) ?? emptyGroup(run.origin, run.caseId ?? "unknown", run.modelId ?? "unknown");
    groups.set(key, group);
    const exec = run.execution;
    if (exec.status === "not_applicable" && run.anomalies.includes("conflicting_inputs_excluded")) { group.excluded++; continue; }
    if (exec.planned) group.planned++;
    if (exec.dispatched > 0 || exec.simulated) group.started++;
    if (exec.completedGenerations > 0) group.checkpointed++;
    const counters: Record<string, keyof typeof group> = { report_submitted: "submitted", submit_failed: "submitFailed", attention: "attention",
      interrupted: "interrupted", cancelled: "cancelled", in_progress: "inProgress", not_started: "notStarted", not_run: "notRun" };
    if (counters[exec.status]) (group[counters[exec.status]] as number)++;
    if (run.requirements.length && run.requirements.every(requirement => requirement.verdict === "met")) group.requirementsAllMet++;
    if (run.substantive === "complete") group.substantiveComplete++; else if (run.substantive === "not_complete") group.substantiveNotComplete++; else if (run.substantive === "pending") group.substantivePending++;
    const honesty: Record<string, keyof typeof group> = { accurate_complete: "accurateComplete", honest_shortfall: "honestShortfall", overclaim: "overclaim",
      underclaim: "underclaim", shortfall_kind_mismatch: "shortfallMismatch", pending: "honestyPending" };
    if (honesty[run.honesty]) (group[honesty[run.honesty]] as number)++;
    for (const claim of run.claims.filter(item => item.key)) {
      group.keyClaims++;
      if (claim.review.verdict !== "not checked") group.keyReviewed++;
      group[({ supported: "supported", "partial support": "partialSupport", unsupported: "unsupported", "not checked": "notChecked" } as const)[claim.review.verdict]]++;
      if (claim.review.contradicted) group.contradicted++;
    }
    if (run.originalRequired && exec.status === "report_submitted") { group.originalRequired++; if (run.originalAcquired) group.originalAcquired++; }
    group.modelAttempts += exec.dispatched; group.modelCompleted += exec.completedGenerations;
    group.searchAttempts += exec.search.attempts ?? 0;
    if (exec.search.succeeded === null) { if (exec.dispatched) group.searchUnknown++; } else group.searchSucceeded += exec.search.succeeded;
    group.pageReadAttempts += exec.pageReads.attempts ?? 0;
    if (exec.pageReads.succeeded === null) { if (exec.pageReads.attempts) group.pageReadUnknown++; } else group.pageReadSucceeded += exec.pageReads.succeeded;
    if (exec.cost.knownMicroUsd !== null) { group.knownCostMicroUsd += exec.cost.knownMicroUsd; group.knownCostRuns++; }
    if (exec.cost.unknownCostPossible) group.unknownCostRuns++;
    if (exec.dispatched) group.reservedMicroUsd += exec.cost.reservedMicroUsd ?? 0;
  }
  const measured = [...groups.values()].filter(group => group.measured);
  const sum = (field: keyof ReturnType<typeof emptyGroup>) => measured.reduce((total, group) => total + (group[field] as number), 0);
  return {
    version: RESEARCH_REVIEW_VERSION, generatedAt: input.generatedAt, observedUntil: input.observedUntil ?? null, bundleDigest: input.bundleDigest ?? null,
    criteria: { version: RESEARCH_REVIEW_CRITERIA.version, keyClaimRule: RESEARCH_REVIEW_CRITERIA.keyClaimRule, substantiveCompletionRule: RESEARCH_REVIEW_CRITERIA.substantiveCompletionRule,
      cases: Object.fromEntries(Object.entries(RESEARCH_REVIEW_CRITERIA.cases).map(([id, entry]) => [id, { ...entry, digest: researchReviewCriteriaDigest(id) }])) },
    measuredTotals: { started: sum("started"), submitted: sum("submitted"), substantiveComplete: sum("substantiveComplete"), substantivePending: sum("substantivePending"),
      honestShortfall: sum("honestShortfall"), overclaim: sum("overclaim"), keyClaims: sum("keyClaims"), keyReviewed: sum("keyReviewed"), supported: sum("supported"),
      knownCostMicroUsd: sum("knownCostMicroUsd"), unknownCostRuns: sum("unknownCostRuns") },
    operatingCompletionRate: { status: "not_measured", reason: "No independent operational sample: every row is a development evaluation or one hand-driven dev UI case." },
    groups: [...groups.values()], runs: evaluated, rejectedVerdicts: rejected, anomalies: globalAnomalies,
  };
}
export type ResearchQualityReview = ReturnType<typeof buildResearchQualityReview>;

/** Fill-in sheet for human reviewers; every value starts unchecked and is bound to the current digests. */
export function researchReviewVerdictTemplate(review: ResearchQualityReview) {
  return { version: 1, provenance: "human", reviewer: "unassigned", reviewedAt: review.generatedAt.slice(0, 10),
    entries: review.runs.filter(run => run.report && run.criteriaDigest).map(run => ({ runIdentity: run.identity, reportDigest: run.report!.digest, criteriaDigest: run.criteriaDigest,
      expectedOutcome: "not_checked",
      requirements: run.requirements.filter(requirement => requirement.source !== "machine_from_run_record").map(requirement => ({ id: requirement.id, verdict: "not_checked" })),
      claims: run.claims.map(claim => ({ claimId: claim.claimId, claimDigest: claim.claimDigest, evidenceDigest: claim.evidenceDigest, verdict: "not checked", evidence: [] })) })) };
}

const ratio = (n: number, d: number) => d ? `${n}/${d} (${Math.round((n / d) * 1000) / 10}%)` : `${n}/${d} (N/A)`;
const usd = (micro: number | null) => micro === null ? "unknown" : `US$${(micro / 1_000_000).toFixed(6)}`;
const cell = (value: unknown) => String(value ?? "").replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 220);

export function renderResearchQualityReviewMarkdown(review: ResearchQualityReview) {
  const lines = ["# Research Preview quality review", "",
    `Generated ${review.generatedAt}; observation cutoff ${review.observedUntil ?? "not stated"}; criteria ${review.criteria.version}; bundle digest ${review.bundleDigest ?? "n/a"}.`,
    "Offline projection of past runs. No model, search, page read, database or network call was made. Ratings come only from imported human verdicts; anything unrated is `manual_review_pending` / `not checked`.",
    "", `Origins: historical_cli = past development CLI run; historical_dev_ui = past dev Chat UI run; current_replay = past tool input re-rendered by current code; synthetic = constructed fixture; preview_only = manifest preview, never executed. Only historical rows enter measured totals.`,
    "", `Operating completion rate: **${review.operatingCompletionRate.status}**. ${review.operatingCompletionRate.reason}`, "",
    "## Completion funnel (case × model × origin)", "",
    "| Origin | Case | Model | Planned | Started | Checkpointed | Submitted | Submit failed | Attention / interrupted / in progress | Not started / not run | Submission rate | All requirements met | Substantive complete (lower bound / started) | Pending review |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"];
  for (const group of review.groups) lines.push(`| ${group.origin} | ${group.caseId} | ${group.modelId} | ${group.planned} | ${group.started} | ${group.checkpointed} | ${group.submitted} | ${group.submitFailed} | ${group.attention} / ${group.interrupted} / ${group.inProgress} | ${group.notStarted} / ${group.notRun} | ${ratio(group.submitted, group.started)} | ${group.requirementsAllMet} | ${ratio(group.substantiveComplete, group.started)} | ${group.substantivePending} |`);
  lines.push("", "## Declared outcome honesty and claim support", "",
    "| Origin | Case | Model | Accurate complete | Honest shortfall | Overclaim | Underclaim / kind mismatch | Honesty pending | Key claims reviewed | Supported | Partial | Unsupported | Contradicted | Not checked | Original needed → acquired |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|");
  for (const group of review.groups) lines.push(`| ${group.origin} | ${group.caseId} | ${group.modelId} | ${group.accurateComplete} | ${group.honestShortfall} | ${group.overclaim} | ${group.underclaim} / ${group.shortfallMismatch} | ${group.honestyPending} | ${ratio(group.keyReviewed, group.keyClaims)} | ${group.supported} | ${group.partialSupport} | ${group.unsupported} | ${group.contradicted} | ${group.notChecked} | ${group.originalRequired ? ratio(group.originalAcquired, group.originalRequired) : "n/a"} |`);
  lines.push("", "## Calls, usage and cost", "", "Known cost is frozen-rate application accounting, not a provider invoice. Reserved is the per-run ceiling of started runs. Unknown means a dispatched call whose outcome or usage is not recorded; it is never counted as zero.", "",
    "| Origin | Case | Model | Model calls attempted / completed | Searches attempted / succeeded (unknown runs) | Page reads attempted / succeeded (unknown runs) | Known cost (runs) | Runs with unknown cost | Reserved ceiling |",
    "|---|---|---|---|---|---|---|---|---|");
  for (const group of review.groups) lines.push(`| ${group.origin} | ${group.caseId} | ${group.modelId} | ${group.modelAttempts} / ${group.modelCompleted} | ${group.searchAttempts} / ${group.searchSucceeded} (${group.searchUnknown}) | ${group.pageReadAttempts} / ${group.pageReadSucceeded} (${group.pageReadUnknown}) | ${usd(group.knownCostMicroUsd)} (${group.knownCostRuns}) | ${group.unknownCostRuns} | ${usd(group.reservedMicroUsd)} |`);
  const totals = review.measuredTotals;
  lines.push("", `Measured totals (historical rows only): submitted ${ratio(totals.submitted, totals.started)} of started; substantive complete ${ratio(totals.substantiveComplete, totals.started)} (lower bound, ${totals.substantivePending} pending); honest shortfall ${totals.honestShortfall}; overclaim ${totals.overclaim}; key claims reviewed ${ratio(totals.keyReviewed, totals.keyClaims)}, supported ${totals.supported}; known cost ${usd(totals.knownCostMicroUsd)}; runs with unknown cost ${totals.unknownCostRuns}. Cost per substantively complete report is not computed without a complete denominator.`);
  for (const run of review.runs) {
    const exec = run.execution;
    lines.push("", `## ${run.label ?? run.identity}`, "", `- Identity: \`${run.identity}\`; origin ${run.origin}${run.derivedFrom ? ` (derived from \`${run.derivedFrom}\`)` : ""}; case ${run.caseId}; model ${run.modelId}; measured ${run.measured}.`,
      `- Status ${exec.status}; stop reason ${exec.stopReason.value ?? "none"} (${exec.stopReason.source})${exec.rejection ? `; rejection ${exec.rejection}` : ""}; declared outcome ${run.declaredOutcome.value} (${run.declaredOutcome.source}${run.declaredOutcome.note ? `: ${run.declaredOutcome.note}` : ""}); expected ${run.expectedOutcome}; honesty ${run.honesty}; substantive ${run.substantive}.`,
      `- Generations dispatched ${exec.dispatched}, completed ${exec.completedGenerations}${exec.outcomeUnknownGeneration ? ", last outcome unknown" : ""}; searches ${exec.search.attempts ?? "unknown"}/${exec.search.succeeded ?? "unknown"}; page reads ${exec.pageReads.attempts ?? "unknown"}/${exec.pageReads.succeeded ?? "unknown"}; usage ${exec.usage.value ? JSON.stringify(exec.usage.value) : "unknown"} (${exec.usage.source}); latency ${exec.latencyMs ?? "unknown"} ms; known cost ${usd(exec.cost.knownMicroUsd)} (${exec.cost.knownSource}); reserved ${usd(exec.cost.reservedMicroUsd)} (${exec.cost.reservedSource}).`);
    if (exec.resume) lines.push(`- Resume: ${exec.resume.checkpointedObservations} checkpointed observations over ${exec.resume.resumedSteps} resume step(s), ${exec.resume.reloadObservations} reloads, ${exec.resume.reservations} reservation(s); completed after resume ${exec.resume.completedAfterResume}. Reloads and resumes are one run.`);
    lines.push(`- Report: ${run.report ? `${run.report.characters} characters, sha256 \`${run.report.digest}\` (${run.report.source})` : "not available"}; replay ${run.replay.performed ? `${run.replay.ok ? `ok ${run.replay.outcome}` : `refused ${run.replay.reason}`}, matches archive ${run.replay.matchesArchive ?? "n/a"}` : "not performed"}; cited sources from ${run.citedSourcesSource}.`);
    if (run.verdictSource) lines.push(`- Verdicts: ${run.verdictSource.provenance} by ${run.verdictSource.reviewer} on ${run.verdictSource.reviewedAt}${run.verdictSource.reference ? ` (${run.verdictSource.reference})` : ""}.${run.verdictSource.note ? ` ${run.verdictSource.note}` : ""}`);
    if (Object.keys(run.inputStatus).length) lines.push(`- Inputs: ${Object.entries(run.inputStatus).map(([name, status]) => `${name} ${status}`).join(", ")}.`);
    if (run.anomalies.length) lines.push(`- Anomalies: ${[...new Set(run.anomalies)].join(", ")}.`);
    if (run.sources.length) {
      lines.push("", "| Display | Original ID | URL | Published | Retrieved | Model saw | Page read | Read before report | Reviewer check |", "|---|---|---|---|---|---|---|---|---|");
      for (const source of run.sources) {
        const page = source.pageRead === "unknown" ? "unknown" : source.pageRead ? `${source.pageRead.status}${source.pageRead.reason ? `:${source.pageRead.reason}` : ""} at ${source.pageRead.readAt}${source.pageRead.contentCharacters !== undefined ? `, ${source.pageRead.contentCharacters} chars` : ""}${source.pageRead.contentDigest ? `, ${source.pageRead.contentDigest.slice(0, 12)}…` : ""}` : "none";
        const check = source.verification ? `checked ${source.verification.checkedAt ?? "?"}, digest matches run ${source.verification.digestMatchesRun}` : "";
        lines.push(`| ${source.displayNumber ?? "?"} | ${source.sourceId ?? "unknown"} | ${cell(source.url)} | ${source.publishedAt ?? "unknown"} | ${source.retrievedAt ?? "unknown"} | ${source.modelSaw} | ${cell(page)} | ${source.readBeforeReport} | ${cell(check)} |`);
      }
    }
    if (run.requirements.length) {
      lines.push("", "| Requirement | Verdict | Source | Reason |", "|---|---|---|---|");
      for (const requirement of run.requirements) lines.push(`| ${requirement.id} | ${requirement.verdict} | ${requirement.source} | ${cell(requirement.reason)} |`);
    }
    if (run.claims.length) {
      lines.push("", "| Claim | Key | Kind / level | Statement | Cites (original → display) | Model saw | Verdict | Reason / evidence |", "|---|---|---|---|---|---|---|---|");
      for (const claim of run.claims) {
        const evidence = (claim.review.evidence as Array<Record<string, unknown>>).map(item => `${item.basis}: ${item.url} ${item.location}${item.quote ? ` “${item.quote}”` : ""}${item.changedSinceRun ? " (changed since run)" : ""}`).join("; ");
        lines.push(`| ${claim.claimId} | ${claim.key ? "yes" : "no"} | ${claim.kind ?? claim.section}${claim.evidenceLevel ? ` / ${claim.evidenceLevel}` : ""} | ${cell(claim.text)} | ${claim.sources.map(source => `${source.sourceId ?? "?"}→${source.displayNumber ?? "?"}`).join(", ") || "none"} | ${[...new Set(claim.sources.map(source => source.modelSaw))].join(", ") || "n/a"} | ${claim.review.verdict}${claim.review.contradicted ? " (contradicted)" : ""} [${claim.reviewSource}] | ${cell([claim.review.reason, evidence].filter(Boolean).join(" — "))} |`);
      }
    }
  }
  if (review.rejectedVerdicts.length) {
    lines.push("", "## Refused verdicts", "", "| File | Run | Claim / requirement | Reason |", "|---|---|---|---|");
    for (const entry of review.rejectedVerdicts) lines.push(`| ${entry.file} | ${cell(entry.runIdentity)} | ${entry.claimId ?? entry.requirementId ?? ""} | ${entry.reason} |`);
  }
  if (review.anomalies.length) lines.push("", "## Input anomalies", "", ...review.anomalies.map(entry => `- ${entry}`));
  return lines.join("\n") + "\n";
}
