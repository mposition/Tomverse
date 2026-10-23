import { readFile } from "node:fs/promises";
import { memoryRetrievalTerms } from "../../lib/memoryRetrievalTerms";
import { selectMemoryContext, type RetrievableMemory } from "../../lib/memoryRetrievalScoring";
import { evaluateRetrieval, retrievalTargetFailures, summarizeRetrieval } from "./evaluator";
import { corpusSchema, retrievalCorpusSchema, type QualityCase } from "./schema";

export const RECALL_K = 5;
export const PRODUCT_RETRIEVAL_CORPORA = ["development", "validation", "retrieval-ko"] as const;
export type ProductRetrievalCorpus = (typeof PRODUCT_RETRIEVAL_CORPORA)[number];

// One clock and uniform confidence/importance, so only the query and the
// statement text decide the order — the part MEMORY-01 measures.
const NOW = new Date("2026-01-01T00:00:00.000Z");

type RetrievalCase = Pick<QualityCase, "id" | "language" | "retrieval"> & { tag: string };

/**
 * The product retrieval path, with no model call: statements are indexed with
 * the same `memoryRetrievalTerms` the write paths use and ranked by the same
 * `selectMemoryContext` the chat context builder uses.
 *
 * Like `retrieveMemoryContext`, only active rows reach the scorer. Forbidden
 * rows stay in the pool: nothing on the read path removes them (the write-time
 * validator is the product's defence), so a forbidden selection is a finding.
 */
export function productSelection(retrieval: QualityCase["retrieval"]) {
  const memories: RetrievableMemory[] = retrieval.pool
    .filter((item) => item.status === "active")
    .map((item) => ({
      id: item.id, kind: item.kind ?? "preference", statement: item.statement, conflictKey: null,
      confidence: 1, importance: 5, pinned: false, searchTerms: memoryRetrievalTerms(item.statement),
      effectiveAt: NOW, expiresAt: null, sourceIds: [],
    }));
  return selectMemoryContext({ memories, query: retrieval.query, now: NOW }).selected
    .map((candidate) => ({ id: candidate.memory.id, tier: candidate.tier }));
}

export function measureProductRetrieval(cases: readonly RetrievalCase[]) {
  const rows = cases.map((testCase) => {
    const { relevantIds } = testCase.retrieval;
    const injected = productSelection(testCase.retrieval);
    // Recall@5 is read off the prompt order: core first, then relevant, then style.
    const topItems = injected.slice(0, RECALL_K);
    const top = topItems.map((item) => item.id);
    const gated = topItems.filter((item) => item.tier === "relevant");
    return {
      ...evaluateRetrieval(testCase, top), tag: testCase.tag, top,
      recalledInjected: relevantIds.filter((id) => injected.some((item) => item.id === id)).length,
      missed: relevantIds.filter((id) => !top.includes(id)),
      // Core and style are never relevance-gated (§9), so they are counted
      // apart from the term matches that MEMORY-02 is about.
      gatedSelected: gated.length,
      gatedIrrelevant: gated.filter((item) => !relevantIds.includes(item.id)).length,
    };
  });
  const summary = summarizeRetrieval(rows);
  const ko = rows.filter((row) => row.language === "ko");
  const injectedRelevant = ko.reduce((n, row) => n + row.relevant, 0);
  const byTag: Record<string, { relevant: number; recalled: number; recallAt5: number | null }> = {};
  for (const row of ko) {
    const entry = byTag[row.tag] ??= { relevant: 0, recalled: 0, recallAt5: null };
    entry.relevant += row.relevant;
    entry.recalled += row.recalled;
    entry.recallAt5 = entry.relevant ? entry.recalled / entry.relevant : null;
  }
  const gatedSelected = rows.reduce((n, row) => n + row.gatedSelected, 0);
  return {
    path: "product:selectMemoryContext" as const, k: RECALL_K, cases: rows.length,
    // Without kinds every row is treated as relevance-gated, which the product never does for core/style.
    poolKinds: cases.every((row) => row.retrieval.pool.every((item) => item.kind)) ? "annotated" : "defaulted",
    summary,
    // Everything the prompt would carry, not only the first five.
    koreanRecallInjected: injectedRelevant
      ? ko.reduce((n, row) => n + row.recalledInjected, 0) / injectedRelevant : null,
    gatedIrrelevantRate: gatedSelected
      ? rows.reduce((n, row) => n + row.gatedIrrelevant, 0) / gatedSelected : 0,
    byTag,
    misses: rows.filter((row) => row.missed.length > 0)
      .map((row) => ({ caseId: row.caseId, tag: row.tag, missed: row.missed, top: row.top })),
    targetFailures: retrievalTargetFailures(summary),
    paidCalls: 0 as const, decisionGrade: false as const,
  };
}

const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

export async function loadRetrievalCases(name: ProductRetrievalCorpus): Promise<RetrievalCase[]> {
  if (name === "retrieval-ko") {
    const corpus = retrievalCorpusSchema.parse(await fixture(name));
    return corpus.cases.map((row) => {
      const pool = corpus.pools[row.pool];
      if (!pool) throw new Error("unknown_pool");
      if (row.relevantIds.some((id) => !pool.some((m) => m.id === id && m.status === "active" && !m.forbidden))) {
        throw new Error("invalid_relevance_gold");
      }
      return { id: row.id, language: row.language, tag: row.tag,
        retrieval: { query: row.query, pool, relevantIds: row.relevantIds } };
    });
  }
  return corpusSchema.parse(await fixture(name)).cases
    .map((row) => ({ id: row.id, language: row.language, tag: row.family, retrieval: row.retrieval }));
}
