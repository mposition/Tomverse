import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../tools/memory-quality/cli.ts";
import { loadRetrievalCases, rerankDocuments, productSelection } from "../tools/memory-quality/productRetrieval.ts";
import {
    compareMemory, memoryEvaluationInputIdentity, memoryEvaluationCorpusDigest,
    memoryEvaluationQueryPlan, loadMemoryScores,
} from "../tools/memory-quality/semanticMemory.ts";
import { MEMORY_SEMANTIC_DEFAULTS, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION } from "../lib/memoryRetrievalScoring.ts";
import { digest } from "../tools/memory-quality/schema.ts";

const modes = ["current-query", "full-query", "full-query+history"];
const cases = await loadRetrievalCases("relevance");
const recordedHistoryFile = new URL("../.github/audits/artifacts/memory-relevance-2026-11-15/scores-full-query+history.json", import.meta.url);

test("recorded provider displacement falls back to the current-query selection without a new model call", async () => {
    const recorded = JSON.parse(await readFile(recordedHistoryFile, "utf8"));
    const coffee = cases.find(row => row.id === "irrelevant_history");
    const scores = new Map(Object.entries(recorded.scores[coffee.id]));
    const ids = hasHistory => productSelection(coffee.retrieval, scores, hasHistory).map(row => row.id);
    assert.deepEqual(ids(false), ["atlas"], "the historical response reproduces the observed displacement");
    assert.deepEqual(ids(true), ["coffee"], "contextual validation restores the complete lexical fallback");
    const bareScores = Object.assign(new Map([[coffee.id, scores]]), { corpus: "relevance" });
    const comparison = compareMemory("relevance", [coffee], bareScores, "full-query+history");
    assert.deepEqual(comparison.coverage.casesRejectedForHistoryDisplacement, [coffee.id]);
    assert.deepEqual(comparison.coverage.casesFallingBackToLexical, [coffee.id]);
    assert.equal(comparison.semantic.recalled, 1);
    assert.equal(comparison.scoreEvidence.semanticRetrievalMeasured, false, "a local reprocessing is not a new provider measurement");
    for (const [id, expected] of [["candidate_absent", []], ["copied_user_material", ["atlas"]]]) {
        const testCase = cases.find(row => row.id === id);
        assert.deepEqual(productSelection(testCase.retrieval, new Map(Object.entries(recorded.scores[id])), true)
            .map(row => row.id), expected, id);
    }
});

test("historical v3 score provenance cannot silently claim the revised contextual selection policy", async () => {
    const scores = await loadMemoryScores(fileURLToPath(recordedHistoryFile));
    assert.throws(() => compareMemory("relevance", cases, scores, "full-query+history"), { code: "scores_corpus_mismatch" });
});
const withTemp = async (body) => {
    const directory = await mkdtemp(join(tmpdir(), "memory-relevance-"));
    try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const snapshot = (mode) => ({
    format: "memory-rerank-scores-v1", corpus: "relevance",
    scores: Object.fromEntries(cases.map(row => [row.id, Object.fromEntries(rerankDocuments(row.retrieval)
        .map(doc => [doc.id, row.retrieval.relevantIds.includes(doc.id) ? 0.9 : 0.05]))])),
    provenance: {
        kind: "oracle", provider: "cohere", model: "rerank-v4.0-fast", collectedAt: "2026-11-15T00:00:00.000Z",
        corpusDigest: memoryEvaluationCorpusDigest(cases, mode),
        requests: Object.fromEntries(cases.map(row => [row.id, memoryEvaluationInputIdentity(row, mode)])),
        settings: { queryVersion: memoryEvaluationQueryPlan(cases[0], mode).version, queryMode: mode,
            retrievalVersion: MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION, ...MEMORY_SEMANTIC_DEFAULTS },
    },
});

test("the relevance corpus records scoped history, long middle conditions and explicit unsupported cases", () => {
    assert.ok(cases.length >= 10);
    for (const tag of ["project_omission", "project_switch", "latest_correction", "long_middle", "mixed_script",
        "irrelevant_history", "no_relevant", "candidate_absent", "assistant_reference", "copied_user_material"]) {
        assert.ok(cases.some(row => row.tag === tag), tag);
    }
    assert.ok(cases.every(row => row.retrieval.history.length <= 2));
    assert.ok(cases.find(row => row.tag === "assistant_reference").limitation);
});

test("three modes isolate full-query preservation from history without changing candidate provenance", () => {
    const project = cases.find(row => row.tag === "project_omission");
    const identities = modes.map(mode => memoryEvaluationInputIdentity(project, mode));
    assert.equal(identities[0].queryHash, identities[1].queryHash, "short current queries stay equal");
    assert.notEqual(identities[1].queryHash, identities[2].queryHash);
    assert.deepEqual(identities.map(row => row.candidateIds), Array(3).fill(identities[0].candidateIds));
    assert.ok(identities.every(row => row.candidatesHash === identities[0].candidatesHash));
    const middle = cases.find(row => row.tag === "long_middle");
    assert.ok(!memoryEvaluationQueryPlan(middle, "current-query").semanticQuery.includes("아틀라스만 적용"));
    assert.ok(memoryEvaluationQueryPlan(middle, "full-query").semanticQuery.includes("아틀라스만 적용"));
    const changed = structuredClone(project);
    changed.retrieval.history[0] = "베가만 다룬다.";
    assert.notEqual(memoryEvaluationInputIdentity(changed, "full-query+history").historyHash, identities[2].historyHash);
});

test("saved score identities bind query mode, history, effective query, model, corpus and candidates", async () => {
    await withTemp(async directory => {
        const file = join(directory, "scores.json");
        await writeFile(file, JSON.stringify(snapshot("full-query+history")));
        const scores = await loadMemoryScores(file);
        const report = compareMemory("relevance", cases, scores, "full-query+history");
        assert.equal(report.queryMode, "full-query+history");
        assert.equal(report.scoreEvidence.model, "rerank-v4.0-fast");
        assert.equal(report.scoreEvidence.kind, "oracle");
        assert.equal(report.scoreEvidence.semanticRetrievalMeasured, false);
        assert.equal(report.answerQuality.status, "not_run");
        assert.ok(report.requests.project_omission.historyHash);
        assert.ok(report.requests.project_omission.queryHash);
        assert.equal(report.requests.project_omission.historyCount, 1);
        assert.equal(report.requests.project_omission.candidateProvenance, "same_product_lexical_and_extra_pool");
        assert.throws(() => compareMemory("relevance", cases, scores, "full-query"), { code: "scores_corpus_mismatch" });
        const changed = structuredClone(cases);
        changed[0].retrieval.history[0] = "다른 프로젝트";
        assert.throws(() => compareMemory("relevance", changed, scores, "full-query+history"), { code: "scores_corpus_mismatch" });
    });
});

test("the CLI exposes each evaluation mode and refuses accidental mode names without network", async () => {
    await withTemp(async directory => {
        for (const mode of modes) {
            const file = join(directory, `${mode.replaceAll("+", "-")}.json`);
            await writeFile(file, JSON.stringify(snapshot(mode)));
            const result = await main(["retrieval", "--corpus", "relevance", "--semantic", "--rerank-scores", file, "--query-mode", mode]);
            assert.equal(result.semantic.relevance.queryMode, mode);
            assert.equal(result.semantic.relevance.paidCalls, 0);
        }
        await assert.rejects(main(["retrieval", "--query-mode", "other"]), { code: "unknown_query_mode" });
    });
});

// --live is exercised only behind a fake fetch and synthetic configuration.
test("full-query evaluation sends and records the same long effective query without a hidden wire clip", async () => {
    await withTemp(async directory => {
        const file = join(directory, "mock-scores.json");
        const requests = [];
        const env = { COHERE_API_KEY: "synthetic-key", COHERE_RERANK_MODEL: "rerank-v5.0-fast",
            COHERE_RERANK_MICROUSD_PER_MILLION_TOKENS: "1000000" };
        const fetchImpl = async (_url, init) => {
            const body = JSON.parse(init.body);
            requests.push(body);
            return new Response(JSON.stringify({
                results: body.documents.map((_doc, index) => ({ index, relevance_score: 0.8 })),
                meta: { billed_units: { input_tokens: 123 } },
            }));
        };
        const output = await main(["retrieval", "--corpus", "relevance", "--semantic", "--query-mode", "full-query+history",
            "--live", "--max-calls", "20", "--save-scores", file], { env, fetchImpl });
        const report = output.semantic.relevance;
        assert.equal(report.scoreEvidence.kind, "mock");
        assert.equal(report.scoreEvidence.semanticRetrievalMeasured, false);
        assert.equal(report.answerQuality.status, "not_run");
        for (const row of cases.filter(row => rerankDocuments(row.retrieval).length > 0)) {
            const query = memoryEvaluationQueryPlan(row, "full-query+history").semanticQuery;
            const sent = requests.find(request => request.query === query);
            assert.ok(sent, row.id);
            assert.equal(report.requests[row.id].queryHash, digest(sent.query));
        }
        const middle = requests.find(request => request.query.includes("아틀라스만 적용하고 베가는 제외하세요."));
        assert.ok(Buffer.byteLength(middle.query) > 400);
        assert.equal(report.live.rerankInputTokens, requests.length * 123);
        assert.equal(report.live.rerankInputTokensUnreported, 0);
        const saved = JSON.parse(await readFile(file, "utf8"));
        assert.equal(saved.provenance.settings.billingUnit, "token");
        const replay = await main(["retrieval", "--corpus", "relevance", "--semantic", "--query-mode", "full-query+history",
            "--rerank-scores", file]);
        assert.deepEqual(replay.semantic.relevance.requests, report.requests);
        assert.equal(replay.semantic.relevance.paidCalls, 0);
    });
});

test("full-query evaluation refuses unknown models or unconfigured billing before any mock provider dispatch", async () => {
    await withTemp(async directory => {
        let calls = 0;
        const fetchImpl = async () => { calls += 1; throw new Error("must not dispatch"); };
        const args = ["retrieval", "--corpus", "relevance", "--semantic", "--query-mode", "full-query",
            "--live", "--max-calls", "20", "--save-scores", join(directory, "not-created.json")];
        await assert.rejects(main(args, { env: { COHERE_API_KEY: "fake", COHERE_RERANK_MODEL: "unknown-model",
            COHERE_RERANK_MICROUSD_PER_MILLION_TOKENS: "1000000" }, fetchImpl }), { code: "evaluation_model_query_contract_unknown" });
        await assert.rejects(main(args, { env: { COHERE_API_KEY: "fake", COHERE_RERANK_MODEL: "rerank-v4.0-fast" }, fetchImpl }),
            { code: "evaluation_rerank_billing_not_configured" });
        assert.equal(calls, 0);
    });
});
