/**
 * Reports with a verified trace get a real analysis on the fifteen-minute
 * maintenance cron, and, when the owner allows it, a draft PR through the AMUX
 * idea lane (docs/policy/trace-feedback-automation.md §8a).
 *
 * Off by default. The Admin console holds one mode:
 *   off      nothing runs and nothing is spent;
 *   analyze  one call of the support-triage model per report;
 *   fix      also hands what the model calls a code defect to the lane. The
 *            owner who chose it is saved with it: the ideas are theirs, and
 *            they stop when that account stops being an owner.
 *
 * Never throws, so it cannot disturb the cron it rides on.
 */
import "server-only";

import { generateText, jsonSchema, Output } from "ai";
import type { JSONSchema7 } from "@ai-sdk/provider";
import type { Prisma } from "@prisma/client";
import type { Session } from "next-auth";

import { getActiveAiModel } from "@/lib/activeAiModel";
import { writeAdminAuditLog } from "@/lib/adminAudit";
import { inspectAmuxIdeaSubmission } from "@/lib/amux/ideaSubmissionCore";
import { IdeaSubmissionError, submitIdea } from "@/lib/amux/ideaSubmissionService";
import { runFeedbackAutoFixShadowWorker } from "@/lib/feedbackAutoFixShadow";
import { getEnabledRuntimeModel } from "@/lib/modelRegistry";
import { reportOperationalIncident } from "@/lib/operationalMonitoring";
import { prisma } from "@/lib/prisma";
import { resolveSupportTriageLlmModel } from "@/lib/supportTriageLlmSetting";
import {
  TRACE_ANALYSIS_CONFIDENCES,
  TRACE_ANALYSIS_KINDS,
  TRACE_ANALYSIS_MAX_ATTEMPTS,
  TRACE_ANALYSIS_PER_DAY,
  TRACE_ANALYSIS_PER_PASS,
  TRACE_ANALYSIS_SYSTEM,
  TRACE_ANALYSIS_WINDOW_DAYS,
  TRACE_FIX_HANDOFFS_PER_DAY,
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
const SCAN = 200;
const MAX_OUTPUT_TOKENS = 800;
const TIMEOUT_MS = 60_000;
const INCIDENT_COOLDOWN_MS = 6 * 60 * 60_000;

export const TRACE_ANALYSIS_MODE_SETTING_KEY = "traceReportAnalysis.mode";
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

/** Identifiers of this occurrence, and the analysis itself. */
const NOT_SENT = ["traceId", "occurrenceId", "sentry", "llmAnalysis"];

const summaryOf = (row: CaseRow) => (row.diagnosticSummary ?? {}) as Record<string, unknown>;
const serverErrorCodeOf = (row: CaseRow) => {
  const code = row.fingerprint?.split("|")[0];
  return code && code !== "unclassified" ? code : null;
};

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
  const summary = Object.fromEntries(Object.entries(summaryOf(row)).filter(([key]) => !NOT_SENT.includes(key)));
  return {
    classification: row.classification,
    reason: row.ineligibilityReason,
    serverErrorCode: serverErrorCodeOf(row),
    sourceRelease: row.sourceRelease,
    summary,
    providerEvents,
    limitEvents,
  };
};

const store = (row: CaseRow, analysis: StoredTraceAnalysis) =>
  prisma.feedbackAutoFixCase.update({
    where: { id: row.id },
    data: { diagnosticSummary: { ...summaryOf(row), llmAnalysis: analysis } as Prisma.InputJsonObject },
  });

/** The saved owner's session for the idea they allowed, or null once that account is no longer one. */
const ownerSession = async (ownerUserId: string): Promise<Session | null> => {
  const user = await prisma.user.findUnique({ where: { id: ownerUserId }, select: { id: true, email: true } });
  if (!user?.email) return null;
  const session: Session = {
    user: { id: user.id, email: user.email, authenticatedAt: new Date().toISOString() },
    expires: new Date(Date.now() + 60_000).toISOString(),
  };
  return session;
};

export type TraceFixSubmit = (input: { ownerUserId: string; requestId: string; idea: string }) => Promise<{ ideaId: string }>;

export const submitTraceFix: TraceFixSubmit = async ({ ownerUserId, requestId, idea }) => {
  const session = await ownerSession(ownerUserId);
  if (!session) throw new IdeaSubmissionError("forbidden", 403);
  const inspected = inspectAmuxIdeaSubmission(
    JSON.stringify({ version: 1, requestId, input: { version: 1, idea, repositories: [], pullRequests: [] } })
  );
  if (!inspected.ok) throw new Error(`trace_fix_idea_refused_${inspected.code}`);
  const request = new Request("https://tomverse.app/internal/trace-report-analysis", { method: "POST" });
  try {
    return await submitIdea({ session, request, inspected });
  } catch (error) {
    // An earlier submit of this case got through, whatever it heard back.
    if (error instanceof IdeaSubmissionError && error.code === "request_already_seen") {
      const seen = await prisma.amuxIdeaSubmission.findUnique({ where: { requestId }, select: { id: true } });
      if (seen) return { ideaId: seen.id };
    }
    throw error;
  }
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

export const runTraceReportAnalysisQuietly = async ({
  llm,
  submit = submitTraceFix,
  now = new Date(),
}: {
  /** Replaces the configured model (tests). */
  llm?: TraceAnalysisLlm | null;
  submit?: TraceFixSubmit;
  now?: Date;
} = {}): Promise<TraceAnalysisPass> => {
  const pass: TraceAnalysisPass = { mode: "off", analyzed: 0, failed: 0, handedOff: 0 };
  try {
    const { mode, ownerUserId } = await readTraceAnalysisMode();
    pass.mode = mode;
    if (mode === "off") return pass;
    // The classifying pass otherwise waits for the daily cleanup.
    await runFeedbackAutoFixShadowWorker();
    const call = llm === undefined ? await traceAnalysisLlmFromSettings() : llm;
    const rows = await prisma.feedbackAutoFixCase.findMany({
      where: {
        classification: { not: null },
        createdAt: { gt: new Date(now.getTime() - TRACE_ANALYSIS_WINDOW_DAYS * DAY_MS) },
      },
      orderBy: { createdAt: "asc" },
      take: SCAN,
      select: {
        id: true,
        traceId: true,
        classification: true,
        ineligibilityReason: true,
        fingerprint: true,
        sourceRelease: true,
        diagnosticSummary: true,
      },
    });
    const since = now.getTime() - DAY_MS;
    const stored = rows.map((row) => ({ row, analysis: readStoredTraceAnalysis(row.diagnosticSummary) }));
    let analysesLeft = Math.max(
      0,
      TRACE_ANALYSIS_PER_DAY -
        stored.filter(({ analysis }) => analysis && Date.parse(analysis.at) > since).length
    );
    let handoffsLeft = Math.max(
      0,
      TRACE_FIX_HANDOFFS_PER_DAY -
        stored.filter(
          ({ analysis }) => analysis?.status === "done" && analysis.handoff && Date.parse(analysis.handoff.at) > since
        ).length
    );
    let examined = 0;
    for (const { row, analysis: found } of stored) {
      let analysis = found;
      const wanted =
        !analysis || (analysis.status === "failed" && analysis.attempts < TRACE_ANALYSIS_MAX_ATTEMPTS);
      if (wanted && call && analysesLeft > 0 && examined < TRACE_ANALYSIS_PER_PASS) {
        examined += 1;
        analysesLeft -= 1;
        const answer = await call(await factsOf(row));
        const at = now.toISOString();
        analysis = answer
          ? { status: "done", at, ...answer }
          : { status: "failed", at, attempts: (found?.status === "failed" ? found.attempts : 0) + 1 };
        await store(row, analysis);
        if (answer) pass.analyzed += 1;
        else pass.failed += 1;
      }
      if (mode !== "fix" || !ownerUserId || handoffsLeft <= 0) continue;
      if (analysis?.status !== "done" || !traceAnalysisWantsFix(row.classification, analysis)) continue;
      try {
        const { ideaId } = await submit({
          ownerUserId,
          requestId: traceFixRequestId(row.id),
          idea: traceFixIdea({
            caseId: row.id,
            serverErrorCode: serverErrorCodeOf(row),
            sourceRelease: row.sourceRelease,
            summary: summaryOf(row),
            analysis,
          }),
        });
        handoffsLeft -= 1;
        pass.handedOff += 1;
        await store(row, { ...analysis, handoff: { ideaId, at: now.toISOString() } });
      } catch (error) {
        // Tried again next tick with the same request id, which finds a first
        // submit whose answer was lost. Later cases would fail the same way.
        await incident("TRACE_REPORT_FIX_HANDOFF_FAILED", "A traced report could not be handed to the idea lane", error);
        break;
      }
    }
  } catch (error) {
    await incident("TRACE_REPORT_ANALYSIS_FAILED", "A trace report analysis pass failed", error);
  }
  return pass;
};
