/**
 * One run of A3, market intelligence (S3 plan, S3f): every approved competitor,
 * one web-search call each through the LLM cost ledger -- the search limited
 * to the competitor's official domains -- then one unrestricted web-search
 * call for competitors the registry does not have (S3f-R5c), and one signed
 * `market_intel` report of everything kept. Pure
 * orchestration over ports, so the worker and the tests drive the same code.
 *
 * **It stops rather than presses on**, as A5's run does: a refused reservation
 * refuses every later call too, and an unknown outcome is a thing a person
 * looks at (agent foundation rule 7). A stopped run reports nothing -- a
 * report built from part of a run would read as a whole one. Reaching its
 * deadline is a stop too; the worker then carries on with A5, which has its
 * own time, while an unknown outcome stops the worker as well.
 *
 * **The report is the one thing it resends**: the same signed bytes, which
 * the report route reads back if they already landed, never a new call.
 *
 * Imports node built-ins and relative modules only, so the service loads it
 * with `--experimental-strip-types`.
 */

import {
  MARKETING_A3_ANSWER_SCHEMA,
  MARKETING_A3_DISCOVERY_ANSWER_SCHEMA,
  marketingA3DiscoveryMessages,
  marketingA3Messages,
  marketingA3ReportBody,
  readMarketingA3Answer,
  readMarketingA3Discovery,
  type MarketIntelFact,
  type MarketingA3CandidateDropReason,
  type MarketingA3DropReason,
} from "./marketingA3Core.ts";
import type { MarketingCompetitorCandidate } from "./marketingCompetitorCore.ts";
import {
  MARKETING_INTEL_REPORT_MAX_BODY_BYTES,
  type MarketingGeneratorReport,
} from "./marketingIntelReportCore.ts";
import type { MarketingLlmAnswerSchema, MarketingLlmCallOutcome, MarketingLlmMessage } from "./marketingLlmClientCore.ts";

/** Time a competitor is not started without: one web-search call and the report. */
export const MARKETING_A3_COMPETITOR_BUDGET_MS = 90_000;

/** Sends of the signed report when its answer is lost or a 5xx: the first and two resends. */
export const MARKETING_A3_SUBMIT_ATTEMPTS = 3;

/** The wait before each resend. */
export const MARKETING_A3_SUBMIT_BACKOFF_MS = [2_000, 5_000] as const;

/** Facts one report holds (the payload schema's limit); the rest are counted. */
export const MARKETING_A3_REPORT_MAX_FACTS = 200;

/**
 * Time the report is not sent without. Past it the route would refuse the
 * report as too late, and a refused report stops the run; a report not sent
 * only means no market facts this run.
 */
export const MARKETING_A3_REPORT_MARGIN_MS = 30_000;

/** The report's serialised size limit, under the route's own with room to spare. */
const REPORT_BYTE_LIMIT = MARKETING_INTEL_REPORT_MAX_BODY_BYTES - 4 * 1024;

/** The report's id within a run: one A3 report per run. */
export const MARKETING_A3_REPORT_ID = "a3-web-search";

export type MarketingA3CycleDeps = {
  /** The app's context route, answered as JSON. Throws when there is no answer. */
  readonly readContext: () => Promise<unknown>;
  /**
   * One ledger-accounted web-search call for the `market_intel` purpose,
   * limited to these domains; no domains is the run's unrestricted discovery search.
   * The answer is held to the given schema.
   */
  readonly callLlm: (
    messages: readonly MarketingLlmMessage[],
    requestKey: string,
    allowedDomains: readonly string[],
    answerSchema: MarketingLlmAnswerSchema,
  ) => Promise<MarketingLlmCallOutcome>;
  /** The report route. Throws when there is no answer. */
  readonly submitReport: (
    report: MarketingGeneratorReport,
  ) => Promise<{ readonly httpStatus: number; readonly body: Record<string, unknown> }>;
  readonly secret: string;
  readonly newId: () => string;
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
};

export type MarketingA3CycleSummary = {
  readonly competitors: number;
  readonly calls: number;
  readonly factsKept: number;
  readonly unrepresentable: number;
  /** The facts the service did not keep, by reason (the model's own unrepresentable count is not here). */
  readonly dropped: Partial<Record<MarketingA3DropReason | "unreadable_answer", number>>;
  /** New competitors proposed for a person to approve, and the ones not kept, by reason. */
  readonly candidatesKept: number;
  readonly candidatesDropped: Partial<Record<MarketingA3CandidateDropReason | "unreadable_answer", number>>;
  /** The report route's answer, or null when nothing was reported. */
  readonly report: null | { readonly httpStatus: number; readonly status: string };
  readonly stoppedAt: null | { readonly stage: "context" | "deadline" | "llm" | "submit"; readonly detail: string };
};

type Registry = { readonly tracked: TrackedCompetitor[]; readonly knownIds: string[] };

type TrackedCompetitor = {
  readonly competitorId: string;
  readonly displayName: string;
  readonly officialHosts: readonly string[];
};

const strings = (list: unknown): list is string[] =>
  Array.isArray(list) && list.every((item) => typeof item === "string");

/**
 * The tracked competitors in a context answer, or null when the answer has
 * the field in a shape this run cannot read. An answer from an app older than
 * the registry has no field at all, and tracks nobody.
 */
function registryFrom(context: unknown): Registry | null {
  if (!context || typeof context !== "object") return null;
  const competitors = (context as { competitors?: unknown }).competitors;
  if (competitors === undefined) return { tracked: [], knownIds: [] };
  const tracked = (competitors as { tracked?: unknown } | null)?.tracked;
  const knownIds = (competitors as { knownIds?: unknown } | null)?.knownIds;
  if (!Array.isArray(tracked) || !strings(knownIds)) return null;
  const rows: TrackedCompetitor[] = [];
  for (const row of tracked) {
    const value = (row ?? {}) as Record<string, unknown>;
    if (
      typeof value.competitorId !== "string" ||
      typeof value.displayName !== "string" ||
      !strings(value.officialHosts)
    ) {
      return null;
    }
    rows.push({
      competitorId: value.competitorId,
      displayName: value.displayName,
      officialHosts: value.officialHosts,
    });
  }
  return {
    tracked: rows.sort((left, right) => (left.competitorId < right.competitorId ? -1 : 1)),
    knownIds: [...new Set([...knownIds, ...rows.map((row) => row.competitorId)])].sort(),
  };
}

export async function runMarketingA3Cycle(
  input: { readonly generatorRunId: string; readonly deadlineAt: string },
  deps: MarketingA3CycleDeps,
): Promise<MarketingA3CycleSummary> {
  const startedAt = new Date(deps.now()).toISOString();
  let competitors = 0;
  let calls = 0;
  let unrepresentable = 0;
  const dropped: Partial<Record<MarketingA3DropReason | "unreadable_answer", number>> = {};
  const facts: MarketIntelFact[] = [];
  const candidates: MarketingCompetitorCandidate[] = [];
  const candidatesDropped: MarketingA3CycleSummary["candidatesDropped"] = {};
  const summary = (
    stoppedAt: MarketingA3CycleSummary["stoppedAt"],
    report: MarketingA3CycleSummary["report"] = null,
  ): MarketingA3CycleSummary => ({
    competitors,
    calls,
    factsKept: facts.length,
    unrepresentable,
    dropped,
    candidatesKept: candidates.length,
    candidatesDropped,
    report,
    stoppedAt,
  });

  let registry: Registry | null;
  try {
    registry = registryFrom(await deps.readContext());
  } catch {
    return summary({ stage: "context", detail: "context_unavailable" });
  }
  if (registry === null) return summary({ stage: "context", detail: "context_unreadable" });

  // Every call ends the same ways: anything but a settled answer ends the run.
  const ask = async (
    messages: readonly MarketingLlmMessage[],
    allowedDomains: readonly string[],
    answerSchema: MarketingLlmAnswerSchema,
  ): Promise<{ readonly content: string; readonly citations: readonly string[] } | { readonly stop: MarketingA3CycleSummary }> => {
    calls += 1;
    let outcome: MarketingLlmCallOutcome;
    try {
      outcome = await deps.callLlm(messages, deps.newId(), allowedDomains, answerSchema);
    } catch {
      // Nothing says whether the provider was reached: unknown, and the run stops.
      return { stop: summary({ stage: "llm", detail: "threw" }) };
    }
    if (outcome.status === "refused") return { stop: summary({ stage: "llm", detail: `${outcome.stage}:${outcome.code}` }) };
    // Given up before dispatch and the reservation released: nothing reached
    // the provider and the ledger is closed, so this is A3 running out of
    // time, not an unknown -- A5 still runs. A release whose answer was lost
    // comes back as `stopped` and does stop the run.
    if (outcome.status === "released") return { stop: summary({ stage: "deadline", detail: "released_before_dispatch" }) };
    if (outcome.status !== "answered") return { stop: summary({ stage: "llm", detail: outcome.status }) };
    return { content: outcome.content, citations: outcome.citations };
  };

  const deadline = Date.parse(input.deadlineAt);
  for (const competitor of registry.tracked.filter((row) => row.officialHosts.length > 0)) {
    if (deadline - deps.now() < MARKETING_A3_COMPETITOR_BUDGET_MS) {
      return summary({ stage: "deadline", detail: "deadline_too_close" });
    }
    competitors += 1;

    const checkedAt = new Date(deps.now()).toISOString();
    const outcome = await ask(marketingA3Messages(competitor), competitor.officialHosts, MARKETING_A3_ANSWER_SCHEMA);
    if ("stop" in outcome) return outcome.stop;
    const read = readMarketingA3Answer(outcome.content, {
      competitorId: competitor.competitorId,
      officialHosts: competitor.officialHosts,
      citations: outcome.citations,
      checkedAt,
    });
    // An answer that is not the JSON asked for found nothing usable: counted, not guessed at.
    unrepresentable += read.unreadable ? 1 : read.unrepresentable;
    if (read.unreadable) dropped.unreadable_answer = (dropped.unreadable_answer ?? 0) + 1;
    for (const [reason, count] of Object.entries(read.dropped) as Array<[MarketingA3DropReason, number]>) {
      dropped[reason] = (dropped[reason] ?? 0) + count;
    }
    facts.push(...read.facts);
  }

  // One discovery search a run, after the tracked competitors, for ones the
  // registry has never held. What it finds is only proposed.
  if (deadline - deps.now() < MARKETING_A3_COMPETITOR_BUDGET_MS) {
    return summary({ stage: "deadline", detail: "deadline_too_close" });
  }
  const discovery = await ask(
    marketingA3DiscoveryMessages({
      knownIds: registry.knownIds,
      trackedNames: registry.tracked.map((row) => row.displayName),
    }),
    [],
    MARKETING_A3_DISCOVERY_ANSWER_SCHEMA,
  );
  if ("stop" in discovery) return discovery.stop;
  const found = readMarketingA3Discovery(discovery.content, {
    knownIds: registry.knownIds,
    citations: discovery.citations,
  });
  if (found.unreadable) candidatesDropped.unreadable_answer = 1;
  Object.assign(candidatesDropped, found.dropped);
  candidates.push(...found.candidates);

  if (facts.length === 0 && unrepresentable === 0 && candidates.length === 0) return summary(null);
  if (deadline - deps.now() < MARKETING_A3_REPORT_MARGIN_MS) {
    return summary({ stage: "deadline", detail: "report_deadline_too_close" });
  }
  const periodEnd = new Date(deps.now()).toISOString();
  const build = (kept: number) =>
    marketingA3ReportBody(deps.secret, {
      generatorRunId: input.generatorRunId,
      reportId: MARKETING_A3_REPORT_ID,
      periodStart: startedAt,
      periodEnd,
      deadlineAt: input.deadlineAt,
      facts: facts.slice(0, kept),
      unrepresentableFactCount: unrepresentable + (facts.length - kept),
      competitorCandidates: candidates,
    });
  // At most the payload's fact limit, and no more than the route will read:
  // facts past either are counted with the unrepresentable ones, not lost.
  let kept = Math.min(facts.length, MARKETING_A3_REPORT_MAX_FACTS);
  let report = build(kept);
  while (kept > 0 && Buffer.byteLength(JSON.stringify(report), "utf8") > REPORT_BYTE_LIMIT) {
    kept = Math.max(0, kept - Math.max(1, Math.ceil(kept / 10)));
    report = build(kept);
  }
  unrepresentable += facts.length - kept;
  facts.length = kept;

  let answer: { readonly httpStatus: number; readonly body: Record<string, unknown> } | null = null;
  for (let attempt = 0; attempt < MARKETING_A3_SUBMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 0) await deps.sleep(MARKETING_A3_SUBMIT_BACKOFF_MS[attempt - 1] ?? 5_000);
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
    return summary({ stage: "submit", detail: `http_${answer.httpStatus}:${status}` }, reported);
  }
  return summary(null, reported);
}
