import { readFile } from "node:fs/promises";
import { memoryRetrievalTerms } from "../../lib/memoryRetrievalTerms";
import { buildMemoryQueryPlan } from "../../lib/memoryQueryPlan";
import {
  memoryRerankCandidates, memoryTier, selectMemoryContext, contextualRankingDisplacesCurrentQuery, type RetrievableMemory,
} from "../../lib/memoryRetrievalScoring";
import { evaluateRetrieval, retrievalTargetFailures, summarizeRetrieval } from "./evaluator";
import { corpusSchema, retrievalCorpusSchema, type QualityCase } from "./schema";

export const RECALL_K = 5;
export const PRODUCT_RETRIEVAL_CORPORA = ["development", "validation", "retrieval-ko", "relevance"] as const;
export type ProductRetrievalCorpus = (typeof PRODUCT_RETRIEVAL_CORPORA)[number];

// One clock and uniform confidence/importance, so only the query and the
// statement text decide the order — the part MEMORY-01 measures.
const NOW = new Date("2026-01-01T00:00:00.000Z");

export type RetrievalCase = Pick<QualityCase, "id" | "language" | "retrieval"> & { tag: string };

/**
 * The product retrieval path, with no model call: statements are indexed with
 * the same `memoryRetrievalTerms` the write paths use and ranked by the same
 * `selectMemoryContext` the chat context builder uses.
 *
 * Like `retrieveMemoryContext`, only active rows reach the scorer. Forbidden
 * rows stay in this synthetic pool to measure the selector alone. This harness
 * does not exercise the write validator, provenance or database eligibility;
 * selecting a known invalid fixture is not evidence of a product data leak.
 */
function productMemories(retrieval: QualityCase["retrieval"]): RetrievableMemory[] {
  return retrieval.pool
    .filter((item) => item.status === "active")
    .map((item) => ({
      id: item.id, kind: item.kind ?? "preference", statement: item.statement, conflictKey: null,
      confidence: 1, importance: 5, pinned: false, searchTerms: memoryRetrievalTerms(item.statement),
      effectiveAt: NOW, expiresAt: null, sourceIds: [],
    }));
}

/**
 * What `retrieveMemoryContext` sends to the reranker: only the memories the
 * selector relevance-gates (`memoryTier`), at most one search unit's worth. The
 * pool is one account's memories, so the lexical candidates plus the extras the
 * service adds are all of it. A query with no usable term asks for nothing.
 */
export function rerankDocuments(retrieval: QualityCase["retrieval"]) {
  const plan = buildMemoryQueryPlan(retrieval.query);
  if (plan.terms.length === 0) return [];
  const all = productMemories(retrieval).sort((left, right) => left.id.localeCompare(right.id));
  const lexical = all.filter((memory) => memoryTier(memory) !== "relevant" ||
    memory.searchTerms.some((term) => plan.terms.includes(term)));
  const ids = new Set(lexical.map((memory) => memory.id));
  return memoryRerankCandidates({ lexical, extras: all.filter((memory) => !ids.has(memory.id)), now: NOW })
    .map((memory) => ({ id: memory.id, text: memory.statement }));
}

function productSelectionDetailed(
  retrieval: QualityCase["retrieval"], externalRelevance?: ReadonlyMap<string, number>,
  hasHistory = false,
) {
  const input = { memories: productMemories(retrieval), query: retrieval.query, now: NOW };
  let selection = selectMemoryContext({
    ...input,
    ...(externalRelevance ? { externalRelevance } : {}),
  });
  let historyDisplacedCurrentQuery = false;
  if (hasHistory && externalRelevance) {
    const lexical = selectMemoryContext(input);
    historyDisplacedCurrentQuery = contextualRankingDisplacesCurrentQuery(lexical, selection);
    if (historyDisplacedCurrentQuery) selection = lexical;
  }
  return { selection, historyDisplacedCurrentQuery };
}

export function productSelection(
  retrieval: QualityCase["retrieval"], externalRelevance?: ReadonlyMap<string, number>, hasHistory = false,
) {
  return productSelectionDetailed(retrieval, externalRelevance, hasHistory).selection.selected
    .map(candidate => ({ id: candidate.memory.id, tier: candidate.tier }));
}

type RelevanceFor = (caseId: string) => ReadonlyMap<string, number> | undefined;

export function measureProductRetrieval(cases: readonly RetrievalCase[], relevanceFor?: RelevanceFor) {
  return measureProductRetrievalDetailed(cases, relevanceFor).result;
}

export function measureProductRetrievalDetailed(cases: readonly RetrievalCase[], relevanceFor?: RelevanceFor,
  historyFor?: (caseId: string) => boolean) {
  const rows = cases.map((testCase) => {
    const { relevantIds } = testCase.retrieval;
    const { selection, historyDisplacedCurrentQuery } = productSelectionDetailed(
      testCase.retrieval, relevanceFor?.(testCase.id), historyFor?.(testCase.id));
    const injected = selection.selected.map(candidate => ({ id: candidate.memory.id, tier: candidate.tier }));
    // Recall@5 is read off the prompt order: core first, then relevant, then style.
    const topItems = injected.slice(0, RECALL_K);
    const top = topItems.map((item) => item.id);
    const gated = topItems.filter((item) => item.tier === "relevant");
    const full = injected.map((item) => item.id);
    const fullGated = injected.filter((item) => item.tier === "relevant");
    const { pool } = testCase.retrieval;
    return {
      ...evaluateRetrieval(testCase, top), tag: testCase.tag, top, historyDisplacedCurrentQuery,
      recalledInjected: relevantIds.filter((id) => injected.some((item) => item.id === id)).length,
      missed: relevantIds.filter((id) => !top.includes(id)),
      // Core and style are never relevance-gated
      // (docs/policy/external-conversation-import-and-memory.md §9), so they are counted
      // apart from the term matches that MEMORY-02 is about.
      gatedSelected: gated.length,
      gatedIrrelevant: gated.filter((item) => !relevantIds.includes(item.id)).length,
      full: {
        selected: full.length, relevant: relevantIds.length,
        recalled: relevantIds.filter((id) => full.includes(id)).length,
        irrelevant: full.filter((id) => !relevantIds.includes(id)).length,
        forbidden: full.filter((id) => pool.find((item) => item.id === id)!.forbidden).length,
        inactive: full.filter((id) => pool.find((item) => item.id === id)!.status !== "active").length,
        gatedSelected: fullGated.length,
        gatedIrrelevant: fullGated.filter((item) => !relevantIds.includes(item.id)).length,
        // Contractually allowed context is separate from question-answer gold.
        alwaysOnSelected: injected.filter((item) => item.tier !== "relevant").length,
        ids: full,
      },
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
  const fullSum = (key: "selected" | "relevant" | "recalled" | "irrelevant" | "forbidden" |
    "inactive" | "gatedSelected" | "gatedIrrelevant" | "alwaysOnSelected", source = rows) =>
    source.reduce((n, row) => n + row.full[key], 0);
  const fullSelectedSet = {
    selected: fullSum("selected"), relevant: fullSum("relevant"), recalled: fullSum("recalled"),
    recall: fullSum("relevant") ? fullSum("recalled") / fullSum("relevant") : null,
    koreanRecall: fullSum("relevant", ko) ? fullSum("recalled", ko) / fullSum("relevant", ko) : null,
    irrelevant: fullSum("irrelevant"), forbidden: fullSum("forbidden"), inactive: fullSum("inactive"),
    gatedSelected: fullSum("gatedSelected"), gatedIrrelevant: fullSum("gatedIrrelevant"),
    gatedIrrelevantRate: fullSum("gatedSelected") ? fullSum("gatedIrrelevant") / fullSum("gatedSelected") : 0,
    alwaysOnSelected: fullSum("alwaysOnSelected"),
  };
  const result = {
    path: "product:selectMemoryContext" as const, k: RECALL_K, cases: rows.length,
    // Without kinds every row is treated as relevance-gated, which the product never does for core/style.
    poolKinds: cases.every((row) => row.retrieval.pool.every((item) => item.kind)) ? "annotated" : "defaulted",
    summary,
    top5: { ...summary, gatedSelected,
      gatedIrrelevant: rows.reduce((n, row) => n + row.gatedIrrelevant, 0),
      gatedIrrelevantRate: gatedSelected
        ? rows.reduce((n, row) => n + row.gatedIrrelevant, 0) / gatedSelected : 0 },
    fullSelectedSet,
    scope: "pure_selector_synthetic_pool" as const,
    answerQuality: { status: "not_run" as const, reason: "no_answer_model_executed" as const },
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
  return { result, rows };
}

const fixture = async (name: string) =>
  JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), "utf8"));

export async function loadRetrievalCases(name: ProductRetrievalCorpus): Promise<RetrievalCase[]> {
  if (name === "relevance") {
    return (await import("./fixtures/relevance-inputs")).MEMORY_RELEVANCE_FIXTURES;
  }
  if (name === "retrieval-ko") {
    const corpus = retrievalCorpusSchema.parse(await fixture(name));
    return corpus.cases.map((row) => {
      const pool = corpus.pools[row.pool];
      if (!pool) throw new Error("unknown_pool");
      if (row.relevantIds.some((id) => !pool.some((m) => m.id === id && m.status === "active" && !m.forbidden))) {
        throw new Error("invalid_relevance_gold");
      }
      return { id: row.id, language: row.language, tag: row.tag,
        retrieval: { query: row.query, pool, relevantIds: row.relevantIds,
          ...(row.history ? { history: row.history } : {}) } };
    });
  }
  return corpusSchema.parse(await fixture(name)).cases
    .map((row) => ({ id: row.id, language: row.language, tag: row.family, retrieval: row.retrieval }));
}
