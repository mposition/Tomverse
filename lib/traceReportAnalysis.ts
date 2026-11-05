/**
 * Reports with a verified trace get a real analysis on the fifteen-minute
 * maintenance cron, and, when the owner allows it, a draft PR through the AMUX
 * idea lane (docs/policy/trace-feedback-automation.md §8a).
 *
 * Off by default. The Admin console holds one mode:
 *   off      nothing runs and nothing is spent;
 *   analyze  one call of the support-triage model per report;
 *            Needs support triage on with a model, and FEEDBACK_AUTOFIX_SHADOW_ENABLED,
 *            the kill switch that makes new reports into cases at all.
 *   fix      also hands what the model calls a code defect to the lane. The
 *            owner who chose it is saved with it: the ideas' data owner, under
 *            a system audit entry, and they stop when that account stops being
 *            an owner.
 *
 * Never throws, so it cannot disturb the cron it rides on.
 */
import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { isAdminOwnerAccount } from "@/lib/adminAuth";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError } from "@/lib/amux/ideaSubmissionService";
import { submitIdeaFromTraceReport } from "@/lib/amux/ideaTraceReportSubmissionService";
import { runFeedbackAutoFixShadowWorker } from "@/lib/feedbackAutoFixShadow";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import { resolveSupportTriageEnabled, resolveSupportTriageLlmModel } from "@/lib/supportTriageLlmSetting";
import {
  TRACE_ANALYSIS_CONFIDENCES,
  TRACE_ANALYSIS_KINDS,
  TRACE_ANALYSIS_MAX_ATTEMPTS,
  TRACE_ANALYSIS_PER_DAY,
  TRACE_ANALYSIS_PER_PASS,
  TRACE_ANALYSIS_SYSTEM,
  TRACE_ANALYSIS_WINDOW_DAYS,
  TRACE_FIX_HANDOFFS_PER_DAY,
  TRACE_FIX_NEVER_CLASSIFICATIONS,
  parseTraceAnalysisAnswer,
  readStoredTraceAnalysis,
  traceAnalysisPrompt,
  traceAnalysisWantsFix,
  traceFixIdea,
  traceFixRequestId,
  type StoredTraceAnalysis,
  type TraceAnalysisAnswer,
  type TraceAnalysisFacts,
} from "@/lib/traceReportAnalysisCore";

const DAY_MS = 24 * 60 * 60_000;
/** Cases one pass reads; each has work left, and one pass does at most TRACE_ANALYSIS_PER_PASS calls. */
const WORK_SCAN = 50;
/** A model call's timeout and the writes around it; a pass cut short by a deploy lapses here. */
const CLAIM_MS = 2 * 60_000;
const MAX_OUTPUT_TOKENS = 800;
const TIMEOUT_MS = 60_000;
const INCIDENT_COOLDOWN_MS = 6 * 60 * 60_000;

export const TRACE_ANALYSIS_MODE_SETTING_KEY = "traceReportAnalysis.mode";
/** {day, analyses, handoffs} for the UTC day, moved only by `reserve`. */
export const TRACE_ANALYSIS_USAGE_SETTING_KEY = "traceReportAnalysis.usage";
export const TRACE_ANALYSIS_MODES = ["off", "analyze", "fix"] as const;
export type TraceAnalysisMode = (typeof TRACE_ANALYSIS_MODES)[number];

/** The saved mode, and for fix the owner who chose it. A missing or unknown row is off. */
export const readTraceAnalysisMode = async (): Promise<{ mode: TraceAnalysisMode; ownerUserId: string | null }> => {
  const row = await prisma.appSetting.findUnique({
    where: { key: TRACE_ANALYSIS_MODE_SETTING_KEY },
    select: { value: true },
  });
  const value = row?.value ?? "";
  if (value === "analyze") return { mode: "analyze", ownerUserId: null };
  if (value.startsWith("fix:") && value.length > 4) return { mode: "fix", ownerUserId: value.slice(4) };
  return { mode: "off", ownerUserId: null };
};

/** The caller checked the owner and a recent sign-in, as for the triage switch. */
export const writeTraceAnalysisMode = async (input: { session: Session; request: Request; mode: TraceAnalysisMode }) => {
  const userId = input.session.user?.id;
  if (!userId) throw new Error("trace_analysis_mode_needs_a_user");
  const value = input.mode === "fix" ? `fix:${userId}` : input.mode;
  await prisma.$transaction(async (tx) => {
    await tx.appSetting.upsert({
      where: { key: TRACE_ANALYSIS_MODE_SETTING_KEY },
      create: { key: TRACE_ANALYSIS_MODE_SETTING_KEY, value },
      update: { value },
    });
    await writeAdminAuditLog({
      tx,
      session: input.session,
      request: input.request,
      action: "trace_report_analysis.mode_updated",
      targetType: "AppSettings",
      targetId: TRACE_ANALYSIS_MODE_SETTING_KEY,
      summary: `Trace report analysis set to ${input.mode}`,
      metadata: { mode: input.mode },
    });
  });
  return { mode: input.mode };
};

export type TraceAnalysisLlm = (facts: TraceAnalysisFacts) => Promise<(TraceAnalysisAnswer & { modelId: string }) | null>;

const OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind", "confidence", "cause", "recommendation"],
  properties: {
    kind: { type: "string", enum: [...TRACE_ANALYSIS_KINDS] },
    confidence: { type: "string", enum: [...TRACE_ANALYSIS_CONFIDENCES] },
    cause: { type: "string" },
    recommendation: { type: "string" },
  },
} as const;

/** The model support triage uses, or null when the Admin console has it off. */
const traceAnalysisLlmFromSettings = async (): Promise<TraceAnalysisLlm | null> => {
  const { modelId } = await resolveSupportTriageLlmModel(process.env);
  const model = modelId ? await getEnabledRuntimeModel(modelId) : null;
  if (!model) return null;
  return async (facts) => {
    try {
      const generated = await generateText({
        model: getActiveAiModel(model),
        system: TRACE_ANALYSIS_SYSTEM,
        prompt: traceAnalysisPrompt(facts),
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(TIMEOUT_MS),
        output: Output.object({
          schema: jsonSchema(OUTPUT_SCHEMA as unknown as JSONSchema7),
          name: "trace_report_analysis",
        }),
        providerOptions: { openai: { strictJsonSchema: true } },
      });
      const usage = generated.usage as { inputTokens?: number; outputTokens?: number } | undefined;
      console.info(
        JSON.stringify({
          event: "trace_report_analysis_call",
          modelId: model.id,
          inputTokens: usage?.inputTokens ?? null,
          outputTokens: usage?.outputTokens ?? null,
        })
      );
      const answer = parseTraceAnalysisAnswer(generated.output);
      return answer ? { ...answer, modelId: model.id } : null;
    } catch (error) {
      console.warn(
        JSON.stringify({
          event: "trace_report_analysis_call_failed",
          modelId: model.id,
          error: error instanceof Error ? error.name : "unknown",
        })
      );
      return null;
    }
  };
};

type CaseRow = {
  id: string;
  traceId: string;
  classification: string | null;
  ineligibilityReason: string | null;
  fingerprint: string | null;
  sourceRelease: string | null;
  diagnosticSummary: Prisma.JsonValue;
};

const CASE_SELECT = {
  id: true,
  traceId: true,
  classification: true,
  ineligibilityReason: true,
  fingerprint: true,
  sourceRelease: true,
  diagnosticSummary: true,
} as const;

/**
 * What the model and the idea may read of the summary. An allowlist: with no
 * evidence row, summary.errorCode holds the client's own error code, which is
 * free text the reporter controls. The error code they get is the fingerprint's,
 * from the signed token.
 */
const SENT = ["classificationSource", "routeClass", "phase", "httpStatus", "provider", "modelId", "retryable", "release", "environment", "occurredAt", "providerEventCount", "limitEventCount"];

const summaryOf = (row: CaseRow) => (row.diagnosticSummary ?? {}) as Record<string, unknown>;
const serverErrorCodeOf = (row: CaseRow) => {
  const code = row.fingerprint?.split("|")[0];
  return code && code !== "unclassified" ? code : null;
};

const recordedSummary = (row: CaseRow) =>
  Object.fromEntries(Object.entries(summaryOf(row)).filter(([key]) => SENT.includes(key)));

const factsOf = async (row: CaseRow): Promise<TraceAnalysisFacts> => {
  // Coded fields only: a provider's message can quote what the user sent.
  const [providerEvents, limitEvents] = await Promise.all([
    prisma.providerErrorEvent.findMany({
      where: { traceId: row.traceId },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { provider: true, modelId: true, phase: true, diagnosticCode: true, errorName: true, errorCode: true, httpStatus: true, retryable: true },
    }),
    prisma.chatLimitDecisionEvent.findMany({
      where: { traceId: row.traceId },
      take: 5,
      orderBy: { createdAt: "desc" },
      select: { phase: true, decision: true, errorCode: true, limitLayer: true, limitScope: true },
    }),
  ]);
  return {
    classification: row.classification,
    reason: row.ineligibilityReason,
    serverErrorCode: serverErrorCodeOf(row),
    sourceRelease: row.sourceRelease,
    summary: recordedSummary(row),
    providerEvents,
    limitEvents,
  };
};

/** Only the pass still holding the claim writes: one whose claim lapsed and was taken writes nothing. */
const store = (row: CaseRow, analysis: StoredTraceAnalysis) => {
  const claim = summaryOf(row).llmAnalysisClaim;
  return prisma.feedbackAutoFixCase.updateMany({
    where: {
      id: row.id,
      ...(typeof claim === "string" ? { diagnosticSummary: { path: ["llmAnalysisClaim"], equals: claim } } : {}),
    },
    data: { diagnosticSummary: { ...summaryOf(row), llmAnalysis: analysis } as Prisma.InputJsonObject },
  });
};

export type TraceFixSubmit = (input: { ownerUserId: string; caseId: string; requestId: string; idea: string }) => Promise<{ ideaId: string }>;

export const submitTraceFix: TraceFixSubmit = async ({ ownerUserId, caseId, requestId, idea }) => {
  const user = await prisma.user.findUnique({ where: { id: ownerUserId }, select: { id: true, email: true } });
  if (!user || !isAdminOwnerAccount(user)) throw new IdeaSubmissionError("forbidden", 403);
  const inspected = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea, repositories: [], pullRequests: [] } })
  );
  if (!inspected.ok) throw new Error(`trace_fix_idea_refused_${inspected.code}`);
  return submitIdeaFromTraceReport({ ownerUserId, caseId, inspected });
};

const incident = (code: string, title: string, error: unknown) =>
  reportOperationalIncident({
    code,
    title,
    // The name only: a database error can quote the row it failed on.
    error: error instanceof Error ? error.name : "unknown",
    cooldownMs: INCIDENT_COOLDOWN_MS,
    context: { component: "trace-report-analysis" },
  }).catch(() => undefined);

export type TraceAnalysisPass = { mode: TraceAnalysisMode; analyzed: number; failed: number; handedOff: number };

const attemptsOf = (summary: Record<string, unknown>) =>
  typeof summary.llmAnalysisAttempts === "number" ? summary.llmAnalysisAttempts : 0;

type Usage = { day: string; analyses: number; handoffs: number };

const readUsage = async (tx: Prisma.TransactionClient, day: string): Promise<Usage> => {
  const row = await tx.appSetting.findUnique({ where: { key: TRACE_ANALYSIS_USAGE_SETTING_KEY }, select: { value: true } });
  try {
    const usage = JSON.parse(row?.value ?? "") as Usage;
    if (usage.day === day) return usage;
  } catch {
    // No row, or one nothing here wrote: today starts empty.
  }
  return { day, analyses: 0, handoffs: 0 };
};

/**
 * Reserves one paid step before it runs, under a lock every pass takes: the
 * day's count goes up and the case is claimed for CLAIM_MS, so overlapping
 * passes cannot call twice or read the same room under the limit. The case's
 * attempts go up here too: a reservation is spent even if the step then fails or
 * the process dies, as the call may have been billed. A handoff reserves once
 * per case and day: its retries reuse one idea.
 */
const reserve = async (caseId: string, step: "analysis" | "handoff", now: Date): Promise<CaseRow | null> =>
  prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('trace_report_analysis'))`;
    const row = await tx.feedbackAutoFixCase.findUnique({ where: { id: caseId }, select: CASE_SELECT });
    if (!row) return null;
    const summary = summaryOf(row);
    const analysis = readStoredTraceAnalysis(summary);
    if (step === "analysis") {
      const claimedUntil = summary.llmAnalysisClaimUntil;
      if (typeof claimedUntil === "string" && Date.parse(claimedUntil) > now.getTime()) return null;
      if (analysis?.status === "done" || attemptsOf(summary) >= TRACE_ANALYSIS_MAX_ATTEMPTS) return null;
    } else if (!traceAnalysisWantsFix(row.classification, analysis)) {
      return null;
    }
    const day = now.toISOString().slice(0, 10);
    // A retry today spends nothing; one from an earlier day counts again, so a
    // backlog of failed submits cannot all land on the day submitting works.
    const alreadyReserved = step === "handoff" && summary.llmHandoffReservedDay === day;
    if (!alreadyReserved) {
      const usage = await readUsage(tx, day);
      if (step === "analysis" ? usage.analyses >= TRACE_ANALYSIS_PER_DAY : usage.handoffs >= TRACE_FIX_HANDOFFS_PER_DAY) return null;
      const value = JSON.stringify(
        step === "analysis" ? { ...usage, analyses: usage.analyses + 1 } : { ...usage, handoffs: usage.handoffs + 1 }
      );
      await tx.appSetting.upsert({
        where: { key: TRACE_ANALYSIS_USAGE_SETTING_KEY },
        create: { key: TRACE_ANALYSIS_USAGE_SETTING_KEY, value },
        update: { value },
      });
    }
    const claimed =
      step === "analysis"
        ? {
            ...summary,
            llmAnalysisClaim: randomUUID(),
            llmAnalysisClaimUntil: new Date(now.getTime() + CLAIM_MS).toISOString(),
            llmAnalysisAttempts: attemptsOf(summary) + 1,
          }
        : { ...summary, llmHandoffReservedDay: day };
    await tx.feedbackAutoFixCase.update({
      where: { id: caseId },
      data: { diagnosticSummary: claimed as Prisma.InputJsonObject },
    });
    return { ...row, diagnosticSummary: claimed as Prisma.JsonObject };
  });

/** Only cases with work left, so finished ones can never crowd out a new report. */
const readWork = (mode: TraceAnalysisMode, since: Date) =>
  prisma.$queryRaw<{ id: string }[]>`
    SELECT c."id" FROM "FeedbackAutoFixCase" c
    WHERE c."classification" IS NOT NULL AND c."createdAt" > ${since}
      AND ((COALESCE(c."diagnosticSummary"->'llmAnalysis'->>'status', '') <> 'done'
          AND COALESCE((c."diagnosticSummary"->>'llmAnalysisAttempts')::int, 0) < ${TRACE_ANALYSIS_MAX_ATTEMPTS})
        OR (${mode === "fix"} AND c."diagnosticSummary"->'llmAnalysis'->>'status' = 'done'
          AND c."diagnosticSummary"->'llmAnalysis'->>'kind' = 'code_fix'
          AND c."diagnosticSummary"->'llmAnalysis'->>'confidence' <> 'low'
          AND c."diagnosticSummary"->'llmAnalysis'->'handoff' IS NULL
          AND c."classification" <> ALL(${[...TRACE_FIX_NEVER_CLASSIFICATIONS]}::text[])))
    ORDER BY c."createdAt" ASC, c."id" ASC
    LIMIT ${WORK_SCAN}`;

export const runTraceReportAnalysisQuietly = async ({
  llm,
  submit = submitTraceFix,
  now: start = new Date(),
}: {
  /** Replaces the configured model (tests). */
  llm?: TraceAnalysisLlm | null;
  submit?: TraceFixSubmit;
  now?: Date;
} = {}): Promise<TraceAnalysisPass> => {
  const pass: TraceAnalysisPass = { mode: "off", analyzed: 0, failed: 0, handedOff: 0 };
  // Calls take up to a minute each: every claim and stamp reads the time it happens.
  const startedAt = Date.now();
  const now = () => new Date(start.getTime() + Date.now() - startedAt);
  try {
    const { mode, ownerUserId } = await readTraceAnalysisMode();
    pass.mode = mode;
    if (mode === "off") return pass;
    // Support triage's own switch stops this too: its Off means no paid calls here.
    if (!(await resolveSupportTriageEnabled(process.env)).enabled) return pass;
    // The classifying pass otherwise waits for the daily cleanup.
    await runFeedbackAutoFixShadowWorker();
    const call = llm === undefined ? await traceAnalysisLlmFromSettings() : llm;
    // Off in the console stops everything this pass would start, handoffs included.
    if (!call) return pass;
    const work = await readWork(mode, new Date(now().getTime() - TRACE_ANALYSIS_WINDOW_DAYS * DAY_MS));
    let called = 0;
    let handoffsOpen = mode === "fix" && Boolean(ownerUserId);
    for (const { id } of work) {
      const current = await prisma.feedbackAutoFixCase.findUnique({ where: { id }, select: CASE_SELECT });
      if (!current) continue;
      let analysis = readStoredTraceAnalysis(current.diagnosticSummary);
      let row: CaseRow = current;
      if (analysis?.status !== "done" && called < TRACE_ANALYSIS_PER_PASS) {
        const reserved = await reserve(id, "analysis", now());
        if (reserved) {
          called += 1;
          row = reserved;
          const answer = await call(await factsOf(row));
          const at = now().toISOString();
          analysis = answer
            ? { status: "done", at, ...answer }
            : { status: "failed", at, attempts: attemptsOf(summaryOf(row)) };
          await store(row, analysis);
          row = { ...row, diagnosticSummary: { ...summaryOf(row), llmAnalysis: analysis } as Prisma.JsonObject };
          if (answer) pass.analyzed += 1;
          else pass.failed += 1;
        }
      }
      if (!handoffsOpen || !ownerUserId || analysis?.status !== "done") continue;
      if (!traceAnalysisWantsFix(row.classification, analysis)) continue;
      const reserved = await reserve(id, "handoff", now());
      if (!reserved) continue;
      try {
        const { ideaId } = await submit({
          ownerUserId,
          caseId: id,
          requestId: traceFixRequestId(id),
          idea: traceFixIdea({
            caseId: id,
            serverErrorCode: serverErrorCodeOf(reserved),
            sourceRelease: reserved.sourceRelease,
            summary: recordedSummary(reserved),
            analysis,
          }),
        });
        pass.handedOff += 1;
        await store(reserved, { ...analysis, handoff: { ideaId, at: now().toISOString() } });
      } catch (error) {
        // Tried again next tick with the same request id, which finds a first
        // submit whose answer was lost. Later cases would fail the same way, so
        // this pass stops handing over but still analyses them.
        handoffsOpen = false;
        await incident("TRACE_REPORT_FIX_HANDOFF_FAILED", "A traced report could not be handed to the idea lane", error);
      }
    }
  } catch (error) {
    await incident("TRACE_REPORT_ANALYSIS_FAILED", "A trace report analysis pass failed", error);
  }
  return pass;
};
