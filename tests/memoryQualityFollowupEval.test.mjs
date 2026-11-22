import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { main } from "../tools/memory-quality/cli.ts";
import { followupMessages } from "../tools/memory-quality/followupEval.ts";
import { buildFollowupBundle, followupRetrievalCases } from "../tools/memory-quality/followupSchema.ts";
import { rerankDocuments } from "../tools/memory-quality/productRetrieval.ts";
import { memoryEvaluationCorpusDigest, memoryEvaluationInputIdentity } from "../tools/memory-quality/semanticMemory.ts";
import { MEMORY_SEMANTIC_DEFAULTS, MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION } from "../lib/memoryRetrievalScoring.ts";
import { MEMORY_CONTEXT_RULES } from "../lib/memoryContextPrompt.ts";

const fixture = name => new URL(`../tools/memory-quality/fixtures/${name}`, import.meta.url);
const devInputs = JSON.parse(await readFile(fixture("followup-dev.inputs.json"), "utf8"));
const devKey = JSON.parse(await readFile(fixture("followup-dev.key.json"), "utf8"));

/** A test-only scenario: the history topic is unrelated to a question with a direct lexical match. */
const withTeaScenario = () => {
    const inputs = structuredClone(devInputs), key = structuredClone(devKey);
    inputs.scenarios.push({ scenarioId: "dev-en-02", originalLanguage: "en", derivedFrom: null,
        pool: [
            { id: "tea", kind: "preference", statement: "The user drinks green tea in the morning." },
            { id: "kestrel", kind: "project", statement: "Project Kestrel ships on June 2." },
        ],
        variants: [
            { variantId: "unrelated-history", contrast: "History is about another topic.",
                conversation: [{ role: "user", content: "Let's finish the Kestrel shipping talk." },
                    { role: "assistant", content: "Done with Kestrel." }],
                currentQuery: "What tea do I drink in the morning?" },
            { variantId: "nothing-relevant", contrast: "Nothing in the account answers the question.",
                conversation: [{ role: "user", content: "Planning a weekend trip." }],
                currentQuery: "Which airline do I usually fly?" },
        ] });
    const base = { evidenceSource: "memory_only", activeProject: null, latestCorrection: false, distractorMemoryIds: [],
        acceptableVariants: [], forbiddenFacts: [], notes: "test" };
    key.cases["dev-en-02__unrelated-history"] = { ...base, phenomena: ["irrelevant_history"], expectedBehavior: "answer",
        goldMemoryIds: ["tea"], requiredFacts: ["green tea"] };
    key.cases["dev-en-02__nothing-relevant"] = { ...base, phenomena: ["evidence_absent"], expectedBehavior: "insufficient",
        evidenceSource: "unavailable", goldMemoryIds: [], requiredFacts: [], forbiddenFacts: ["any airline name"] };
    return { inputs, key };
};

const withTemp = async body => {
    const directory = await mkdtemp(join(tmpdir(), "memory-followup-"));
    try { return await body(directory); } finally { await rm(directory, { recursive: true, force: true }); }
};
const writeJson = async (directory, name, value) => {
    const file = join(directory, name);
    await writeFile(file, JSON.stringify(value));
    return file;
};
const readOut = async (out, name) => JSON.parse(await readFile(join(out, name), "utf8"));
const run = async (directory, files, extra = []) => {
    const out = join(directory, `out-${Math.random().toString(36).slice(2)}`);
    await main(["followup-eval", "--inputs", files.inputs, "--key", files.key, "--out", out, ...extra]);
    return { out, report: await readOut(out, "report.json") };
};

const preparation = { model: "rerank-v4.0-fast", billing: { unit: "search_unit" } };
/** A provider-shaped score file; `kind` decides whether it may count as a measurement. */
const scoreFile = (bundle, mode, scoreFor, kind = "provider") => {
    const cases = followupRetrievalCases(bundle);
    // compareMemory requires the input contract for any provider full-query file.
    const prep = kind === "provider" ? preparation : undefined;
    return {
        format: "memory-rerank-scores-v1", corpus: bundle.bundleId,
        scores: Object.fromEntries(cases.map(row => [row.id, Object.fromEntries(rerankDocuments(row.retrieval)
            .map(doc => [doc.id, scoreFor(row.id, doc.id)]))])),
        provenance: {
            kind, provider: "cohere", model: preparation.model, collectedAt: "2026-11-23T00:00:00.000Z",
            corpusDigest: memoryEvaluationCorpusDigest(cases, mode, prep),
            requests: Object.fromEntries(cases.map(row => [row.id, memoryEvaluationInputIdentity(row, mode, prep)])),
            settings: { queryVersion: "memory-query-v4", queryMode: mode,
                ...(prep ? { billingUnit: "search_unit" } : {}),
                retrievalVersion: MEMORY_SEMANTIC_RETRIEVAL_ALGORITHM_VERSION, ...MEMORY_SEMANTIC_DEFAULTS },
        },
    };
};

test("the bundle refuses dangling, duplicate or missing key references and keeps key fields out of inputs", () => {
    assert.equal(buildFollowupBundle(devInputs, devKey).cases.length, 4);
    const missing = structuredClone(devKey);
    delete missing.cases["dev-ko-01__stay"];
    assert.throws(() => buildFollowupBundle(devInputs, missing), { code: "followup_key_missing_case" });
    const dangling = structuredClone(devKey);
    dangling.cases["dev-ko-01__stay"].goldMemoryIds = ["orion"];
    assert.throws(() => buildFollowupBundle(devInputs, dangling), { code: "followup_key_unknown_memory" });
    const extra = structuredClone(devKey);
    extra.cases["dev-ko-01__other"] = extra.cases["dev-ko-01__stay"];
    assert.throws(() => buildFollowupBundle(devInputs, extra), { code: "followup_key_unknown_case" });
    const leaked = structuredClone(devInputs);
    leaked.scenarios[0].variants[0].goldMemoryIds = ["parang"];
    assert.throws(() => buildFollowupBundle(leaked, devKey), { code: "followup_inputs_invalid" });
    const duplicated = structuredClone(devInputs);
    duplicated.scenarios[1].variants[1].variantId = "compare";
    assert.throws(() => buildFollowupBundle(duplicated, devKey), { code: "followup_duplicate_variant" });
});

test("search reads at most two earlier user messages while the answer keeps the whole conversation in role order", () => {
    const bundle = buildFollowupBundle(devInputs, devKey);
    const sw = bundle.cases.find(row => row.caseId === "dev-ko-01__switch");
    assert.deepEqual(sw.searchHistory, ["누리 학습앱 베타 준비 상황을 같이 보자.", "아, 그거 말고 파랑 카페 리뉴얼 이야기로 바꾸자."]);
    const long = structuredClone(devInputs);
    long.scenarios[0].variants[0].conversation.unshift({ role: "user", content: "oldest" }, { role: "assistant", content: "ok" });
    assert.equal(buildFollowupBundle(long, devKey).cases[0].searchHistory.length, 2);
    const parang = { memory: { id: "parang", kind: "project", statement: sw.pool[1].statement }, tier: "relevant" };
    const messages = followupMessages(sw, { selected: [parang] });
    assert.deepEqual(messages.map(row => row.role), ["system", "user", "user", "assistant", "user", "assistant", "user"]);
    assert.ok(messages[0].content.includes(MEMORY_CONTEXT_RULES), "app rules stay at system authority");
    assert.ok(messages[1].content.includes("<<<ACCOUNT_MEMORY>>>") && messages[1].content.includes("메뉴판 디자인"));
    assert.deepEqual(messages.slice(2, -1), sw.conversation, "assistant turns stay in the answer conversation");
    assert.equal(messages.at(-1).content, sw.currentQuery);
    const empty = followupMessages(sw, { selected: [] });
    assert.deepEqual(empty, [...sw.conversation, { role: "user", content: sw.currentQuery }],
        "an empty selection sends no memory block, the same as no-memory");
    assert.deepEqual(followupMessages(sw, null), empty);
});

test("model-visible requests carry no key, and the evaluation digest moves with gold but search identity does not", async () => {
    await withTemp(async directory => {
        const files = { inputs: await writeJson(directory, "i.json", devInputs), key: await writeJson(directory, "k.json", devKey) };
        const { out, report } = await run(directory, files);
        const requests = JSON.stringify((await readOut(out, "answer-requests.json")).requests);
        for (const leaked of ["goldMemoryIds", "distractorMemoryIds", "forbiddenFacts", "requiredFacts", "expectedBehavior",
            "phenomena", "project_switch", "The latest explicit switch selects Parang.", "QA 책임"]) {
            assert.ok(!requests.includes(leaked), leaked);
        }
        const sheet = JSON.stringify(await readOut(out, "blind-sheet.json"));
        for (const hidden of ["lexical", "full-query", "rerank", "harbor-grant", "/relevant"]) assert.ok(!sheet.includes(hidden), hidden);
        const changed = structuredClone(devKey);
        changed.cases["dev-ko-01__switch"].requiredFacts.push("메뉴판");
        const before = buildFollowupBundle(devInputs, devKey), after = buildFollowupBundle(devInputs, changed);
        assert.notEqual(before.evalDigest, after.evalDigest);
        assert.equal(report.bundle.evalDigest, before.evalDigest);
        const mode = "full-query+history";
        assert.deepEqual(followupRetrievalCases(after).map(row => memoryEvaluationInputIdentity(row, mode)),
            followupRetrievalCases(before).map(row => memoryEvaluationInputIdentity(row, mode)));
    });
});

test("history adoption records gain, loss and displacement fallback against the same candidates", async () => {
    await withTemp(async directory => {
        const raw = withTeaScenario();
        const bundle = buildFollowupBundle(raw.inputs, raw.key);
        const files = { inputs: await writeJson(directory, "i.json", raw.inputs), key: await writeJson(directory, "k.json", raw.key) };
        const fullQuery = scoreFile(bundle, "full-query", (caseId, id) => ({
            "dev-ko-01__switch": { nuri: 0.7, parang: 0.05 }, "dev-en-01__single": { "harbor-grant": 0.9, "riverside-grant": 0.05 },
            "dev-en-02__unrelated-history": { tea: 0.9, kestrel: 0.05 },
        })[caseId]?.[id] ?? 0.05);
        const withHistory = scoreFile(bundle, "full-query+history", (caseId, id) => ({
            "dev-ko-01__switch": { nuri: 0.05, parang: 0.9 }, "dev-en-01__single": { "harbor-grant": 0.05, "riverside-grant": 0.9 },
            "dev-en-02__unrelated-history": { tea: 0.05, kestrel: 0.9 },
        })[caseId]?.[id] ?? 0.05);
        const { report } = await run(directory, files, [
            "--scores-full-query", await writeJson(directory, "fq.json", fullQuery),
            "--scores-full-query-history", await writeJson(directory, "fqh.json", withHistory)]);
        assert.deepEqual(report.conditions.map(row => row.status), ["measured", "measured", "measured", "measured"]);
        const at = (caseId, condition) => report.cases.find(row => row.caseId === caseId).retrieval[condition];
        assert.deepEqual(at("dev-ko-01__switch", "full-query").injected.filter(row => row.tier === "relevant").map(row => row.id), ["nuri"]);
        assert.deepEqual(at("dev-ko-01__switch", "full-query+history").injected.filter(row => row.tier === "relevant").map(row => row.id), ["parang"], "gain");
        assert.equal(at("dev-ko-01__switch", "full-query+history").historyCount, 2);
        const single = at("dev-en-01__single", "full-query+history");
        assert.deepEqual(single.injected.filter(row => row.tier === "relevant").map(row => row.id), ["riverside-grant"],
            "loss: a distractor with its own term match is adopted, so no fallback");
        assert.deepEqual(single.alwaysOn, ["bullets"], "always-on style is counted apart from gold");
        const tea = at("dev-en-02__unrelated-history", "full-query+history");
        assert.equal(tea.fallback, "history_displaced_current_query");
        assert.deepEqual(tea.injected.map(row => row.id), ["tea"]);
        assert.equal(at("dev-en-02__nothing-relevant", "lexical").correctEmpty, true, "a valid empty selection is success, not a miss");
        const primary = report.pairs.find(row => row.left === "full-query" && row.right === "full-query+history").retrievalGoldComplete;
        assert.equal(primary.onlyRight, 1, "history gain on the switch case");
        assert.equal(primary.onlyLeft, 1, "history loss on the single-grant case");
        assert.equal(primary.pairedCases + primary.excluded, 5);
        assert.equal(report.retrieval["full-query+history"].all.historyFallbacks, 1);
        assert.equal(report.retrieval.lexical.all.correctEmptySelection.display, "1/1");
        assert.equal(report.answers.answerQuality.status, "not_run");
    });
});

test("mock or oracle scores and stale identities never enter measured retrieval", async () => {
    await withTemp(async directory => {
        const bundle = buildFollowupBundle(devInputs, devKey);
        const files = { inputs: await writeJson(directory, "i.json", devInputs), key: await writeJson(directory, "k.json", devKey) };
        const oracle = scoreFile(bundle, "full-query", (_caseId, id) => id === "parang" ? 0.9 : 0.05, "oracle");
        const stale = scoreFile(bundle, "full-query+history", () => 0.5);
        stale.provenance.requests["dev-ko-01__switch"].historyHash = "0".repeat(64);
        const { report } = await run(directory, files, ["--scores-full-query", await writeJson(directory, "o.json", oracle),
            "--scores-full-query-history", await writeJson(directory, "s.json", stale)]);
        const fq = report.conditions.find(row => row.condition === "full-query");
        assert.deepEqual([fq.status, fq.evidence], ["unmeasured", "oracle"]);
        assert.equal(report.retrieval["full-query"].all.measuredCases, 0);
        assert.equal(report.retrieval["full-query"].all.goldRecallFull.display, "N/A");
        assert.deepEqual(report.conditions.find(row => row.condition === "full-query+history").status, "refused");
        assert.equal(report.retrieval["full-query+history"], null);
        const legacy = fileURLToPath(new URL("../.github/audits/artifacts/memory-relevance-2026-11-15/scores-full-query+history.json", import.meta.url));
        const old = await run(directory, files, ["--scores-full-query-history", legacy]);
        assert.equal(old.report.conditions.find(row => row.condition === "full-query+history").reason, "scores_corpus_mismatch");
    });
});

test("blind answers bind to the messages, reveal conditions only after frozen verdicts, and score each judgment", async () => {
    await withTemp(async directory => {
        const raw = withTeaScenario();
        const files = { inputs: await writeJson(directory, "i.json", raw.inputs), key: await writeJson(directory, "k.json", raw.key) };
        const first = await run(directory, files);
        const { requests, evalDigest, bundleId } = await readOut(first.out, "answer-requests.json");
        assert.deepEqual([...new Set(requests.map(row => row.condition))], ["lexical", "no-memory"]);
        const texts = {
            // Right selection, wrong answer: the other project's role is stated for the active one.
            "dev-ko-01__switch": { lexical: "파랑 카페 리뉴얼에서 QA 리드, 3월 4일입니다.", "no-memory": "어떤 프로젝트인지 알려 주세요." },
            "dev-ko-01__stay": { lexical: "누리 학습앱: QA 리드, 베타 3월 4일.", "no-memory": "누리 학습앱: QA 리드, 베타 3월 4일." },
            "dev-en-01__compare": { lexical: "- Harbor Library: $40,000\n- Riverside Arts: $12,500", "no-memory": "I don't have those caps." },
            // A distractor was injected, yet the answer is right and mentions the other grant only as contrast.
            "dev-en-01__single": { lexical: "$40k for Harbor Library (Riverside's $12,500 is the other grant).", "no-memory": "I don't know." },
            "dev-en-02__unrelated-history": { lexical: "Green tea.", "no-memory": "I don't know." },
        };
        const answers = { format: "memory-followup-answers-v1", bundleId, evalDigest,
            generator: { kind: "provider", provider: "test", model: "fixture-model", collectedAt: "2026-11-23T00:00:00.000Z",
                settings: { temperature: 0 } },
            answers: requests.filter(row => texts[row.caseId]).map(row => ({ caseId: row.caseId, condition: row.condition,
                messagesDigest: row.messagesDigest, promptVersion: row.promptVersion, text: texts[row.caseId][row.condition] })) };
        answers.answers.push({ ...answers.answers[0], condition: "full-query" });
        answers.answers.push({ ...answers.answers[1], caseId: "dev-ko-01__stay" });
        const answersFile = await writeJson(directory, "answers.json", answers);
        const second = await run(directory, files, ["--answers", answersFile]);
        assert.equal(second.report.answers.answerQuality.status, "unjudged");
        assert.deepEqual(second.report.answers.rejected.map(row => row.reason).sort(), ["messages_digest_mismatch", "unknown_request"]);
        assert.equal(second.report.answers.byCondition, null, "no condition-level verdicts before freezing");
        assert.ok(second.report.cases.every(row => Object.values(row.answers).every(answer => !("label" in answer))));
        const sheet = await readOut(second.out, "blind-sheet.json");
        assert.equal(sheet.items.find(row => row.caseId === "dev-ko-01__stay").answers.length, 1, "equal answers share one label");
        const map = (await readOut(second.out, "blind-map.json")).map;
        const labelOf = (caseId, condition) => Object.entries(map[caseId]).find(([, row]) => row.conditions.includes(condition))[0];
        const verdict = (caseId, condition, fields) => ({ caseId, label: labelOf(caseId, condition), correct: true,
            followedLatestCorrection: raw.key.cases[caseId].latestCorrection ? true : null, crossProjectAssertion: false,
            askedClarification: false, unsupportedAssertion: false, evidence: "judged against the key", ...fields });
        const verdicts = { format: "memory-followup-verdicts-v1", bundleId, sheetDigest: sheet.sheetDigest, judge: "test judge",
            frozenAt: "2026-11-23T01:00:00.000Z", verdicts: [
                verdict("dev-ko-01__switch", "lexical", { correct: false, followedLatestCorrection: true, crossProjectAssertion: true,
                    unsupportedAssertion: false }),
                verdict("dev-ko-01__switch", "no-memory", { correct: false, askedClarification: true }),
                verdict("dev-ko-01__stay", "lexical"),
                verdict("dev-en-01__compare", "lexical"),
                verdict("dev-en-01__compare", "no-memory", { correct: false }),
                verdict("dev-en-01__single", "lexical"),
                verdict("dev-en-02__unrelated-history", "lexical"),
                { ...verdict("dev-en-02__unrelated-history", "no-memory"), evidence: " " },
            ] };
        const third = await run(directory, files, ["--answers", answersFile, "--verdicts", await writeJson(directory, "v.json", verdicts)]);
        const { answers: result } = third.report;
        assert.equal(result.conditionsRevealed, true);
        assert.deepEqual(result.verdicts.rejected.map(row => row.reason), ["evidence_required"]);
        assert.equal(result.answerQuality.status, "judged");
        const lexical = result.byCondition.lexical.all;
        assert.equal(lexical.correct.display, "4/5");
        assert.equal(lexical.crossProjectAssertion.display, "1/3", "comparison is outside the mixing denominator");
        assert.equal(lexical.latestCorrectionFollowed.display, "1/1");
        assert.equal(lexical.clarificationWhenNeeded.display, "N/A");
        assert.equal(result.byCondition["no-memory"].all.unnecessaryClarification.display, "1/3");
        assert.equal(result.byCondition["no-memory"].all.missing.unjudged, 2);
        const single = third.report.cases.find(row => row.caseId === "dev-en-01__single");
        assert.deepEqual(single.retrieval.lexical.distractorInjected, ["riverside-grant"]);
        assert.equal(single.answers.lexical.verdict.correct, true, "impure selection, correct answer");
        const sw = third.report.cases.find(row => row.caseId === "dev-ko-01__switch");
        assert.equal(sw.answers.lexical.verdict.correct, false);
        const memoryPair = third.report.pairs.find(row => row.left === "no-memory").answerCorrect;
        // stay: both right (one shared label); compare: memory only; switch: both wrong;
        // single (no-memory unjudged), tea (verdict refused) and nothing-relevant (no answer) are excluded.
        assert.deepEqual([memoryPair.bothCorrect, memoryPair.onlyLeft, memoryPair.onlyRight, memoryPair.bothWrong, memoryPair.excluded],
            [1, 0, 1, 1, 3]);
        const incomplete = third.report.pairs.find(row => row.left === "full-query").answerCorrect;
        assert.equal(incomplete.pairedCases, 0, "a one-sided pair is never counted");
        assert.ok((await readFile(join(third.out, "report.md"), "utf8")).includes("N/A"));

        const changedKey = structuredClone(raw.key);
        changedKey.cases["dev-ko-01__stay"].forbiddenFacts.push("4/18");
        const changedFiles = { inputs: files.inputs, key: await writeJson(directory, "k2.json", changedKey) };
        const stale = await run(directory, changedFiles, ["--answers", answersFile, "--verdicts", await writeJson(directory, "v2.json", verdicts)]);
        assert.equal(stale.report.answers.accepted, 0, "answers bound to the old gold are refused");
        assert.equal(stale.report.answers.answerQuality.reason, "answers_eval_digest_mismatch");
        assert.equal(stale.report.answers.verdicts.file.refused, "verdicts_sheet_digest_mismatch");

        const mock = await run(directory, files, ["--answers", await writeJson(directory, "mock.json",
            { ...answers, generator: { ...answers.generator, kind: "mock" } })]);
        assert.equal(mock.report.answers.answerQuality.status, "not_run");
        assert.equal(mock.report.answers.answerQuality.reason, "answer_source_mock");
    });
});

test("the CLI keeps --corpus all and refuses half a bundle", async () => {
    const result = await main(["retrieval", "--corpus", "all"]);
    assert.deepEqual(Object.keys(result.retrieval).sort(), ["development", "relevance", "retrieval-ko", "validation"]);
    assert.equal(result.retrieval.relevance.summary.recalled, 6);
    await assert.rejects(main(["followup-eval", "--inputs", "x.json"]), { code: "followup_inputs_and_key_required" });
});
