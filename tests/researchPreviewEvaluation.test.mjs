import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, unlinkSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { AVAILABLE_MODELS } from "../lib/models.ts";
import {
  RESEARCH_EVALUATION_CASES, RESEARCH_EVALUATION_CREDENTIAL_SCOPE, RESEARCH_EVALUATION_MAX_MICRO_USD,
  buildResearchEvaluationManifest, resolveResearchEvaluationModel, researchEvaluationDigest,
  validateResearchEvaluationApproval, researchEvaluationMeasuredCost, rerankResearchEvaluationSnippets,
} from "../lib/researchPreviewEvaluation.ts";
import { runResearchEvaluationCli } from "../scripts/research-preview-evaluate.mjs";

const now = Date.parse("2026-11-15T00:00:00Z");
const proposal = (extra = {}) => buildResearchEvaluationManifest({ sourceDigest: "a".repeat(64),
  currentDate: "2026-11-15", expiresAt: "2026-11-15T01:00:00Z", maxTotalMicroUsd: RESEARCH_EVALUATION_MAX_MICRO_USD, ...extra });
const approval = (manifest, extra = {}) => ({ version: 2, manifestDigest: manifest.manifestDigest,
  approvedBy: "Offline fixture reviewer", approvedAt: "2026-11-15T00:00:00Z",
  credentialScope: RESEARCH_EVALUATION_CREDENTIAL_SCOPE, maxTotalMicroUsd: manifest.maxTotalMicroUsd, ...extra });

test("default comparison freezes Argon/Luna on one public brief inside six calls and US$10", () => {
  const manifest = proposal();
  assert.deepEqual(manifest.models.map(model => model.id), ["gemini-4-argon", "gpt-6-luna"]);
  assert.deepEqual(manifest.models.map(model => model.reasoning), ["low", "low"]);
  assert.deepEqual(manifest.providers, ["brave", "google", "openai"]);
  assert.equal(new Set(manifest.cases.map(entry => entry.question)).size, 1);
  assert.equal(manifest.maxModelCalls, 6); assert.equal(manifest.maxSearchAttempts, 10); assert.equal(manifest.maxPageReads, 4);
  assert.ok(manifest.totalReservedMicroUsd < manifest.maxTotalMicroUsd);
  assert.equal(manifest.totalReservedMicroUsd, manifest.cases.reduce((sum, entry) => sum + entry.reservedMicroUsd, 0));
  const argon = manifest.cases[0].budget;
  assert.equal(argon.inputUsdPerMillionTokens, 4); assert.equal(argon.outputUsdPerMillionTokens, 20);
  assert.equal(argon.cachedInputPriceMultiplier, 1); assert.equal(argon.maxOutputTokens, 4096);
  assert.ok(argon.inputTokens <= 3 * argon.contextInputTokens + 2 * argon.maxOutputTokens);
  const { manifestDigest, ...body } = manifest;
  assert.equal(manifestDigest, researchEvaluationDigest(body));
  assert.equal(researchEvaluationDigest({ b: [2, 1], a: "value" }), researchEvaluationDigest({ a: "value", b: [2, 1], absent: undefined }));
});

test("development clones preserve catalogue config and exact hosted Command A+ pricing", () => {
  const before = JSON.stringify(AVAILABLE_MODELS);
  const baseline = proposal({ modelIds: ["gemini-3-1-pro"], caseIds: RESEARCH_EVALUATION_CASES.slice(0, 2).map(entry => entry.id) });
  assert.equal(baseline.cases.length, 2);
  const command = proposal({ modelIds: ["command-a-plus"], rerank: true });
  assert.deepEqual(command.providers, ["brave", "cohere"]);
  assert.equal(command.models[0].apiModel, "command-a-plus-05-2026"); assert.equal(command.models[0].reasoning, "none");
  assert.equal(command.cases[0].budget.inputUsdPerMillionTokens, 0); assert.equal(command.cases[0].budget.outputUsdPerMillionTokens, 0);
  assert.equal(command.cases[0].budget.contextInputTokens, 128000 - 4096);
  assert.equal(command.cases[0].budget.inputTokens, 3 * (128000 - 4096) + 2 * 4096);
  assert.equal(command.cases[0].reservedMicroUsd, command.cases[0].budget.searchBackend.reservedCostMicroUsd);
  assert.equal(command.rerank.maxCalls, 1); assert.ok(command.rerank.reservedMicroUsd > 0);
  assert.equal(JSON.stringify(AVAILABLE_MODELS), before);
  assert.equal(resolveResearchEvaluationModel("gpt-6-luna").webSearchOverride, "app-managed");
});

test("a smaller manifest-bound request ceiling reduces reservation and never raises model capacity", () => {
  const bounded = proposal({ modelIds: ["gemini-4-argon"], caseIds: ["official-compact-original"], requestInputCeilingTokens: 32768 });
  assert.equal(bounded.requestInputCeilingTokens, 32768);
  assert.equal(bounded.cases[0].budget.contextInputTokens, 32768);
  assert.equal(bounded.cases[0].budget.inputTokens, 3 * 32768 + 2 * 4096);
  assert.equal(bounded.totalReservedMicroUsd, 532904);
  assert.ok(bounded.totalReservedMicroUsd < proposal({ modelIds: ["gemini-4-argon"] }).totalReservedMicroUsd);
  assert.equal(proposal({ requestInputCeilingTokens: Number.MAX_SAFE_INTEGER }).cases[0].reservedMicroUsd, proposal().cases[0].reservedMicroUsd);
  for (const requestInputCeilingTokens of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => proposal({ requestInputCeilingTokens }));
});

test("closed selections and immutable US$10 ceiling refuse expanded authority", () => {
  for (const caseIds of [[], ["unknown"], [RESEARCH_EVALUATION_CASES[0].id, RESEARCH_EVALUATION_CASES[0].id], RESEARCH_EVALUATION_CASES.map(entry => entry.id)]) assert.throws(() => proposal({ caseIds }));
  for (const modelIds of [[], ["unknown"], ["gpt-6-luna", "gpt-6-luna"], ["gemini-4-argon", "gpt-6-luna", "command-a-plus"]]) assert.throws(() => proposal({ modelIds }));
  for (const maxTotalMicroUsd of [0, -1, 1.5, 10_000_001, Number.MAX_SAFE_INTEGER + 1]) assert.throws(() => proposal({ maxTotalMicroUsd }));
});

test("approval binds exact manifest, frozen rates, current scope and complete reservation", () => {
  const manifest = proposal();
  assert.deepEqual(validateResearchEvaluationApproval(approval(manifest), manifest, now), approval(manifest));
  for (const extra of [{ version: 1 }, { manifestDigest: "b".repeat(64) }, { maxTotalMicroUsd: manifest.maxTotalMicroUsd - 1 },
    { credentialScope: "production" }, { approvedAt: "2026-11-15T02:00:00Z" }, { debug: "not allowed" }]) assert.throws(() => validateResearchEvaluationApproval(approval(manifest, extra), manifest, now));
  assert.throws(() => validateResearchEvaluationApproval(approval(manifest), manifest, Date.parse(manifest.expiresAt)));
  const changed = structuredClone(manifest); changed.cases[0].budget.inputUsdPerMillionTokens = 0;
  assert.throws(() => validateResearchEvaluationApproval(approval(manifest), changed, now));
  const insufficient = proposal({ maxTotalMicroUsd: 1 });
  assert.throws(() => validateResearchEvaluationApproval(approval(insufficient), insufficient, now));
});

test("known token/search costs are measured separately and unknown usage cannot become zero", () => {
  const entry = proposal().cases[0];
  const usage = { inputTokens: 300, outputTokens: 100, cachedInputTokens: 0, cacheWriteTokens: 0 };
  const modelOnly = researchEvaluationMeasuredCost(usage, entry, 0);
  assert.ok(modelOnly > 0);
  assert.equal(researchEvaluationMeasuredCost(usage, entry, 2) - modelOnly, 2 * entry.budget.searchBackend.costPerQueryMicroUsd);
  for (const invalid of [{ ...usage, inputTokens: undefined }, { ...usage, outputTokens: NaN }, { ...usage, cachedInputTokens: 301 }, { ...usage, cacheWriteTokens: -1 }]) assert.equal(researchEvaluationMeasuredCost(invalid, entry, 0), null);
  assert.equal(researchEvaluationMeasuredCost(usage, entry, 6), null);
});

// Real fsync/wx journals exercise CLI admission; local functions replace every
// paid boundary. Synthetic approval fixtures cannot call a real provider.
function fixture(t, { manifest: manifestInput, scenario = "success" } = {}) {
  const folder = mkdtempSync(join(tmpdir(), "research-evaluation-offline-"));
  const manifest = manifestInput ?? proposal();
  const paths = { manifest: join(folder, "manifest.json"), approval: join(folder, "approval.json"), output: join(folder, "preview.json"), state: join(folder, "state") };
  const journal = join(paths.state, `${manifest.manifestDigest}.jsonl`);
  writeFileSync(paths.manifest, JSON.stringify(manifest)); writeFileSync(paths.approval, JSON.stringify(approval(manifest)));
  t.after(() => {
    for (const path of [paths.manifest, paths.approval, paths.output, journal]) if (existsSync(path)) unlinkSync(path);
    if (existsSync(paths.state)) rmdirSync(paths.state);
    rmdirSync(folder);
  });
  const counts = { load: 0, calls: 0, reranks: 0, pageReads: 0 };
  let digest = manifest.sourceDigest;
  const env = { NODE_ENV: "test", BRAVE_SEARCH_API_KEY: "offline-fixture-key", WEB_SEARCH_FAKE_BACKEND: "0" };
  const seams = { env, now: () => now, stateDirectory: paths.state, sourceDigest: () => digest,
    loadProviders: async () => {
      counts.load++;
      return { resolveProviderApiKey: () => "offline-fixture-key", getResearchPreviewAiModel: () => ({ offline: true }),
        readResearchPage: async () => { counts.pageReads++; throw new Error("Unexpected page dispatch"); },
        runResearchPreviewStep: async input => {
          await input.onBeforeModelDispatch(); counts.calls++;
          if (scenario === "unknown") throw new Error("Provider usage missing");
          if (scenario === "provider_refused") throw Object.assign(new Error("SECRET request and provider body"), {
            name: "AI_NoOutputGeneratedError", cause: Object.assign(new Error("SECRET authorization header"), {
              name: "AI_APICallError", statusCode: 400, responseBody: "SECRET provider response", requestBodyValues: { apiKey: "SECRET key" },
            }),
          });
          if (scenario === "drift") digest = "b".repeat(64);
          const completedSteps = (input.checkpoint?.completedSteps ?? 0) + 1;
          const checkpoint = { completedSteps, usage: { inputTokens: completedSteps * 100, outputTokens: completedSteps * 50, cachedInputTokens: 0, cacheWriteTokens: 0 },
            search: { backendRequestCount: 1, succeededRequestCount: scenario === "search_unknown" ? 0 : 1 },
            pageReads: scenario === "pages" && completedSteps >= 2 ? [{ sourceId: "R1", url: "https://nodejs.org/en/about/previous-releases",
              status: "read", readAt: "2026-11-15T00:00:00Z", truncated: false, contentType: "text/plain", content: "RAW_PAGE_MUST_STAY_PRIVATE" }] : [],
            sources: [{ sourceId: "R1", url: "https://nodejs.org/en/about/previous-releases", snippet: "Official public runtime release schedule" }], stopReason: "completed" };
          return { checkpoint, finished: completedSteps === 3 && scenario !== "no_terminal", report: { content: "Offline structured report" } };
        },
        rerank: async input => { await input.onBeforeDispatch(); counts.reranks++; return { model: "rerank-v5.0-fast", inputTokens: 100, measuredCostMicroUsd: 2,
          ranking: [{ sourceId: "R1", url: input.sources[0].url, relevanceScore: 0.9 }] }; },
      };
    } };
  const args = ["--mode=execute", `--manifest=${paths.manifest}`, `--approval=${paths.approval}`, "--live"];
  return { manifest, paths, journal, counts, seams, args, events: () => readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line)) };
}

test("CLI preview writes only a proposal and initializes zero provider clients", async t => {
  const f = fixture(t);
  const result = await runResearchEvaluationCli(["--expires-at=2026-11-15T01:00:00Z", `--output=${f.paths.output}`, "--rerank"], f.seams);
  assert.equal(result.mode, "preview"); assert.equal(result.manifest.rerank.enabled, true);
  assert.deepEqual(JSON.parse(readFileSync(f.paths.output, "utf8")), result.manifest);
  assert.equal(f.counts.load, 0); assert.equal(f.counts.calls, 0); assert.equal(existsSync(f.journal), false);
});

test("CLI refuses missing live, source/price drift, altered approval and insufficient cap before provider imports", async t => {
  for (const scenario of ["no_live", "source_drift", "price_drift", "approval_drift", "insufficient"]) {
    const f = fixture(t, { manifest: scenario === "insufficient" ? proposal({ maxTotalMicroUsd: 1 }) : undefined });
    if (scenario === "source_drift") f.seams.sourceDigest = () => "b".repeat(64);
    if (scenario === "price_drift") { const changed = structuredClone(f.manifest); changed.cases[0].budget.inputUsdPerMillionTokens = 0; writeFileSync(f.paths.manifest, JSON.stringify(changed)); }
    if (scenario === "approval_drift") writeFileSync(f.paths.approval, JSON.stringify(approval(f.manifest, { credentialScope: "production" })));
    await assert.rejects(runResearchEvaluationCli(scenario === "no_live" ? f.args.slice(0, -1) : f.args, f.seams));
    assert.equal(f.counts.load, 0, scenario); assert.equal(f.counts.calls, 0, scenario); assert.equal(existsSync(f.journal), false, scenario);
  }
});

test("CLI production, price override and fake-backend guards precede provider imports", async t => {
  for (const override of [{ NODE_ENV: "production" }, { RAILWAY_PROJECT_ID: "production-fixture" }, { VERCEL_ENV: "production" },
    { CHAT_MODEL_GPT_6_LUNA_INPUT_USD_PER_MILLION: "0" }, { WEB_SEARCH_FAKE_BACKEND: "1" }, { BRAVE_SEARCH_API_KEY: "" }]) {
    const f = fixture(t); Object.assign(f.seams.env, override);
    await assert.rejects(runResearchEvaluationCli(f.args, f.seams));
    assert.equal(f.counts.load, 0); assert.equal(f.counts.calls, 0); assert.equal(existsSync(f.journal), false);
  }
});

test("CLI executes six generations once, fsyncs intent before outcome, and refuses reuse", async t => {
  const f = fixture(t); const result = await runResearchEvaluationCli(f.args, f.seams);
  assert.equal(result.status, "completed"); assert.equal(result.modelCalls, 6); assert.equal(f.counts.calls, 6);
  assert.equal(result.qualityVerdict, "manual_review_pending"); assert.equal(result.rerankCalls, 0);
  const events = f.events(); assert.equal(events[0].kind, "reserved"); assert.equal(events.at(-1).kind, "evaluation_completed");
  assert.equal(events.filter(event => event.kind === "terminal").length, 2);
  assert.equal(events.filter(event => event.kind === "dispatch_intent").length, 6);
  assert.equal(events[1].kind, "dispatch_intent"); assert.equal(events[2].kind, "checkpoint");
  await assert.rejects(runResearchEvaluationCli(f.args, f.seams), /already has an intent/); assert.equal(f.counts.calls, 6);
});

test("unknown provider/search outcomes or mid-run source drift stop the next paid call and remain single-use", async t => {
  for (const scenario of ["unknown", "search_unknown", "drift"]) {
    const f = fixture(t, { scenario });
    await assert.rejects(runResearchEvaluationCli(f.args, f.seams), /inspect the durable journal/);
    assert.equal(f.counts.calls, 1, scenario); assert.equal(f.events().at(-1).kind, "attention");
    assert.equal(f.events().some(event => event.kind === "evaluation_completed"), false);
    f.seams.sourceDigest = () => f.manifest.sourceDigest;
    await assert.rejects(runResearchEvaluationCli(f.args, f.seams), /already has an intent/); assert.equal(f.counts.calls, 1, scenario);
  }
});

test("a missing terminal stops at three generations without a fourth or false completion", async t => {
  const f = fixture(t, { manifest: proposal({ modelIds: ["gpt-6-luna"] }), scenario: "no_terminal" });
  await assert.rejects(runResearchEvaluationCli(f.args, f.seams), /inspect the durable journal/);
  assert.equal(f.counts.calls, 3); assert.equal(f.events().at(-1).kind, "attention");
  assert.equal(f.events().some(event => event.kind === "evaluation_completed"), false);
});

test("failed live attempts retain bounded error type and HTTP status without credentials or provider payloads", async t => {
  const f = fixture(t, { scenario: "provider_refused" });
  await assert.rejects(runResearchEvaluationCli(f.args, f.seams), /inspect the durable journal/);
  assert.equal(f.counts.calls, 1);
  assert.deepEqual(f.events().at(-1).diagnostic, { errorType: "AI_NoOutputGeneratedError", httpStatus: 400 });
  assert.equal(readFileSync(f.journal, "utf8").includes("SECRET"), false);
  await assert.rejects(runResearchEvaluationCli(f.args, f.seams), /already has an intent/);
  assert.equal(f.counts.calls, 1);
});

test("the evaluation journal proves page-read outcomes without persisting original page content", async t => {
  const f = fixture(t, { scenario: "pages" });
  await runResearchEvaluationCli(f.args, f.seams);
  const checkpoint = f.events().find(event => event.kind === "checkpoint" && event.completedSteps === 2);
  assert.equal(checkpoint.pageReads[0].status, "read");
  assert.equal(checkpoint.pageReads[0].truncated, false);
  assert.equal(checkpoint.pageReads[0].contentCharacters, "RAW_PAGE_MUST_STAY_PRIVATE".length);
  assert.equal(checkpoint.pageReads[0].contentDigest, researchEvaluationDigest("RAW_PAGE_MUST_STAY_PRIVATE"));
  assert.equal(readFileSync(f.journal, "utf8").includes("RAW_PAGE_MUST_STAY_PRIVATE"), false);
});

test("optional Cohere side experiment is one separate dispatch after six report generations", async t => {
  const f = fixture(t, { manifest: proposal({ rerank: true }) });
  const result = await runResearchEvaluationCli(f.args, f.seams);
  assert.equal(result.modelCalls, 6); assert.equal(result.rerankCalls, 1);
  assert.equal(f.counts.calls, 6); assert.equal(f.counts.reranks, 1);
  const events = f.events(); const rerankIndex = events.findIndex(event => event.kind === "rerank_dispatch_intent");
  assert.ok(rerankIndex > events.findLastIndex(event => event.kind === "terminal"));
  assert.equal(events.filter(event => event.kind === "rerank_terminal").length, 1);
});

test("bounded Rerank sends only captured snippets and preserves stable source mapping", async () => {
  let dispatches = 0, requests = 0;
  const sources = [{ sourceId: "R2", url: "https://example.com/two", snippet: "Second public snippet", content: "SECRET HTML BODY" },
    { sourceId: "R1", url: "https://example.com/one", snippet: "First public snippet", pageRead: { content: "SECRET PAGE" } }];
  const result = await rerankResearchEvaluationSnippets({ key: "offline", query: "Public runtime question", sources, onBeforeDispatch: async () => { dispatches++; } }, async (url, init) => {
    requests++; assert.equal(url, "https://api.cohere.com/v2/rerank"); assert.equal(init.redirect, "error");
    const body = JSON.parse(init.body); assert.equal(body.model, "rerank-v5.0-fast");
    assert.deepEqual(body.documents, ["Second public snippet", "First public snippet"]);
    assert.equal(init.body.includes("SECRET"), false); assert.equal(body.return_documents, false);
    return Response.json({ results: [{ index: 1, relevance_score: 0.9 }, { index: 0, relevance_score: 0.1 }], meta: { billed_units: { input_tokens: 100 } } });
  });
  assert.equal(dispatches, 1); assert.equal(requests, 1); assert.equal(result.measuredCostMicroUsd, 2);
  assert.deepEqual(result.ranking.map(source => source.sourceId), ["R1", "R2"]);
  assert.deepEqual(result.ranking.map(source => source.url), [sources[1].url, sources[0].url]);
});

test("rerank unknown billing, malformed identity, body overflow and abort fail closed without retries", async () => {
  const input = { key: "offline", query: "Public question", sources: [{ sourceId: "R1", url: "https://example.com", snippet: "Public snippet" }] };
  for (const payload of [
    { results: [{ index: 0, relevance_score: 1 }], meta: { billed_units: { search_units: 1 } } },
    { results: [{ index: 25, relevance_score: 1 }], meta: { billed_units: { input_tokens: 100 } } },
    { results: [{ index: 0, relevance_score: Infinity }], meta: { billed_units: { input_tokens: 100 } } },
  ]) { let requests = 0; await assert.rejects(rerankResearchEvaluationSnippets(input, async () => { requests++; return Response.json(payload); })); assert.equal(requests, 1); }
  let requests = 0;
  await assert.rejects(rerankResearchEvaluationSnippets(input, async () => { requests++; return new Response("x".repeat(65537)); })); assert.equal(requests, 1);
  const controller = new AbortController(); controller.abort(); let dispatches = 0;
  await assert.rejects(rerankResearchEvaluationSnippets({ ...input, signal: controller.signal, onBeforeDispatch: async () => { dispatches++; } }, async () => { requests++; throw new Error("Must not dispatch"); }));
  assert.equal(dispatches, 0); assert.equal(requests, 1);
  await assert.rejects(rerankResearchEvaluationSnippets({ ...input, sources: [...input.sources, ...input.sources] }, async () => { requests++; throw new Error("Must not dispatch"); })); assert.equal(requests, 1);
});
