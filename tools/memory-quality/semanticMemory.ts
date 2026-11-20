import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { digest } from "./schema";
import { roundSemanticScore, resolveSemanticRetrievalConfig } from "../../lib/semanticRetrievalCore";
import { prepareMemorySemanticInput } from "../../lib/memorySemanticInput";
import { buildMemoryQueryPlan, MEMORY_QUERY_VERSION, MEMORY_FULL_QUERY_VERSION } from "../../lib/memoryQueryPlan";
import { MEMORY_SEMANTIC_DEFAULTS, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION } from "../../lib/memoryRetrievalScoring";
import {
  measureProductRetrievalDetailed, rerankDocuments, type RetrievalCase,
} from "./productRetrieval";
import { QualityStop } from "./runner";
import {
  LiveStop, SaveTarget, openLiveClient, resolveLive, type LiveContext,
} from "./semanticLive";

/**
 * Lexical against semantic memory retrieval, on one corpus.
 *
 * The semantic side is the product's own pure path: `selectMemoryContext` with
 * `externalRelevance`, fed the memories `memoryTier` relevance-gates. Only where
 * the scores come from differs: a saved file (the default, no network) or a
 * metered live call to the provider.
 */

export const MEMORY_SCORES_FORMAT = "memory-rerank-scores-v1";
const caseScores = z.record(z.string(), z.record(z.string(), z.number().finite().min(0).max(1)));
const requestIdentity = z.object({
  queryHash: z.string(), candidateIds: z.array(z.string()), candidatesHash: z.string(),
  currentQueryHash: z.string().optional(), historyHash: z.string().optional(),
  queryMode: z.enum(["current-query", "full-query", "full-query+history"]).optional(),
}).strict();
const scoreProvenance = z.object({
  kind: z.enum(["provider", "mock", "oracle"]),
  provider: z.string().min(1), model: z.string().min(1), collectedAt: z.string().datetime(),
  corpusDigest: z.string(), requests: z.record(z.string(), requestIdentity),
  settings: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
}).strict();
const savedScores = z.object({
  format: z.literal(MEMORY_SCORES_FORMAT), scores: caseScores,
  corpus: z.string().optional(), provenance: scoreProvenance.optional(),
}).passthrough();

export type MemoryScores = Map<string, Map<string, number>> & {
  corpus?: string; provenance?: z.infer<typeof scoreProvenance>;
};

export type MemoryEvaluationQueryMode = "current-query" | "full-query" | "full-query+history";
type EvaluationPreparation = { model: string; billing: { unit: "token" } | { unit: "search_unit" } };
const queryVersion = (mode: MemoryEvaluationQueryMode) => mode === "current-query"
  ? MEMORY_QUERY_VERSION : MEMORY_FULL_QUERY_VERSION;
const evaluationInput = (testCase: RetrievalCase, mode: MemoryEvaluationQueryMode,
  preparation?: EvaluationPreparation) => {
  let history = mode === "full-query+history" ? testCase.retrieval.history ?? [] : [];
  const plan = buildMemoryQueryPlan(testCase.retrieval.query, {
    queryPolicy: mode === "current-query" ? "legacy" : "full",
    history,
  });
  if (preparation && mode !== "current-query") {
    const prepared = prepareMemorySemanticInput({ ...preparation, currentQuery: testCase.retrieval.query, history });
    if (!prepared.ok) throw new QualityStop(`evaluation_${prepared.reason}`);
    history = prepared.value.historyCount > 0 ? history.slice(-prepared.value.historyCount) : [];
    return { plan: { ...plan, semanticQuery: prepared.value.effectiveQuery }, history };
  }
  return { plan, history };
};
export const memoryEvaluationQueryPlan = (testCase: RetrievalCase, mode: MemoryEvaluationQueryMode = "current-query",
  preparation?: EvaluationPreparation) => evaluationInput(testCase, mode, preparation).plan;

export const memoryEvaluationInputIdentity = (testCase: RetrievalCase, mode: MemoryEvaluationQueryMode = "current-query",
  preparation?: EvaluationPreparation) => {
  const documents = rerankDocuments(testCase.retrieval);
  const input = evaluationInput(testCase, mode, preparation);
  return { queryHash: digest(input.plan.semanticQuery),
    candidateIds: documents.map((doc) => doc.id), candidatesHash: digest(documents),
    ...(mode === "current-query" ? {} : {
      currentQueryHash: digest(testCase.retrieval.query.normalize("NFC")),
      historyHash: digest(input.history.map(text => text.normalize("NFC"))),
      queryMode: mode,
    }),
  };
};
export const memoryEvaluationCorpusDigest = (cases: readonly RetrievalCase[], mode: MemoryEvaluationQueryMode = "current-query",
  preparation?: EvaluationPreparation) => digest(cases.map((row) => ({
  id: row.id, queryVersion: queryVersion(mode),
  queryHash: digest(row.retrieval.query.normalize("NFC")), pool: row.retrieval.pool,
  input: memoryEvaluationInputIdentity(row, mode, preparation),
})));

/** Case id to `{ memoryId: score }`, bare or wrapped in the file `--save-scores` writes. */
export async function loadMemoryScores(file: string): Promise<MemoryScores> {
  let parsed: z.infer<typeof caseScores>;
  let metadata: Pick<MemoryScores, "corpus" | "provenance"> = {};
  try {
    const raw = JSON.parse(await readFile(resolve(file), "utf8")) as unknown;
    if (typeof raw === "object" && raw !== null && "format" in raw) {
      const wrapped = savedScores.parse(raw);
      parsed = wrapped.scores;
      metadata = { corpus: wrapped.corpus, provenance: wrapped.provenance };
    } else parsed = caseScores.parse(raw);
  } catch {
    throw new QualityStop("scores_file_invalid");
  }
  // Reject invalid ranges, then round the way a validated provider response is stored.
  return Object.assign(new Map(Object.entries(parsed).map(([caseId, scores]) => [
    caseId, new Map(Object.entries(scores).map(([id, score]) => [id, roundSemanticScore(score)])),
  ])), metadata);
}

const hasRerankRequest = (testCase: RetrievalCase) =>
  buildMemoryQueryPlan(testCase.retrieval.query).semanticQuery.trim() !== "" && rerankDocuments(testCase.retrieval).length > 0;

/** One rerank request per case that has something to rank. */
export const plannedMemoryCalls = (cases: readonly RetrievalCase[]) => cases.filter(hasRerankRequest).length;

const round4 = (value: number) => Math.round(value * 1e4) / 1e4;
const delta = (semantic: number | null, lexical: number | null) =>
  semantic === null || lexical === null ? null : round4(semantic - lexical);

type Measured = ReturnType<typeof measureProductRetrievalDetailed>;
const brief = ({ result }: Measured) => ({
  koreanRecallAt5: result.summary.koreanRecallAt5,
  koreanRecallInjected: result.koreanRecallInjected,
  relevant: result.summary.relevant, recalled: result.summary.recalled,
  irrelevantInjectionRate: result.summary.irrelevantInjectionRate,
  gatedIrrelevantRate: result.gatedIrrelevantRate,
  forbidden: result.summary.forbidden,
  top5: result.top5, fullSelectedSet: result.fullSelectedSet,
});

export function compareMemory(corpus: string, cases: readonly RetrievalCase[], scores: MemoryScores,
  mode: MemoryEvaluationQueryMode = "current-query") {
  const unit = scores.provenance?.settings.billingUnit;
  const preparation: EvaluationPreparation | undefined = mode !== "current-query" &&
    (unit === "token" || unit === "search_unit") && scores.provenance
    ? { model: scores.provenance.model, billing: { unit } } : undefined;
  if (mode !== "current-query" && scores.provenance?.kind === "provider" && !preparation) {
    throw new QualityStop("scores_input_contract_missing");
  }
  if (scores.corpus !== undefined && scores.corpus !== corpus) throw new QualityStop("scores_corpus_mismatch");
  if (scores.provenance) {
    if (scores.provenance.corpusDigest !== memoryEvaluationCorpusDigest(cases, mode, preparation)) throw new QualityStop("scores_corpus_mismatch");
    if (scores.provenance.settings.queryVersion !== queryVersion(mode) ||
      (mode !== "current-query" && scores.provenance.settings.queryMode !== mode)) throw new QualityStop("scores_input_mismatch");
    if (scores.provenance.settings.retrievalVersion !== MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION ||
      Object.entries(MEMORY_SEMANTIC_DEFAULTS).some(([key, value]) => scores.provenance!.settings[key] !== value)) {
      throw new QualityStop("scores_input_mismatch");
    }
    for (const [caseId, identity] of Object.entries(scores.provenance.requests)) {
      const testCase = cases.find((row) => row.id === caseId);
      if (!testCase || digest(identity) !== digest(memoryEvaluationInputIdentity(testCase, mode, preparation))) {
        throw new QualityStop("scores_input_mismatch");
      }
    }
    if ([...scores.keys()].some((caseId) => !scores.provenance!.requests[caseId])) {
      throw new QualityStop("scores_input_mismatch");
    }
  }
  // A real response must score every offered document exactly once. Saved
  // partial/unknown-ID maps also fall back, rather than inventing a hybrid run.
  const usableScores = (testCase: RetrievalCase) => {
    const documents = rerankDocuments(testCase.retrieval);
    const saved = scores.get(testCase.id);
    return saved && saved.size === documents.length && documents.every(doc => saved.has(doc.id))
      ? saved : undefined;
  };
  const lexical = measureProductRetrievalDetailed(cases);
  const semantic = measureProductRetrievalDetailed(cases, (caseId) => {
    const testCase = cases.find((row) => row.id === caseId)!;
    return usableScores(testCase);
  }, (caseId) => {
    const testCase = cases.find(row => row.id === caseId)!;
    return evaluationInput(testCase, mode, preparation).history.length > 0;
  });
  const tags = [...new Set([...Object.keys(lexical.result.byTag), ...Object.keys(semantic.result.byTag)])];
  const byTag = Object.fromEntries(tags.map((tag) => {
    const before = lexical.result.byTag[tag], after = semantic.result.byTag[tag];
    return [tag, {
      relevant: before?.relevant ?? after?.relevant ?? 0,
      lexical: { recalled: before?.recalled ?? 0, recallAt5: before?.recallAt5 ?? null },
      semantic: { recalled: after?.recalled ?? 0, recallAt5: after?.recallAt5 ?? null },
      delta: delta(after?.recallAt5 ?? null, before?.recallAt5 ?? null),
    }];
  }));
  const differences = cases.flatMap((testCase, index) => {
    const before = lexical.rows[index].top, after = semantic.rows[index].top;
    const { relevantIds } = testCase.retrieval;
    const gained = relevantIds.filter((id) => after.includes(id) && !before.includes(id));
    const lost = relevantIds.filter((id) => before.includes(id) && !after.includes(id));
    return gained.length || lost.length
      ? [{ caseId: testCase.id, tag: testCase.tag, gained, lost, lexicalTop: before, semanticTop: after }] : [];
  });
  const covered = cases.filter((testCase) => scores.has(testCase.id));
  const requested = cases.filter(hasRerankRequest);
  return {
    path: "product:selectMemoryContext+externalRelevance" as const, corpus, k: lexical.result.k, cases: cases.length,
    queryMode: mode, queryVersion: queryVersion(mode),
    requests: Object.fromEntries(cases.map(row => [row.id, {
      ...memoryEvaluationInputIdentity(row, mode, preparation),
      queryBytes: Buffer.byteLength(memoryEvaluationQueryPlan(row, mode, preparation).semanticQuery, "utf8"),
      historyCount: evaluationInput(row, mode, preparation).history.length,
      candidateProvenance: "same_product_lexical_and_extra_pool" as const,
    }])),
    lexical: brief(lexical), semantic: brief(semantic),
    scoreEvidence: {
      kind: scores.provenance?.kind ?? "unverified",
      identityVerified: Boolean(scores.provenance),
      provider: scores.provenance?.provider ?? null, model: scores.provenance?.model ?? null,
      collectedAt: scores.provenance?.collectedAt ?? null, settings: scores.provenance?.settings ?? null,
      // Mock/oracle/legacy scores exercise plumbing; they are not measured product quality.
      semanticRetrievalMeasured: scores.provenance?.kind === "provider",
    },
    answerQuality: { status: "not_run" as const, reason: "no_answer_model_executed" as const },
    delta: {
      koreanRecallAt5: delta(semantic.result.summary.koreanRecallAt5, lexical.result.summary.koreanRecallAt5),
      irrelevantInjectionRate: delta(semantic.result.summary.irrelevantInjectionRate, lexical.result.summary.irrelevantInjectionRate),
      gatedIrrelevantRate: delta(semantic.result.gatedIrrelevantRate, lexical.result.gatedIrrelevantRate),
    },
    byTag,
    differences: { gainedCases: differences.filter((row) => row.gained.length).length,
      lostCases: differences.filter((row) => row.lost.length).length, cases: differences },
    // A case with no scores keeps the lexical selection, exactly as a failed provider call would.
    coverage: {
      casesWithRerankRequest: requested.length,
      casesScored: requested.filter((testCase) => usableScores(testCase)).length,
      casesFallingBackToLexical: requested.filter((testCase) => !usableScores(testCase) ||
        semantic.rows.find(row => row.caseId === testCase.id)?.historyDisplacedCurrentQuery).map((testCase) => testCase.id),
      casesRejectedForHistoryDisplacement: semantic.rows.filter(row => row.historyDisplacedCurrentQuery).map(row => row.caseId),
      casesWithIncompleteScores: requested.filter((row) => scores.has(row.id) && !usableScores(row)).map(row => row.id),
      documentsWithoutScore: covered.reduce((n, testCase) => n + rerankDocuments(testCase.retrieval)
        .filter((doc) => !scores.get(testCase.id)!.has(doc.id)).length, 0),
      scoreDocumentsNotInRequest: covered.flatMap((testCase) => [...scores.get(testCase.id)!.keys()]
        .filter((id) => !rerankDocuments(testCase.retrieval).some((doc) => doc.id === id))
        .map((id) => ({ caseId: testCase.id, id }))),
      scoreCasesNotInCorpus: [...scores.keys()].filter((id) => !cases.some((testCase) => testCase.id === id)),
    },
  };
}

export async function measureSemanticMemory(input: {
  corpus: string; cases: readonly RetrievalCase[]; options: Record<string, string>; live: boolean;
  context: LiveContext;
}) {
  const { corpus, cases, options, context } = input;
  const mode = (options["query-mode"] ?? "current-query") as MemoryEvaluationQueryMode;
  if (!input.live) {
    const comparison = compareMemory(corpus, cases, await loadMemoryScores(options["rerank-scores"]), mode);
    return { ...comparison, source: "scores_file" as const, live: null, paidCalls: 0, decisionGrade: false as const };
  }

  const config = await resolveLive(options, context, { embed: false });
  let preparation: EvaluationPreparation | undefined;
  if (mode !== "current-query") {
    const rerank = resolveSemanticRetrievalConfig(context.env ?? process.env).rerank;
    if (!rerank) throw new QualityStop("evaluation_rerank_billing_not_configured");
    preparation = { model: config.rerankModel, billing: rerank.billing };
    // Check the full corpus before a save file or the first paid request.
    for (const row of cases) evaluationInput(row, mode, preparation);
  }
  const planned = plannedMemoryCalls(cases);
  if (planned === 0) throw new QualityStop("nothing_to_rerank");
  if (planned > config.maxCalls) throw new QualityStop("max_calls_below_planned");
  const client = await openLiveClient(config, context);

  const collected: Record<string, Record<string, number>> = {};
  const provenance: z.infer<typeof scoreProvenance> = {
    kind: context.fetchImpl ? "mock" : "provider", provider: "cohere", model: config.rerankModel,
    collectedAt: new Date().toISOString(), corpusDigest: memoryEvaluationCorpusDigest(cases, mode, preparation),
    requests: Object.fromEntries(cases.filter(hasRerankRequest).map((row) => [row.id, memoryEvaluationInputIdentity(row, mode, preparation)])),
    settings: { maxCalls: config.maxCalls, queryVersion: queryVersion(mode), queryMode: mode,
      ...(preparation ? { billingUnit: preparation.billing.unit } : {}),
      retrievalVersion: MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION, ...MEMORY_SEMANTIC_DEFAULTS },
  };
  const snapshot = (complete: boolean) => ({
    format: MEMORY_SCORES_FORMAT, corpus, rerankModel: config.rerankModel,
    complete, usage: client.meter.summary(), scores: collected, provenance,
  });
  // Claimed before the first request, and rewritten after every one.
  const target = await SaveTarget.claim(config.saveScores, snapshot(false));
  let stop: LiveStop | null = null;
  try {
    for (const testCase of cases.filter(hasRerankRequest)) {
      const documents = rerankDocuments(testCase.retrieval);
      const scores = await client.rerank(memoryEvaluationQueryPlan(testCase, mode, preparation).semanticQuery,
        documents.map((doc) => doc.text), mode === "current-query" ? undefined : "memory-v3");
      collected[testCase.id] = Object.fromEntries(documents.map((doc, index) => [doc.id, scores[index]]));
      await target.write(snapshot(false));
    }
  } catch (error) {
    if (!(error instanceof LiveStop)) {
      await target.write(snapshot(false)).catch(() => undefined);
      await target.close();
      throw error;
    }
    stop = error;
  }
  const usage = client.meter.summary();
  try {
    await target.write(snapshot(stop === null));
  } finally {
    await target.close();
  }
  const live = { ...usage, planned, savedScores: resolve(config.saveScores) };
  if (stop) {
    return { stopReason: stop.code, failure: stop.failure, live, paidCalls: usage.calls, decisionGrade: false as const };
  }
  const scored: MemoryScores = Object.assign(new Map(Object.entries(collected).map(([caseId, scores]) =>
    [caseId, new Map(Object.entries(scores))])), { corpus, provenance });
  return { ...compareMemory(corpus, cases, scored, mode), source: "live" as const, live, paidCalls: usage.calls, decisionGrade: false as const };
}
