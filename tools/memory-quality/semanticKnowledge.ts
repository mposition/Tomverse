import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { KNOWLEDGE_CHUNK_MAX_TERMS } from "../../lib/assistantKnowledgeChunking";
import {
  KNOWLEDGE_CONTEXT_DEFAULTS, KNOWLEDGE_SEMANTIC_DEFAULTS, fuseKnowledgeScores, selectKnowledgeContext,
  selectKnowledgeContextRanked, type KnowledgeContextSelection, type RetrievableChunk, type ScoredChunk,
} from "../../lib/assistantKnowledgeRetrievalScoring";
import { memoryRetrievalTerms } from "../../lib/memoryRetrievalTerms";
import {
  SEMANTIC_RETRIEVAL_LIMITS, boundQuery, boundRerankQuery, decodeVector, encodeVector, nearestByCosine,
  roundSemanticScore,
} from "../../lib/semanticRetrievalCore";
import { QualityStop } from "./runner";
import {
  LiveStop, SaveTarget, embedBatchCount, openLiveClient, resolveLive, type LiveContext,
} from "./semanticLive";

/**
 * Knowledge-file retrieval, four ways, on one synthetic corpus.
 *
 * Every selection is the product's own pure function, fed the way
 * `retrieveKnowledgeContext` feeds it: lexical candidates (a shared term, in
 * document order, at most the service's limit) plus, when vectors are known,
 * the nearest chunks; then `selectKnowledgeContextRanked` on rerank scores,
 * `fuseKnowledgeScores` on neighbours alone, or `selectKnowledgeContext`.
 * Scores and vectors come from a saved file or from a metered live call.
 */

export const KNOWLEDGE_SCORES_FORMAT = "knowledge-retrieval-scores-v1";
export const KNOWLEDGE_CONFIGS = ["lexical", "embedOnly", "rerankOnly", "embedRerank"] as const;
type ConfigName = (typeof KNOWLEDGE_CONFIGS)[number];
const TAGS = ["exact", "synonym", "cross_language", "distractor"] as const;
/** `KNOWLEDGE_CANDIDATE_LIMIT` in lib/assistantKnowledgeRetrieval.ts, which cannot be imported without a database. */
const LEXICAL_CANDIDATE_LIMIT = 60;

const id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
const text = z.string().min(1).max(8000);
const corpusSchema = z.object({
  version: id, source: z.literal("synthetic"),
  documents: z.array(z.object({ id, name: text }).strict()).min(1),
  chunks: z.array(z.object({
    id, documentId: id, ordinal: z.number().int().nonnegative(), content: text,
  }).strict()).min(1).max(5000),
  cases: z.array(z.object({
    id, tag: z.enum(TAGS), query: text, relevantChunkIds: z.array(id).min(1),
    distractorChunkIds: z.array(id).optional(),
  }).strict()).min(1).max(5000),
}).strict();

export type KnowledgeCase = {
  id: string; tag: (typeof TAGS)[number]; query: string; relevantChunkIds: string[]; distractorChunkIds: string[];
};
export type KnowledgeCorpus = { version: string; chunks: RetrievableChunk[]; cases: KnowledgeCase[] };

const unique = (values: readonly string[]) => new Set(values).size === values.length;

export function parseKnowledgeCorpus(raw: unknown): KnowledgeCorpus {
  const corpus = corpusSchema.parse(raw);
  const documents = new Map(corpus.documents.map((doc) => [doc.id, doc.name]));
  const chunkIds = new Set(corpus.chunks.map((chunk) => chunk.id));
  if (documents.size !== corpus.documents.length || chunkIds.size !== corpus.chunks.length ||
      !unique(corpus.cases.map((row) => row.id))) throw new Error("duplicate_id");
  if (corpus.chunks.some((chunk) => !documents.has(chunk.documentId))) throw new Error("unknown_document");
  if (!unique(corpus.chunks.map((chunk) => `${chunk.documentId}/${chunk.ordinal}`))) throw new Error("duplicate_ordinal");
  if (corpus.cases.some((row) => [...row.relevantChunkIds, ...(row.distractorChunkIds ?? [])]
    .some((chunkId) => !chunkIds.has(chunkId)))) throw new Error("unknown_chunk_reference");
  return {
    version: corpus.version,
    // Indexed like a stored chunk: the same tokenizer and term cap the chunker uses.
    chunks: corpus.chunks.map((chunk) => ({
      id: chunk.id, fileId: chunk.documentId, fileName: documents.get(chunk.documentId)!, ordinal: chunk.ordinal,
      content: chunk.content, searchTerms: memoryRetrievalTerms(chunk.content, { maxTerms: KNOWLEDGE_CHUNK_MAX_TERMS }),
    })),
    cases: corpus.cases.map((row) => ({ ...row, distractorChunkIds: row.distractorChunkIds ?? [] })),
  };
}

export async function loadKnowledgeCorpus(): Promise<KnowledgeCorpus> {
  return parseKnowledgeCorpus(JSON.parse(await readFile(
    new URL("./fixtures/knowledge-retrieval-ko.json", import.meta.url), "utf8")));
}

// --- saved scores -----------------------------------------------------------

const savedSchema = z.object({
  format: z.literal(KNOWLEDGE_SCORES_FORMAT), corpus: z.string(),
  chunkVectors: z.record(z.string(), z.string()).optional(),
  queryVectors: z.record(z.string(), z.string()).optional(),
  rerank: z.record(z.string(), z.record(z.string(), z.number().finite())).optional(),
}).passthrough();

export type KnowledgeScores = {
  chunkVectors: Map<string, Int8Array>; queryVectors: Map<string, Int8Array>;
  rerank: Map<string, Map<string, number>>;
};

export const encodeBase64Vector = (vector: Int8Array) => Buffer.from(encodeVector(vector)).toString("base64");

function decodeVectors(entries: Record<string, string> | undefined, known: ReadonlySet<string>) {
  const vectors = new Map<string, Int8Array>();
  for (const [key, value] of Object.entries(entries ?? {})) {
    const vector = decodeVector(new Uint8Array(Buffer.from(value, "base64")));
    if (!vector || !known.has(key)) throw new Error("invalid_vector");
    vectors.set(key, vector);
  }
  if (new Set([...vectors.values()].map((vector) => vector.length)).size > 1) throw new Error("vector_length");
  return vectors;
}

export async function loadKnowledgeScores(file: string, corpus: KnowledgeCorpus): Promise<KnowledgeScores> {
  let saved: z.infer<typeof savedSchema>;
  try {
    saved = savedSchema.parse(JSON.parse(await readFile(resolve(file), "utf8")));
  } catch {
    throw new QualityStop("scores_file_invalid");
  }
  if (saved.corpus !== corpus.version) throw new QualityStop("scores_corpus_mismatch");
  const chunkIds = new Set(corpus.chunks.map((chunk) => chunk.id));
  const caseIds = new Set(corpus.cases.map((row) => row.id));
  try {
    const chunkVectors = decodeVectors(saved.chunkVectors, chunkIds);
    const queryVectors = decodeVectors(saved.queryVectors, caseIds);
    const rerank = new Map(Object.entries(saved.rerank ?? {}).map(([caseId, scores]) => {
      if (!caseIds.has(caseId) || Object.keys(scores).some((chunkId) => !chunkIds.has(chunkId))) {
        throw new Error("unknown_reference");
      }
      return [caseId, new Map(Object.entries(scores).map(([chunkId, score]) => [chunkId, roundSemanticScore(score)]))];
    }));
    return { chunkVectors, queryVectors, rerank };
  } catch {
    throw new QualityStop("scores_file_invalid");
  }
}

// --- selection --------------------------------------------------------------

const documentOrder = (a: RetrievableChunk, b: RetrievableChunk) =>
  a.fileId !== b.fileId ? (a.fileId < b.fileId ? -1 : 1) : a.ordinal - b.ordinal;

/** The chunks nearest the question, or null when there is no vector to compare, as `knowledgeNeighbours` is. */
function neighboursOf(testCase: KnowledgeCase, chunks: readonly RetrievableChunk[], scores: KnowledgeScores) {
  const query = scores.queryVectors.get(testCase.id);
  if (!query) return null;
  const rows = chunks.flatMap((chunk) => {
    const vector = scores.chunkVectors.get(chunk.id);
    return vector ? [{ id: chunk.id, vector }] : [];
  });
  const nearest = nearestByCosine(query, rows, {
    limit: KNOWLEDGE_SEMANTIC_DEFAULTS.neighbourLimit, minSimilarity: KNOWLEDGE_SEMANTIC_DEFAULTS.minSimilarity,
  });
  return nearest.length > 0 ? new Map(nearest.map((row) => [row.id, row.similarity])) : null;
}

/** The lexical rows, plus the neighbours that share no term, in document order. */
function candidatesOf(chunks: readonly RetrievableChunk[], queryTerms: readonly string[], neighbours: ReadonlyMap<string, number> | null) {
  const wanted = new Set(queryTerms);
  const lexical = chunks.filter((chunk) => chunk.searchTerms.some((term) => wanted.has(term)))
    .sort(documentOrder).slice(0, LEXICAL_CANDIDATE_LIMIT);
  if (!neighbours) return lexical;
  const known = new Set(lexical.map((chunk) => chunk.id));
  return [...lexical, ...chunks.filter((chunk) => neighbours.has(chunk.id) && !known.has(chunk.id))].sort(documentOrder);
}

const steps: Record<ConfigName, { embed: boolean; rerank: boolean }> = {
  lexical: { embed: false, rerank: false }, embedOnly: { embed: true, rerank: false },
  rerankOnly: { embed: false, rerank: true }, embedRerank: { embed: true, rerank: true },
};

/** What `retrieveKnowledgeContext` does for one question, with the given steps switched on. */
export function selectForCase(
  name: ConfigName, testCase: KnowledgeCase, chunks: readonly RetrievableChunk[], scores: KnowledgeScores,
) {
  const queryTerms = memoryRetrievalTerms(testCase.query);
  const none = { selection: selectKnowledgeContext({ chunks: [], query: queryTerms }), usedEmbed: false, usedRerank: false };
  if (queryTerms.length === 0) return none;
  const neighbours = steps[name].embed ? neighboursOf(testCase, chunks, scores) : null;
  const rows = candidatesOf(chunks, queryTerms, neighbours);
  if (rows.length === 0) return none;

  const saved = steps[name].rerank ? scores.rerank.get(testCase.id) : undefined;
  if (saved) {
    // Only what a request for these candidates would have scored.
    const sent = rows.slice(0, SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments);
    const ranked = new Map(sent.flatMap((chunk) => saved.has(chunk.id) ? [[chunk.id, saved.get(chunk.id)!] as const] : []));
    return {
      selection: selectKnowledgeContextRanked({
        chunks: rows, scores: ranked, query: queryTerms, minScore: KNOWLEDGE_SEMANTIC_DEFAULTS.minRerankScore,
      }),
      usedEmbed: neighbours !== null, usedRerank: true,
    };
  }
  if (neighbours) {
    return {
      selection: selectKnowledgeContextRanked({
        chunks: rows, scores: fuseKnowledgeScores({ chunks: rows, query: queryTerms, similarities: neighbours }),
        query: queryTerms,
      }),
      usedEmbed: true, usedRerank: false,
    };
  }
  return { selection: selectKnowledgeContext({ chunks: rows, query: queryTerms }), usedEmbed: false, usedRerank: false };
}

// --- measurement ------------------------------------------------------------

const rankKey = (score: number) => Math.round(score * 1e6);

/** The selected chunks best first: the order `selectWithinBudget` admitted them in, not the presentation order. */
export function rankedIds(selection: KnowledgeContextSelection) {
  const order = (a: ScoredChunk, b: ScoredChunk) => rankKey(b.score) - rankKey(a.score) || documentOrder(a, b) ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return [...selection.chunks].sort(order).map((chunk) => chunk.id);
}

const ratio = (num: number, den: number) => (den ? num / den : null);

function measureConfig(name: ConfigName, cases: readonly KnowledgeCase[], chunks: readonly RetrievableChunk[], scores: KnowledgeScores) {
  const rows = cases.map((testCase) => {
    const result = selectForCase(name, testCase, chunks, scores);
    const ranked = rankedIds(result.selection);
    const first = ranked.findIndex((chunkId) => testCase.relevantChunkIds.includes(chunkId));
    return {
      testCase, ranked, recalled: testCase.relevantChunkIds.filter((chunkId) => ranked.includes(chunkId)),
      reciprocalRank: first === -1 ? 0 : 1 / (first + 1),
      distractors: ranked.filter((chunkId) => testCase.distractorChunkIds.includes(chunkId)).length,
      usedEmbed: result.usedEmbed, usedRerank: result.usedRerank,
    };
  });
  const sum = (selected: typeof rows, pick: (row: (typeof rows)[number]) => number) =>
    selected.reduce((n, row) => n + pick(row), 0);
  const summarize = (selected: typeof rows) => ({
    cases: selected.length,
    relevant: sum(selected, (row) => row.testCase.relevantChunkIds.length),
    recalled: sum(selected, (row) => row.recalled.length),
    recallAt6: ratio(sum(selected, (row) => row.recalled.length), sum(selected, (row) => row.testCase.relevantChunkIds.length)),
    mrr: ratio(sum(selected, (row) => row.reciprocalRank), selected.length),
    avgSelected: ratio(sum(selected, (row) => row.ranked.length), selected.length),
    distractorsSelected: sum(selected, (row) => row.distractors),
  });
  return {
    rows,
    result: {
      available: true as const, ...summarize(rows),
      byTag: Object.fromEntries(TAGS.map((tag) => [tag, summarize(rows.filter((row) => row.testCase.tag === tag))])),
      // Questions where a switched-on step was not used: no vector, no score, or no neighbour above the floor.
      stepFallbacks: {
        embed: steps[name].embed ? rows.filter((row) => !row.usedEmbed).map((row) => row.testCase.id) : [],
        rerank: steps[name].rerank ? rows.filter((row) => !row.usedRerank).map((row) => row.testCase.id) : [],
      },
    },
  };
}

type ConfigRows = ReturnType<typeof measureConfig>["rows"];
type Measured = {
  rows: ConfigRows;
  result: ReturnType<typeof measureConfig>["result"] | { available: false; reason: string };
};

export function compareKnowledge(corpus: KnowledgeCorpus, scores: KnowledgeScores) {
  const hasVectors = scores.chunkVectors.size > 0 && scores.queryVectors.size > 0;
  const hasRerank = scores.rerank.size > 0;
  const measured = Object.fromEntries(KNOWLEDGE_CONFIGS.map((name): [ConfigName, Measured] => {
    const reason = steps[name].embed && !hasVectors ? "vectors_not_in_scores"
      : steps[name].rerank && !hasRerank ? "rerank_not_in_scores" : null;
    return [name, reason ? { rows: [], result: { available: false, reason } }
      : measureConfig(name, corpus.cases, corpus.chunks, scores)];
  })) as Record<ConfigName, Measured>;
  const base = measured.lexical.rows;
  const differences = Object.fromEntries(KNOWLEDGE_CONFIGS.filter((name) => name !== "lexical" && measured[name].result.available)
    .map((name) => [name, measured[name].rows.flatMap((row, index) => {
      const before = base[index].recalled;
      const gained = row.recalled.filter((chunkId) => !before.includes(chunkId));
      const lost = before.filter((chunkId) => !row.recalled.includes(chunkId));
      return gained.length || lost.length ? [{ caseId: row.testCase.id, tag: row.testCase.tag, gained, lost }] : [];
    })]));
  return {
    path: "product:knowledge(selectKnowledgeContext|selectKnowledgeContextRanked|fuseKnowledgeScores)" as const,
    corpus: corpus.version, k: KNOWLEDGE_CONTEXT_DEFAULTS.maxChunks, cases: corpus.cases.length, chunks: corpus.chunks.length,
    configs: Object.fromEntries(KNOWLEDGE_CONFIGS.map((name) => [name, measured[name].result])), differences,
  };
}

// --- sources ----------------------------------------------------------------

const emptyScores = (): KnowledgeScores => ({ chunkVectors: new Map(), queryVectors: new Map(), rerank: new Map() });

/** The most requests a live run can make: the embeds, then one rerank per question. */
export const plannedKnowledgeCalls = (corpus: KnowledgeCorpus) =>
  embedBatchCount(corpus.chunks.length) + embedBatchCount(corpus.cases.length) + corpus.cases.length;

export async function measureKnowledge(input: {
  corpus: KnowledgeCorpus; options: Record<string, string>; live: boolean; context: LiveContext;
}) {
  const { corpus, options, context } = input;
  if (!input.live) {
    const scores = options.scores ? await loadKnowledgeScores(options.scores, corpus) : emptyScores();
    return {
      ...compareKnowledge(corpus, scores), source: options.scores ? "scores_file" as const : "none" as const,
      live: null, paidCalls: 0, decisionGrade: false as const,
    };
  }

  const config = await resolveLive(options, context, { embed: true });
  const planned = plannedKnowledgeCalls(corpus);
  if (planned > config.maxCalls) throw new QualityStop("max_calls_below_planned");
  const client = await openLiveClient(config, context);

  const collected = emptyScores();
  const vectorsOf = (vectors: Map<string, Int8Array>) => Object.fromEntries([...vectors].map(([key, vector]) => [key, encodeBase64Vector(vector)]));
  const snapshot = (complete: boolean) => ({
    format: KNOWLEDGE_SCORES_FORMAT, corpus: corpus.version, rerankModel: config.rerankModel,
    embedModel: config.embedModel, embedDimension: config.embedDimension, complete, usage: client.meter.summary(),
    chunkVectors: vectorsOf(collected.chunkVectors), queryVectors: vectorsOf(collected.queryVectors),
    rerank: Object.fromEntries([...collected.rerank].map(([caseId, scores]) => [caseId, Object.fromEntries(scores)])),
  });
  // Claimed before the first request, and rewritten after every one.
  const target = await SaveTarget.claim(config.saveScores, snapshot(false));
  let stop: LiveStop | null = null;
  try {
    const chunkVectors = await client.embed("search_document", corpus.chunks.map((chunk) => chunk.content));
    corpus.chunks.forEach((chunk, index) => collected.chunkVectors.set(chunk.id, chunkVectors[index]));
    await target.write(snapshot(false));
    const queryVectors = await client.embed("search_query", corpus.cases.map((row) => boundQuery(row.query)));
    corpus.cases.forEach((row, index) => collected.queryVectors.set(row.id, queryVectors[index]));
    await target.write(snapshot(false));
    for (const testCase of corpus.cases) {
      const queryTerms = memoryRetrievalTerms(testCase.query);
      // The widest candidate set (lexical plus neighbours): the lexical-only
      // configuration reads its subset, a score being per question and passage.
      const rows = candidatesOf(corpus.chunks, queryTerms, neighboursOf(testCase, corpus.chunks, collected))
        .slice(0, SEMANTIC_RETRIEVAL_LIMITS.maxRerankDocuments);
      if (queryTerms.length === 0 || rows.length === 0 || boundRerankQuery(testCase.query).trim() === "") continue;
      const ranked = await client.rerank(testCase.query, rows.map((chunk) => chunk.content));
      collected.rerank.set(testCase.id, new Map(rows.map((chunk, index) => [chunk.id, ranked[index]])));
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
  if (stop) return { stopReason: stop.code, failure: stop.failure, live, paidCalls: usage.calls, decisionGrade: false as const };
  return { ...compareKnowledge(corpus, collected), source: "live" as const, live, paidCalls: usage.calls, decisionGrade: false as const };
}
