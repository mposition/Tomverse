import assert from "node:assert/strict";
import test, { beforeEach, mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildMemoryQueryPlan, memorySemanticQuery } from "../../lib/memoryQueryPlan.ts";
import { memoryHistoryContentDigest } from "../../lib/memoryHistorySnapshotCore.ts";

// These adapters never read a database or call a provider.
const root = resolve(import.meta.dirname, "../..");
const mod = (path) => pathToFileURL(resolve(root, path)).href;
const now = new Date("2026-11-15T00:00:00Z");
let masterEnabled = true, injectionEnabled = true, cached = true, historyCount = 2;
const lookups = [], requests = [], knowledgeQueries = [];
const memory = { id: "coffee", kind: "preference", statement: "coffee is preferred", conflictKey: null,
    confidence: 1, importance: 5, pinned: false, searchTerms: ["coffee"], expiresAt: null,
    createdAt: now, approvedAt: now, evidences: [] };
mock.module(mod("lib/prisma.ts"), { namedExports: { prisma: { memoryItem: {
    findMany: async (args) => { lookups.push(args); return args.where.AND.some((item) => item.id?.notIn) ? [] : [memory]; },
    aggregate: async () => ({ _count: { _all: 1 }, _max: { updatedAt: now } }),
} } } });
mock.module(mod("lib/memoryService.ts"), { namedExports: {
    getMemorySettings: async () => ({ masterEnabled, styleEnabled: true, defaultConversationMode: "on" }),
} });
mock.module(mod("lib/appSettings.ts"), { namedExports: {
    isMemoryInjectionEnabled: async () => injectionEnabled,
    getMemoryExtractionRevokedPairs: async () => [],
} });
mock.module(mod("lib/memoryInjectionGate.ts"), { namedExports: {
    hasApprovedExtractionPair: () => true,
    injectableExtractionPairs: () => [],
    decideMemoryInjection: ({ injectionFlagEnabled, accountMasterEnabled, conversationMode }) =>
        !injectionFlagEnabled ? { allowed: false, reason: "flag_off" } :
        !accountMasterEnabled ? { allowed: false, reason: "account_off" } :
        conversationMode === "off" ? { allowed: false, reason: "conversation_off" } : { allowed: true },
} });
mock.module(mod("lib/semanticRetrieval.ts"), { namedExports: {
    semanticFeatureReady: async () => ({}),
    rerankForRetrieval: async (input) => { requests.push(input); return input.mode === "off" || !cached ? null : new Map([[memory.id, 0.9]]); },
    rerankMemoryForRetrieval: async (input) => {
        requests.push(input);
        if (input.mode === "off" || !cached) return { scores: null, adopted: null, fallbackReason: "not_cached" };
        const used = input.history.slice(-historyCount);
        return { scores: new Map([[memory.id, 0.9]]), adopted: {
            effectiveQuery: memorySemanticQuery(input.currentQuery, used),
            historyCount: used.length, model: "rerank-v4.0-fast", policy: "memory-query-v3",
        }, fallbackReason: null };
    },
} });
const noProfile = { memoryPolicy: null, instructionsPrompt: null, knowledgePrompt: null,
    profileVersion: null, knowledgeHash: "none", profileTokens: 0, version: null,
    knowledgeSemanticSteps: { neighbours: false, rerank: false } };
mock.module(mod("lib/chatProfileContext.ts"), { namedExports: {
    NO_PROFILE_CONTEXT: noProfile,
    buildChatProfileContext: async (input) => { knowledgeQueries.push(input.query); return noProfile; },
} });
const { retrieveMemoryContext } = await import(mod("lib/memoryRetrievalService.ts"));
const { buildChatMemoryContext } = await import(mod("lib/chatMemoryContext.ts"));
const { buildChatTurnContext } = await import(mod("lib/chatTurnContext.ts"));
const source = (id, content) => ({ id, content, digest: memoryHistoryContentDigest(content) });
const history = [source("old", "Atlas only."), source("new", "The current project is Atlas; exclude Vega.")];
const base = { userId: "owner", query: "coffee?", now,
    memorySemanticContext: { history, queryPolicy: "full" } };
beforeEach(() => {
    masterEnabled = true; injectionEnabled = true; cached = true; historyCount = 2;
    lookups.length = 0; requests.length = 0; knowledgeQueries.length = 0;
});

test("retrieval returns the actually adopted query and source subset while preserving current lexical candidates", async () => {
    historyCount = 1;
    const result = await retrieveMemoryContext(base);
    assert.equal(result.semanticRerank, true);
    assert.equal(result.effectiveQueryPlan.semanticQuery, memorySemanticQuery(base.query, [history[1].content]));
    assert.deepEqual(result.memoryHistorySources, [{ id: history[1].id, digest: history[1].digest }]);
    assert.deepEqual(result.effectiveQueryPlan.terms, buildMemoryQueryPlan(base.query).terms);
    assert.equal(lookups[0].take, 400);
    assert.deepEqual(lookups[0].where.AND.at(-1).OR[0], { searchTerms: { hasSome: ["coffee"] } });
    assert.ok(requests[0].documents.length <= 100);
});

test("unsuccessful contextual preparation reproduces the same current-only lexical fingerprint at send", async () => {
    cached = false;
    const prepared = await buildChatMemoryContext(base);
    const sent = await buildChatMemoryContext({ ...base, semantic: "off",
        memorySemanticContext: { history: [], queryPolicy: "full" } });
    assert.equal(prepared.semanticRerank, false);
    assert.equal(prepared.memoryHistorySources, undefined);
    assert.equal(prepared.fingerprint, sent.fingerprint);
    assert.equal(sent.memoryQueryPolicy, "full");
});

test("successful contextual fingerprints bind context even with the same selected Memory IDs", async () => {
    const first = await buildChatMemoryContext(base);
    const second = await buildChatMemoryContext({ ...base, memorySemanticContext: {
        history: [source("different", "Vega only.")], queryPolicy: "full" } });
    assert.deepEqual(first.prompt, second.prompt);
    assert.notEqual(first.fingerprint, second.fingerprint);
    cached = false;
    const evicted = await buildChatMemoryContext({ ...base, semantic: "cached_only" });
    assert.notEqual(first.fingerprint, evicted.fingerprint, "the route must reject as stale instead of accepting lexical");
});

test("an empty snapshot retains current-query semantic permission", async () => {
    const result = await retrieveMemoryContext({ ...base,
        memorySemanticContext: { history: [], queryPolicy: "full" } });
    assert.equal(result.semanticRerank, true);
    assert.equal(result.effectiveQueryPlan.semanticQuery, base.query);
    assert.equal(result.memoryHistorySources, undefined);
});

test("account, conversation and profile gates run before lazy source history collection", async () => {
    let reads = 0;
    const loadHistory = async () => { reads += 1; return base.memorySemanticContext; };
    for (const options of [{ userId: null }, { conversationMode: "off" },
        { profileMemoryPolicy: { useAccountMemory: false } }]) {
        await buildChatMemoryContext({ ...base, ...options, memorySemanticContext: loadHistory });
    }
    masterEnabled = false;
    await buildChatMemoryContext({ ...base, memorySemanticContext: loadHistory });
    masterEnabled = true; injectionEnabled = false;
    await buildChatMemoryContext({ ...base, memorySemanticContext: loadHistory });
    assert.equal(reads, 0);
    assert.equal(requests.length, 0);
});

test("Memory-only history never changes the profile knowledge query or final Memory prompt", async () => {
    const turn = await buildChatTurnContext({ ...base, profileVersionId: "profile" });
    assert.deepEqual(knowledgeQueries, [base.query]);
    assert.equal(turn.semanticSteps.memoryRerank, true);
    assert.ok(!JSON.stringify(turn.memory.prompt).includes(history[1].content));
    assert.ok(!turn.systemPrompt?.includes(history[1].content));
});

test("legacy requests explicitly reproduce the original plan and omit contextual sources", async () => {
    const result = await retrieveMemoryContext({ ...base,
        memorySemanticContext: { history, queryPolicy: "legacy" } });
    assert.deepEqual(result.effectiveQueryPlan, buildMemoryQueryPlan(base.query));
    assert.equal(result.memoryHistorySources, undefined);
    assert.equal(requests[0].query, buildMemoryQueryPlan(base.query).semanticQuery);
});
