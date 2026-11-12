import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { main } from "../tools/memory-quality/cli.ts";
import { loadRetrievalCases, rerankDocuments } from "../tools/memory-quality/productRetrieval.ts";
import { loadKnowledgeCorpus, encodeBase64Vector, parseKnowledgeCorpus } from "../tools/memory-quality/semanticKnowledge.ts";
import { CallMeter } from "../tools/memory-quality/semanticLive.ts";

// Every provider call in this file goes to a fake `fetch`; none reaches a network.
const KEY = "test-key-not-a-secret";
const ENV = { COHERE_API_KEY: KEY, COHERE_RERANK_MODEL: "rerank-test-model", COHERE_EMBED_MODEL: "embed-test-model" };
const DIMENSION = 48;

const withTemp = async (body) => {
  const directory = await mkdtemp(join(tmpdir(), "semantic-retrieval-"));
  try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const json = (value, status = 200) => new Response(JSON.stringify(value), { status });

/** A fetch that records every request and must never be reached when `calls` is asserted zero. */
const recorder = (answer) => {
  const requests = [];
  const fetchImpl = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, body, authorization: init.headers.authorization });
    return answer(url, body, requests.length);
  };
  return { fetchImpl, requests };
};

// --- memory -------------------------------------------------------------------

const memoryCases = await loadRetrievalCases("retrieval-ko");
// The request carries the question in NFC, as the product sends it.
const byQuery = new Map(memoryCases.map((row) => [row.retrieval.query.normalize("NFC"), row]));

/** High for the relevant memories, low for the rest, for the given case tags only. */
const memoryScores = (tags) => Object.fromEntries(memoryCases.filter((row) => tags.includes(row.tag)).map((row) => [
  row.id, Object.fromEntries(rerankDocuments(row.retrieval).map((doc) =>
    [doc.id, row.retrieval.relevantIds.includes(doc.id) ? 0.9 : 0.05])),
]));

const memoryRerankFake = (failAt = 0) => recorder((url, body, count) => {
  if (count === failAt) return json({ message: "rate limited" }, 429);
  const row = byQuery.get(body.query);
  const wanted = new Set(row.retrieval.pool.filter((item) => row.retrieval.relevantIds.includes(item.id)).map((item) => item.statement));
  return json({
    results: body.documents.map((text, index) => ({ index, relevance_score: wanted.has(text) ? 0.9 : 0.05 })),
    meta: { billed_units: { search_units: 1 } },
  });
});

test("saved scores that rank the synonym memories first raise their Recall@5 and lose nothing", async () => {
  await withTemp(async (directory) => {
    const file = join(directory, "scores.json");
    await writeFile(file, JSON.stringify(memoryScores(["synonym"])));
    const output = await main(["retrieval", "--semantic", "--rerank-scores", file]);
    const comparison = output.semantic["retrieval-ko"];
    assert.equal(comparison.source, "scores_file");
    assert.equal(comparison.paidCalls, 0);
    assert.equal(comparison.live, null);
    assert.equal(comparison.byTag.synonym.lexical.recallAt5, 0);
    assert.equal(comparison.byTag.synonym.semantic.recallAt5, 1);
    assert.equal(comparison.byTag.synonym.delta, 1);
    assert.ok(comparison.delta.koreanRecallAt5 > 0);
    assert.ok(comparison.differences.gainedCases >= 3);
    assert.equal(comparison.differences.lostCases, 0);
    // The plain lexical measurement is unchanged beside it.
    assert.equal(output.retrieval["retrieval-ko"].summary.koreanRecallAt5, comparison.lexical.koreanRecallAt5);
    // Cases without scores keep the lexical selection.
    assert.ok(comparison.coverage.casesFallingBackToLexical.length > 0);
    assert.equal(comparison.coverage.documentsWithoutScore, 0);
  });
});

test("a reranker that prefers the wrong memory is reported as a lost case", async () => {
  await withTemp(async (directory) => {
    const file = join(directory, "scores.json");
    const wrong = Object.fromEntries(Object.entries(memoryScores(["particle"])).map(([caseId, scores]) =>
      [caseId, Object.fromEntries(Object.entries(scores).map(([id, score]) => [id, score > 0.5 ? 0.05 : 0.9]))]));
    await writeFile(file, JSON.stringify({ format: "memory-rerank-scores-v1", scores: wrong }));
    const comparison = (await main(["retrieval", "--semantic", "--rerank-scores", file])).semantic["retrieval-ko"];
    assert.ok(comparison.differences.lostCases > 0);
    assert.ok(comparison.delta.koreanRecallAt5 < 0);
    assert.ok(comparison.differences.cases.some((row) => row.tag === "particle" && row.lost.length > 0));
  });
});

test("core and style memories are not moved by an external score", async () => {
  const core = memoryCases.find((row) => row.tag === "core");
  const file = {};
  for (const item of core.retrieval.pool) file[core.id] = { ...file[core.id], [item.id]: 0 };
  await withTemp(async (directory) => {
    const path = join(directory, "scores.json");
    await writeFile(path, JSON.stringify(file));
    const comparison = (await main(["retrieval", "--semantic", "--rerank-scores", path])).semantic["retrieval-ko"];
    assert.deepEqual(comparison.byTag.core.delta, 0);
  });
});

test("--semantic needs exactly one score source, and score options need --semantic", async () => {
  await assert.rejects(main(["retrieval", "--semantic"]), { code: "semantic_source_required" });
  await assert.rejects(main(["retrieval", "--rerank-scores", "x.json"]), { code: "semantic_required" });
  await assert.rejects(main(["retrieval", "--live"]), { code: "semantic_required" });
  await assert.rejects(main(["retrieval", "--semantic", "--rerank-scores", "x.json", "--live"]), { code: "live_and_scores_exclusive" });
  await assert.rejects(main(["retrieval", "--semantic", "--rerank-scores", "x.json", "--max-calls", "3"]), { code: "live_option_without_live" });
  await assert.rejects(main(["retrieval", "--semantic", "--rerank-scores", "missing.json"]), { code: "scores_file_invalid" });
  await assert.rejects(main(["retrieval", "--semantic", "--live", "--corpus", "all", "--max-calls", "9"]), { code: "live_single_corpus" });
});

test("memory --live is refused unless every precondition holds, before any request", async () => {
  await withTemp(async (directory) => {
    const { fetchImpl, requests } = memoryRerankFake();
    const save = join(directory, "saved.json");
    const live = (args, env = ENV) => main(["retrieval", "--semantic", "--live", ...args], { env, fetchImpl });
    await assert.rejects(live(["--save-scores", save]), { code: "max_calls_required" });
    await assert.rejects(live(["--max-calls", "0", "--save-scores", save]), { code: "max_calls_required" });
    await assert.rejects(live(["--max-calls", "-1", "--save-scores", save]), { code: "max_calls_invalid" });
    await assert.rejects(live(["--max-calls", "40", "--save-scores", save], {}), { code: "live_env_missing" });
    await assert.rejects(live(["--max-calls", "40", "--save-scores", save], { ...ENV, COHERE_API_KEY: "" }), { code: "live_env_missing" });
    await assert.rejects(live(["--max-calls", "40", "--save-scores", save], { ...ENV, COHERE_RERANK_MODEL: "bad model!" }), { code: "live_env_invalid" });
    await assert.rejects(live(["--max-calls", "40"]), { code: "save_scores_required" });
    await writeFile(save, "{}");
    await assert.rejects(live(["--max-calls", "40", "--save-scores", save]), { code: "save_scores_exists" });
    assert.equal(await readFile(save, "utf8"), "{}");
    await assert.rejects(live(["--max-calls", "1", "--save-scores", join(directory, "new.json")]), { code: "max_calls_below_planned" });
    assert.equal(requests.length, 0);
  });
});

test("memory --live makes one rerank request per case, meters it, saves the scores and never prints the key", async () => {
  await withTemp(async (directory) => {
    const { fetchImpl, requests } = memoryRerankFake();
    const save = join(directory, "saved.json");
    const planned = memoryCases.filter((row) => rerankDocuments(row.retrieval).length > 0).length;
    const output = await main(["retrieval", "--semantic", "--live", "--max-calls", String(planned), "--save-scores", save],
      { env: ENV, fetchImpl });
    const comparison = output.semantic["retrieval-ko"];
    assert.equal(requests.length, planned);
    assert.ok(requests.every((request) => request.url === "https://api.cohere.com/v2/rerank" &&
      request.body.model === "rerank-test-model" && request.authorization === `Bearer ${KEY}`));
    assert.equal(comparison.source, "live");
    assert.equal(comparison.paidCalls, planned);
    assert.equal(comparison.live.calls, planned);
    assert.equal(comparison.live.maxCalls, planned);
    assert.equal(comparison.live.searchUnits, planned);
    assert.equal(comparison.live.searchUnitsUnreported, 0);
    assert.ok(comparison.delta.koreanRecallAt5 > 0, "a reranker that knows the answers beats lexical order");
    assert.ok(!JSON.stringify(output).includes(KEY));

    // The saved file reproduces the same comparison with no request.
    const replay = await main(["retrieval", "--semantic", "--rerank-scores", save]);
    assert.deepEqual(replay.semantic["retrieval-ko"].byTag, comparison.byTag);
    assert.deepEqual(replay.semantic["retrieval-ko"].semantic, comparison.semantic);
    assert.equal(requests.length, planned);

    // A second paid run never overwrites the first.
    const before = await readFile(save, "utf8");
    await assert.rejects(main(["retrieval", "--semantic", "--live", "--max-calls", String(planned), "--save-scores", save],
      { env: ENV, fetchImpl }), { code: "save_scores_exists" });
    assert.equal(await readFile(save, "utf8"), before);
    assert.equal(requests.length, planned);
  });
});

test("a failed rerank request stops the run without a retry and keeps what was paid for", async () => {
  await withTemp(async (directory) => {
    const { fetchImpl, requests } = memoryRerankFake(3);
    const save = join(directory, "saved.json");
    const output = await main(["retrieval", "--semantic", "--live", "--max-calls", "100", "--save-scores", save],
      { env: ENV, fetchImpl });
    assert.equal(output.stopReason, "live_call_failed");
    assert.equal(output.semantic["retrieval-ko"].failure, "rate_limited");
    assert.equal(requests.length, 3);
    assert.equal(output.semantic["retrieval-ko"].live.calls, 3);
    const saved = JSON.parse(await readFile(save, "utf8"));
    assert.equal(saved.complete, false);
    assert.equal(Object.keys(saved.scores).length, 2);
    assert.ok(!JSON.stringify(output).includes(KEY));
  });
});

test("the call meter stops at its ceiling before another request", () => {
  const meter = new CallMeter(2);
  meter.take();
  meter.take();
  assert.throws(() => meter.take(), { code: "max_calls_reached" });
  assert.equal(meter.calls, 2);
});

// --- knowledge ----------------------------------------------------------------

const corpus = await loadKnowledgeCorpus();
const indexOf = new Map(corpus.chunks.map((chunk, index) => [chunk.id, index]));
const oneHot = (ids) => {
  const vector = new Int8Array(DIMENSION);
  for (const chunkId of ids) vector[indexOf.get(chunkId)] = 100;
  return vector;
};
const goldOf = (testCase) => new Set(testCase.relevantChunkIds);

/** A "perfect" synthetic provider: a question sits on its gold chunks, which the reranker scores high. */
const knowledgeScores = () => ({
  format: "knowledge-retrieval-scores-v1", corpus: corpus.version,
  chunkVectors: Object.fromEntries(corpus.chunks.map((chunk) => [chunk.id, encodeBase64Vector(oneHot([chunk.id]))])),
  queryVectors: Object.fromEntries(corpus.cases.map((row) => [row.id, encodeBase64Vector(oneHot(row.relevantChunkIds))])),
  rerank: Object.fromEntries(corpus.cases.map((row) => [row.id,
    Object.fromEntries(corpus.chunks.map((chunk) => [chunk.id, goldOf(row).has(chunk.id) ? 0.9 : 0.05]))])),
});

test("the knowledge corpus is synthetic, sized as designed and covers every tag at least four times", () => {
  assert.ok(corpus.chunks.length >= 30 && corpus.chunks.length <= 60);
  assert.ok(corpus.cases.length >= 20 && corpus.cases.length <= 30);
  assert.ok(new Set(corpus.chunks.map((chunk) => chunk.fileId)).size >= 4);
  for (const tag of ["exact", "synonym", "cross_language", "distractor"]) {
    assert.ok(corpus.cases.filter((row) => row.tag === tag).length >= 4, tag);
  }
  assert.ok(corpus.cases.filter((row) => row.tag === "distractor").every((row) => row.distractorChunkIds.length > 0));
  assert.throws(() => parseKnowledgeCorpus({ ...JSON.parse(JSON.stringify({
    version: "x", source: "synthetic", documents: [{ id: "d", name: "n" }],
    chunks: [{ id: "c", documentId: "d", ordinal: 0, content: "내용" }],
    cases: [{ id: "q", tag: "exact", query: "질문", relevantChunkIds: ["missing"] }],
  })) }), /unknown_chunk_reference/);
});

test("knowledge-retrieval without scores measures lexical only and says what is missing", async () => {
  const { knowledgeRetrieval: result } = await main(["knowledge-retrieval"]);
  assert.equal(result.source, "none");
  assert.equal(result.paidCalls, 0);
  assert.equal(result.k, 6);
  assert.equal(result.configs.lexical.available, true);
  assert.equal(result.configs.lexical.byTag.exact.recallAt6, 1);
  assert.equal(result.configs.lexical.byTag.cross_language.recallAt6, 0);
  assert.ok(result.configs.lexical.byTag.synonym.recallAt6 < 0.5);
  for (const name of ["embedOnly", "rerankOnly", "embedRerank"]) assert.equal(result.configs[name].available, false);
  assert.equal(result.configs.embedOnly.reason, "vectors_not_in_scores");
  assert.equal(result.configs.rerankOnly.reason, "rerank_not_in_scores");
});

test("saved vectors and scores lift synonym and cross-language questions; rerank-only cannot find a chunk lexical never offered", async () => {
  await withTemp(async (directory) => {
    const file = join(directory, "scores.json");
    await writeFile(file, JSON.stringify(knowledgeScores()));
    const { knowledgeRetrieval: result } = await main(["knowledge-retrieval", "--scores", file]);
    const { configs } = result;
    assert.equal(result.source, "scores_file");
    assert.deepEqual(Object.values(configs).map((row) => row.available), [true, true, true, true]);
    // Neighbours alone reach a chunk that shares no word with the question.
    assert.equal(configs.embedOnly.byTag.cross_language.recallAt6, 1);
    assert.equal(configs.embedOnly.byTag.synonym.recallAt6, 1);
    assert.equal(configs.embedRerank.byTag.cross_language.recallAt6, 1);
    assert.equal(configs.embedRerank.byTag.synonym.recallAt6, 1);
    assert.equal(configs.embedRerank.mrr, 1);
    assert.equal(configs.embedRerank.distractorsSelected, 0);
    assert.ok(configs.embedRerank.avgSelected < configs.lexical.avgSelected);
    // A reranker only re-orders what lexical retrieval offered.
    assert.equal(configs.rerankOnly.byTag.cross_language.recallAt6, 0);
    assert.equal(configs.rerankOnly.byTag.exact.recallAt6, 1);
    assert.ok(configs.rerankOnly.distractorsSelected < configs.lexical.distractorsSelected);
    assert.ok(configs.embedRerank.recallAt6 > configs.lexical.recallAt6);
    assert.ok(result.differences.embedRerank.some((row) => row.caseId === "k15" && row.gained.includes("manual-0")));
    assert.ok(result.differences.embedRerank.every((row) => row.lost.length === 0));
    assert.deepEqual(configs.embedRerank.stepFallbacks, { embed: [], rerank: [] });
  });
});

test("a question missing from the saved scores keeps the lexical result and is listed", async () => {
  await withTemp(async (directory) => {
    const saved = knowledgeScores();
    delete saved.rerank.k08;
    delete saved.queryVectors.k08;
    const file = join(directory, "scores.json");
    await writeFile(file, JSON.stringify(saved));
    const { configs } = (await main(["knowledge-retrieval", "--scores", file])).knowledgeRetrieval;
    assert.deepEqual(configs.embedRerank.stepFallbacks.embed, ["k08"]);
    assert.deepEqual(configs.embedRerank.stepFallbacks.rerank, ["k08"]);
    assert.ok(configs.embedRerank.byTag.synonym.recallAt6 < 1);
  });
});

test("a scores file for another corpus or with an unknown chunk is refused", async () => {
  await withTemp(async (directory) => {
    const file = join(directory, "scores.json");
    await writeFile(file, JSON.stringify({ ...knowledgeScores(), corpus: "other-corpus" }));
    await assert.rejects(main(["knowledge-retrieval", "--scores", file]), { code: "scores_corpus_mismatch" });
    const unknown = knowledgeScores();
    unknown.rerank.k01.ghost = 0.9;
    await writeFile(file, JSON.stringify(unknown));
    await assert.rejects(main(["knowledge-retrieval", "--scores", file]), { code: "scores_file_invalid" });
    await assert.rejects(main(["knowledge-retrieval", "--scores", join(directory, "missing.json")]), { code: "scores_file_invalid" });
  });
});

const knowledgeFake = (failRerankAt = 0) => {
  const chunkByContent = new Map(corpus.chunks.map((chunk) => [chunk.content, chunk.id]));
  const caseByQuery = new Map(corpus.cases.map((row) => [row.query.normalize("NFC"), row]));
  let reranks = 0;
  return recorder((url, body) => {
    if (url.endsWith("/v2/embed")) {
      const vectors = body.texts.map((text) => Array.from(chunkByContent.has(text)
        ? oneHot([chunkByContent.get(text)]) : oneHot(caseByQuery.get(text).relevantChunkIds)));
      return json({ embeddings: { int8: vectors }, meta: { billed_units: { input_tokens: body.texts.length } } });
    }
    reranks += 1;
    if (reranks === failRerankAt) return json({ message: "boom" }, 500);
    const gold = goldOf(caseByQuery.get(body.query));
    return json({
      results: body.documents.map((text, index) => ({ index, relevance_score: gold.has(chunkByContent.get(text)) ? 0.9 : 0.05 })),
      meta: { billed_units: { search_units: 1 } },
    });
  });
};

test("knowledge --live embeds once, reranks per question, meters, saves, and the saved file replays the same numbers", async () => {
  await withTemp(async (directory) => {
    const { fetchImpl, requests } = knowledgeFake();
    const save = join(directory, "saved.json");
    const { knowledgeRetrieval: result } = await main(
      ["knowledge-retrieval", "--live", "--max-calls", "29", "--save-scores", save], { env: ENV, fetchImpl });
    const embeds = requests.filter((request) => request.url.endsWith("/v2/embed"));
    const reranks = requests.filter((request) => request.url.endsWith("/v2/rerank"));
    assert.deepEqual(embeds.map((request) => request.body.input_type), ["search_document", "search_query"]);
    assert.ok(embeds.every((request) => request.body.model === "embed-test-model" && request.body.embedding_types[0] === "int8"));
    assert.ok(reranks.length > 0 && reranks.length <= corpus.cases.length);
    assert.ok(reranks.every((request) => request.body.model === "rerank-test-model" && request.body.documents.length <= 100));
    assert.equal(result.source, "live");
    assert.equal(result.live.planned, 29);
    assert.equal(result.live.calls, requests.length);
    assert.equal(result.paidCalls, requests.length);
    assert.equal(result.live.searchUnits, reranks.length);
    assert.ok(requests.length <= 29);
    assert.equal(result.configs.embedRerank.mrr, 1);
    assert.ok(!JSON.stringify(result).includes(KEY));

    const replay = (await main(["knowledge-retrieval", "--scores", save])).knowledgeRetrieval;
    assert.deepEqual(replay.configs, result.configs);
    assert.deepEqual(replay.differences, result.differences);
    assert.equal(requests.length, result.live.calls);

    await assert.rejects(main(["knowledge-retrieval", "--live", "--max-calls", "29", "--save-scores", save],
      { env: ENV, fetchImpl }), { code: "save_scores_exists" });
    assert.equal(requests.length, result.live.calls);
  });
});

test("knowledge --live refuses a ceiling below the plan, a missing embed model, and mixing with --scores", async () => {
  await withTemp(async (directory) => {
    const { fetchImpl, requests } = knowledgeFake();
    const save = join(directory, "saved.json");
    const live = (args, env = ENV) => main(["knowledge-retrieval", "--live", ...args], { env, fetchImpl });
    await assert.rejects(live(["--save-scores", save]), { code: "max_calls_required" });
    await assert.rejects(live(["--max-calls", "28", "--save-scores", save]), { code: "max_calls_below_planned" });
    const { COHERE_EMBED_MODEL: _model, ...withoutEmbed } = ENV;
    void _model;
    await assert.rejects(live(["--max-calls", "29", "--save-scores", save], withoutEmbed), { code: "live_env_missing" });
    await assert.rejects(live(["--max-calls", "29", "--save-scores", save, "--scores", save]), { code: "live_and_scores_exclusive" });
    await assert.rejects(main(["knowledge-retrieval", "--max-calls", "9"]), { code: "live_option_without_live" });
    assert.equal(requests.length, 0);
  });
});

test("a failed knowledge request stops without a retry and keeps the vectors already paid for", async () => {
  await withTemp(async (directory) => {
    const { fetchImpl, requests } = knowledgeFake(2);
    const save = join(directory, "saved.json");
    const output = await main(["knowledge-retrieval", "--live", "--max-calls", "29", "--save-scores", save],
      { env: ENV, fetchImpl });
    assert.equal(output.stopReason, "live_call_failed");
    assert.equal(output.knowledgeRetrieval.failure, "provider_error");
    assert.equal(requests.length, 4);
    const saved = JSON.parse(await readFile(save, "utf8"));
    assert.equal(saved.complete, false);
    assert.equal(Object.keys(saved.chunkVectors).length, corpus.chunks.length);
    assert.equal(Object.keys(saved.rerank).length, 1);
    assert.ok(!JSON.stringify(output).includes(KEY));
  });
});

const cli = (args, env) => spawnSync(process.execPath, ["--import", "tsx", "tools/memory-quality/cli.ts", ...args], {
  cwd: resolve("."), encoding: "utf8", timeout: 60000, env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
});

test("outside the react-server condition the offline commands run and --live stops before any request", async () => {
  const offline = cli(["knowledge-retrieval"], {});
  assert.equal(offline.status, 0, offline.stderr);
  assert.equal(JSON.parse(offline.stdout).knowledgeRetrieval.paidCalls, 0);
  await withTemp(async (directory) => {
    const save = join(directory, "never.json");
    const live = cli(["knowledge-retrieval", "--live", "--max-calls", "29", "--save-scores", save], ENV);
    assert.equal(live.status, 2);
    assert.deepEqual(JSON.parse(live.stderr), { error: "live_client_unavailable" });
    assert.ok(!live.stdout.includes(KEY) && !live.stderr.includes(KEY));
    await assert.rejects(readFile(save), { code: "ENOENT" });
  });
});

test("a save path that cannot be written refuses the paid run before any request", async () => {
  await withTemp(async (directory) => {
    const { fetchImpl, requests } = memoryRerankFake();
    const save = join(directory, "no-such-directory", "saved.json");
    await assert.rejects(
      main(["retrieval", "--semantic", "--live", "--max-calls", "100", "--save-scores", save], { env: ENV, fetchImpl }),
      { code: "save_scores_unwritable" }
    );
    assert.equal(requests.length, 0);
  });
});

test("the save file holds every paid result as the run goes, not only at the end", async () => {
  await withTemp(async (directory) => {
    const save = join(directory, "saved.json");
    const { fetchImpl: inner, requests } = memoryRerankFake();
    const seen = [];
    // Before each request after the first, the file already holds the
    // previous answers: a crash between two requests loses nothing paid for.
    const fetchImpl = async (...args) => {
      if (requests.length > 0) {
        const saved = JSON.parse(await readFile(save, "utf8"));
        seen.push([requests.length, Object.keys(saved.scores).length, saved.complete]);
      }
      return inner(...args);
    };
    const planned = memoryCases.filter((row) => rerankDocuments(row.retrieval).length > 0).length;
    await main(["retrieval", "--semantic", "--live", "--max-calls", String(planned), "--save-scores", save], { env: ENV, fetchImpl });
    assert.ok(seen.length > 0);
    for (const [paid, saved, complete] of seen) {
      assert.equal(saved, paid);
      assert.equal(complete, false);
    }
    assert.equal(JSON.parse(await readFile(save, "utf8")).complete, true);
  });
});
