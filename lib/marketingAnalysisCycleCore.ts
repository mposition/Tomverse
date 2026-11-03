/**
 * One run of the analysis and brief (operator decision 2026-11-01), between
 * A3 and A5: what Tomverse is, then where it stands and this week's brief,
 * then one signed `brief` report carrying the analysis beside it. Pure
 * orchestration over ports, so the worker and the tests drive the same code.
 *
 * **Off unless the Admin switch is on**, read from the app's context, and the
 * ledger refuses a `brief` reservation while it is off, so a worker that
 * disagrees spends nothing.
 *
 * **It stops rather than presses on**, as A3 and A5 do: a refused reservation
 * refuses every later call too, and an unknown outcome is a thing a person
 * looks at (agent foundation rule 7). An answer that came back but cannot be
 * used is not a stop: the call is settled, the run records no brief, and A5
 * writes as it did before.
 *
 * **The report is the one thing it resends**: the same signed bytes.
 *
 * Imports node built-ins, zod and relative modules only, so the service loads
 * it with `--experimental-strip-types`.
 */

import { createHash } from "node:crypto";

import { z } from "zod";

import {
  MARKETING_ANALYSIS_PROMPT_VERSION,
  marketingCompetitiveAnalysisMessages,
  marketingSelfAnalysisMessages,
  readMarketingCompetitiveAnalysis,
  readMarketingSelfAnalysis,
  type MarketingAnalysisMarketFact,
  type MarketingAnalysisMarketFeature,
  type MarketingAnalysisPayload,
  type MarketingAnalysisRefusal,
} from "./marketingAnalysisCore.ts";
import { marketingGeneratorReportProvenance, type MarketingGeneratorReport } from "./marketingIntelReportCore.ts";
import type { MarketingLlmCallOutcome, MarketingLlmMessage } from "./marketingLlmClientCore.ts";

/** Time a call is not started without: one reservation, one answer, and the report after it. */
export const MARKETING_ANALYSIS_CALL_BUDGET_MS = 90_000;

/** Time the report is not sent without; past it the route would refuse it as late. */
export const MARKETING_ANALYSIS_REPORT_MARGIN_MS = 30_000;

/** Sends of the signed report when its answer is lost or a 5xx: the first and two resends. */
export const MARKETING_ANALYSIS_SUBMIT_ATTEMPTS = 3;
export const MARKETING_ANALYSIS_SUBMIT_BACKOFF_MS = [2_000, 5_000] as const;

/** The report's id within a run: one brief per run. */
export const MARKETING_ANALYSIS_REPORT_ID = "analysis-brief";

export type MarketingAnalysisCycleDeps = {
  /** The app's context route, answered as JSON. Throws when there is no answer. */
  readonly readContext: () => Promise<unknown>;
  /** One ledger-accounted text call for the `brief` purpose. */
  readonly callLlm: (messages: readonly MarketingLlmMessage[], requestKey: string) => Promise<MarketingLlmCallOutcome>;
  /** The report route. Throws when there is no answer. */
  readonly submitReport: (
    report: MarketingGeneratorReport,
  ) => Promise<{ readonly httpStatus: number; readonly body: Record<string, unknown> }>;
  readonly secret: string;
  readonly newId: () => string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

export type MarketingAnalysisCycleSummary = {
  readonly calls: number;
  /** Why an answer that came back could not be used, or null. */
  readonly unusable: null | MarketingAnalysisRefusal | "self_unreadable";
  readonly claimIds: number;
  /** The report route's answer, or null when nothing was reported. */
  readonly report: null | { readonly httpStatus: number; readonly status: string };
  readonly stoppedAt:
    | null
    | { readonly stage: "disabled" | "context" | "deadline" | "llm" | "submit"; readonly detail: string };
};

/** What this run reads from the context answer; everything else in it is ignored. */
const contextSchema = z.object({
  claims: z.array(
    z.object({
      id: z.string(),
      type: z.string(),
      locales: z.array(z.string()),
      statements: z.record(z.string(), z.string()).optional(),
      values: z.unknown().optional(),
    }),
  ),
  competitors: z
    .object({ tracked: z.array(z.object({ competitorId: z.string(), displayName: z.string() })) })
    .optional(),
  ownProduct: z.object({ plans: z.unknown() }).passthrough().optional(),
  analysis: z.object({ enabled: z.boolean() }).optional(),
  // Optional so a service deployed before the app still reads an older answer.
  recentBriefTopics: z.array(z.string()).optional(),
});

const canonical = (value: unknown): unknown => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, inner]) => [key, canonical(inner)]),
    );
  }
  return value;
};

/** The digest the brief records as the source it rests on: the analysis it was chosen from. */
export const marketingAnalysisDigest = (analysis: MarketingAnalysisPayload): string =>
  createHash("sha256")
    .update(JSON.stringify(canonical({ domain: "marketing-analysis-v1", analysis })), "utf8")
    .digest("hex");

/** The signed `brief` report, with the analysis beside its payload. */
export function marketingAnalysisReportBody(
  secret: string,
  input: {
    readonly generatorRunId: string;
    readonly reportId: string;
    readonly periodStart: string;
    readonly periodEnd: string;
    readonly deadlineAt: string;
    readonly analysis: MarketingAnalysisPayload;
  },
): MarketingGeneratorReport {
  const unsigned = {
    generatorRunId: input.generatorRunId,
    reportId: input.reportId,
    kind: "brief" as const,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    deadlineAt: input.deadlineAt,
    payload: {
      topicIds: [input.analysis.topicId],
      claimIds: [...input.analysis.claimIds],
      sourceDigests: [marketingAnalysisDigest(input.analysis)],
    },
    analysis: input.analysis,
  };
  return { ...unsigned, provenance: marketingGeneratorReportProvenance(secret, unsigned) } as MarketingGeneratorReport;
}

export async function runMarketingAnalysisCycle(
  input: {
    readonly generatorRunId: string;
    readonly deadlineAt: string;
    /** What A3 kept this run, in memory; empty when A3 found nothing or did not finish. */
    readonly market: {
      readonly facts: readonly MarketingAnalysisMarketFact[];
      readonly features: readonly MarketingAnalysisMarketFeature[];
    };
  },
  deps: MarketingAnalysisCycleDeps,
): Promise<MarketingAnalysisCycleSummary> {
  const startedAt = new Date(deps.now()).toISOString();
  let calls = 0;
  let claimIds = 0;
  const summary = (
    stoppedAt: MarketingAnalysisCycleSummary["stoppedAt"],
    unusable: MarketingAnalysisCycleSummary["unusable"] = null,
    report: MarketingAnalysisCycleSummary["report"] = null,
  ): MarketingAnalysisCycleSummary => ({ calls, unusable, claimIds, report, stoppedAt });

  let context: z.infer<typeof contextSchema>;
  try {
    const parsed = contextSchema.safeParse(await deps.readContext());
    if (!parsed.success) return summary({ stage: "context", detail: "context_unreadable" });
    context = parsed.data;
  } catch {
    return summary({ stage: "context", detail: "context_unavailable" });
  }
  if (context.analysis?.enabled !== true) return summary({ stage: "disabled", detail: "analysis_switch_off" });

  const deadline = Date.parse(input.deadlineAt);
  // Every call ends the same ways: anything but a settled answer ends the run.
  const ask = async (
    messages: readonly MarketingLlmMessage[],
  ): Promise<{ readonly content: string } | { readonly stop: MarketingAnalysisCycleSummary }> => {
    if (deadline - deps.now() < MARKETING_ANALYSIS_CALL_BUDGET_MS) {
      return { stop: summary({ stage: "deadline", detail: "deadline_too_close" }) };
    }
    calls += 1;
    let outcome: MarketingLlmCallOutcome;
    try {
      outcome = await deps.callLlm(messages, deps.newId());
    } catch {
      return { stop: summary({ stage: "llm", detail: "threw" }) };
    }
    // The switch turned off after the context was read: the ledger said no
    // before anything was sent, and only this step is off -- A5's calls are
    // another purpose, so the run goes on without a brief.
    if (outcome.status === "refused" && outcome.code === "purpose_disabled") {
      return { stop: summary({ stage: "disabled", detail: "reserve:purpose_disabled" }) };
    }
    if (outcome.status === "refused") return { stop: summary({ stage: "llm", detail: `${outcome.stage}:${outcome.code}` }) };
    if (outcome.status !== "answered") return { stop: summary({ stage: "llm", detail: outcome.status }) };
    return { content: outcome.content };
  };

  const self = await ask(marketingSelfAnalysisMessages(context.ownProduct ?? null));
  if ("stop" in self) return self.stop;
  const reading = readMarketingSelfAnalysis(self.content);
  if (reading === null) return summary(null, "self_unreadable");

  const competitors = context.competitors?.tracked ?? [];
  const tracked = new Set(competitors.map((competitor) => competitor.competitorId));
  const facts = input.market.facts.filter((fact) => tracked.has(fact.competitorId));
  const features = input.market.features.filter((feature) => tracked.has(feature.competitorId));
  const competitive = await ask(
    marketingCompetitiveAnalysisMessages({
      plans: context.ownProduct?.plans ?? null,
      self: reading,
      competitors,
      facts,
      features,
      claims: context.claims.map((claim) => ({
        id: claim.id,
        type: claim.type,
        locales: claim.locales,
        statement: claim.statements?.en ?? null,
        values: claim.values ?? null,
      })),
      recentTopics: context.recentBriefTopics ?? [],
    }),
  );
  if ("stop" in competitive) return competitive.stop;
  const read = readMarketingCompetitiveAnalysis(competitive.content, {
    claimIds: context.claims.map((claim) => claim.id),
    competitors,
  });
  if (!read.ok) return summary(null, read.refusal);
  claimIds = read.claimIds.length;

  if (deadline - deps.now() < MARKETING_ANALYSIS_REPORT_MARGIN_MS) {
    return summary({ stage: "deadline", detail: "report_deadline_too_close" });
  }
  const report = marketingAnalysisReportBody(deps.secret, {
    generatorRunId: input.generatorRunId,
    reportId: MARKETING_ANALYSIS_REPORT_ID,
    periodStart: startedAt,
    periodEnd: new Date(deps.now()).toISOString(),
    deadlineAt: input.deadlineAt,
    analysis: {
      promptVersion: MARKETING_ANALYSIS_PROMPT_VERSION,
      self: reading,
      competitive: read.competitive,
      topicId: read.topicId,
      claimIds: read.claimIds,
      competitorIds: [...new Set(facts.map((fact) => fact.competitorId))].sort(),
      factCount: facts.length,
      featureCount: features.length,
    },
  });

  let answer: { readonly httpStatus: number; readonly body: Record<string, unknown> } | null = null;
  for (let attempt = 0; attempt < MARKETING_ANALYSIS_SUBMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.sleep(MARKETING_ANALYSIS_SUBMIT_BACKOFF_MS[attempt - 1] ?? 5_000);
    try {
      answer = await deps.submitReport(report);
    } catch {
      answer = null;
      continue;
    }
    // A 4xx is this report's fault, and sending it again changes nothing.
    if (answer.httpStatus < 500) break;
  }
  if (answer === null) return summary({ stage: "submit", detail: "outcome_unknown" });
  const result = (answer.body.result as { status?: unknown } | undefined)?.status;
  const status = typeof result === "string" ? result : "unreadable";
  const reported = { httpStatus: answer.httpStatus, status };
  if (answer.httpStatus !== 200 || status !== "recorded") {
    return summary({ stage: "submit", detail: `http_${answer.httpStatus}:${status}` }, null, reported);
  }
  return summary(null, null, reported);
}
