import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { boundRerankQuery, roundSemanticScore } from "../../lib/semanticRetrievalCore";
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
const caseScores = z.record(z.string(), z.record(z.string(), z.number().finite()));
const savedScores = z.object({
  format: z.literal(MEMORY_SCORES_FORMAT), scores: caseScores,
}).passthrough();

export type MemoryScores = Map<string, Map<string, number>>;

/** Case id to `{ memoryId: score }`, bare or wrapped in the file `--save-scores` writes. */
export async function loadMemoryScores(file: string): Promise<MemoryScores> {
  let parsed: z.infer<typeof caseScores>;
  try {
    const raw = JSON.parse(await readFile(resolve(file), "utf8")) as unknown;
    parsed = typeof raw === "object" && raw !== null && "format" in raw
      ? savedScores.parse(raw).scores : caseScores.parse(raw);
  } catch {
    throw new QualityStop("scores_file_invalid");
  }
  // Rounded and clamped the way a provider response is, before the selector sees it.
  return new Map(Object.entries(parsed).map(([caseId, scores]) => [
    caseId, new Map(Object.entries(scores).map(([id, score]) => [id, roundSemanticScore(score)])),
  ]));
}

const hasRerankRequest = (testCase: RetrievalCase) =>
  boundRerankQuery(testCase.retrieval.query).trim() !== "" && rerankDocuments(testCase.retrieval).length > 0;

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
});

export function compareMemory(corpus: string, cases: readonly RetrievalCase[], scores: MemoryScores) {
  const lexical = measureProductRetrievalDetailed(cases);
  const semantic = measureProductRetrievalDetailed(cases, (caseId) => scores.get(caseId));
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
    lexical: brief(lexical), semantic: brief(semantic),
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
      casesScored: requested.filter((testCase) => scores.has(testCase.id)).length,
      casesFallingBackToLexical: requested.filter((testCase) => !scores.has(testCase.id)).map((testCase) => testCase.id),
      documentsWithoutScore: covered.reduce((n, testCase) => n + rerankDocuments(testCase.retrieval)
        .filter((doc) => !scores.get(testCase.id)!.has(doc.id)).length, 0),
      scoreCasesNotInCorpus: [...scores.keys()].filter((id) => !cases.some((testCase) => testCase.id === id)),
    },
  };
}

export async function measureSemanticMemory(input: {
  corpus: string; cases: readonly RetrievalCase[]; options: Record<string, string>; live: boolean;
  context: LiveContext;
}) {
  const { corpus, cases, options, context } = input;
  if (!input.live) {
    const comparison = compareMemory(corpus, cases, await loadMemoryScores(options["rerank-scores"]));
    return { ...comparison, source: "scores_file" as const, live: null, paidCalls: 0, decisionGrade: false as const };
  }

  const config = await resolveLive(options, context, { embed: false });
  const planned = plannedMemoryCalls(cases);
  if (planned === 0) throw new QualityStop("nothing_to_rerank");
  if (planned > config.maxCalls) throw new QualityStop("max_calls_below_planned");
  const client = await openLiveClient(config, context);

  const collected: Record<string, Record<string, number>> = {};
  const snapshot = (complete: boolean) => ({
    format: MEMORY_SCORES_FORMAT, corpus, rerankModel: config.rerankModel,
    complete, usage: client.meter.summary(), scores: collected,
  });
  // Claimed before the first request, and rewritten after every one.
  const target = await SaveTarget.claim(config.saveScores, snapshot(false));
  let stop: LiveStop | null = null;
  try {
    for (const testCase of cases.filter(hasRerankRequest)) {
      const documents = rerankDocuments(testCase.retrieval);
      const scores = await client.rerank(testCase.retrieval.query, documents.map((doc) => doc.text));
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
  const scored: MemoryScores = new Map(Object.entries(collected).map(([caseId, scores]) =>
    [caseId, new Map(Object.entries(scores))]));
  return { ...compareMemory(corpus, cases, scored), source: "live" as const, live, paidCalls: usage.calls, decisionGrade: false as const };
}
