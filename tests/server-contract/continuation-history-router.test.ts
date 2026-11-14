import assert from "node:assert/strict";
import test, { mock } from "node:test";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MockLanguageModelV4 } from "ai/test";
import { AVAILABLE_MODELS } from "../../lib/models";
import { HISTORY_SOURCE_MAX_BYTES } from "../../lib/continuationHistorySearch";

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL = "postgresql://e2e:e2e@127.0.0.1:1/e2e";
const mod = (path: string) => pathToFileURL(resolve(import.meta.dirname, "../..", path)).href;
const usage = { inputTokens: { total: 20, noCache: 20, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 10, text: 10, reasoning: 0 } };
let requests: unknown[] = [], answer: "normal" | "repeated_tool" | "parallel_tools" = "normal";
const model = new MockLanguageModelV4({ doGenerate: async request => {
    requests.push(request);
    const first = requests.length === 1;
    const duplicate = first && answer === "parallel_tools";
    return { content: duplicate ? [1, 2].map(id => ({ type: "tool-call" as const, toolCallId: `read-${id}`, toolName: "read_imported_source", input: '{"queries":["Kyoto"]}' })) : first || answer === "repeated_tool"
        ? [{ type: "tool-call" as const, toolCallId: "read", toolName: "read_imported_source", input: '{"queries":["Kyoto"]}' }]
        : [{ type: "text" as const, text: JSON.stringify({ modelId: "deepseek-v4-flash", reason: "bounded source", topic: "travel", requiresFileGeneration: false }) }],
        usage, finishReason: { unified: first || answer === "repeated_tool" ? "tool-calls" as const : "stop" as const, raw: undefined }, warnings: [] };
} });
mock.module(mod("lib/activeAiModel.ts"), { namedExports: { getActiveAiModel: () => model } });
const load = () => import(mod("lib/autoLlmRouter.ts"));
const routerModel = AVAILABLE_MODELS.find(model => model.id === "gpt-6-luna")!;
const base = { routerModel, guidance: "", prompt: "Prepare that itinerary", previousAnswer: "Native: Friday departure",
    candidates: [{ id: "deepseek-v4-flash", name: "Flash", credits: 2, provider: "deepseek", bestFor: "chat",
        tier: "budget", reasoning: null, contextWindowTokens: 64000, acceptsImages: false, canCreateFiles: false }], session: null,
    importedSource: "preview recent source", timeoutMs: 10000 };

test("the real SDK reads history once and replaces preview with the exact final user-role source", async () => {
    const { callAutoLlmRouter, routerRequest, routerRequestWorstCase } = await load();
    requests = []; answer = "normal";
    let source = base.importedSource, reads = 0;
    const input = { ...base, historySearch: { source: () => source, verify: async () => true,
        read: async (queries: string[]) => { assert.deepEqual(queries, ["Kyoto"]); reads++; source = "Final: Kyoto, not Osaka. Latest: Friday."; } } };
    const result = await callAutoLlmRouter(input);
    assert.equal(result.outcome, "picked"); assert.equal(requests.length, 2); assert.equal(reads, 1);
    assert.deepEqual(result.usage, { inputTokens: 40, outputTokens: 20, reasoningTokens: 0 });
    const final = requests[1] as { prompt: Array<{ role: string; content: unknown }> };
    assert.doesNotMatch(JSON.stringify(final), /preview recent source/);
    assert.match(JSON.stringify(final.prompt.filter(m => m.role === "user")), /Kyoto, not Osaka/);
    assert.doesNotMatch(JSON.stringify(final.prompt.filter(m => m.role === "system")), /Kyoto, not Osaka/);
    const prices = { inputUsdPerMillionTokens: 1, outputUsdPerMillionTokens: 2 };
    assert.ok(routerRequestWorstCase(input, routerRequest(input), prices)! > HISTORY_SOURCE_MAX_BYTES * 6);
});

for (const mode of ["revoke_after_read", "oversized", "read_error", "repeated_tool"] as const)
test(`history ${mode} refuses reuse without a third model step`, async () => {
    const { callAutoLlmRouter } = await load();
    requests = []; answer = mode === "repeated_tool" ? "repeated_tool" : "normal";
    let read = false;
    const result = await callAutoLlmRouter({ ...base, historySearch: {
        source: () => mode === "oversized" ? "x".repeat(HISTORY_SOURCE_MAX_BYTES + 1) : "Final source",
        verify: async () => !(mode === "revoke_after_read" && read),
        read: async () => { read = true; if (mode === "read_error") throw new Error("Private source error"); },
    } });
    assert.equal(result.pick, null);
    assert.ok(requests.length <= 2);
    if (mode !== "repeated_tool") assert.equal(requests.length, 1);
});


test("parallel tool calls cannot race into a second source read", async () => {
    const { callAutoLlmRouter } = await load();
    requests = []; answer = "parallel_tools";
    let reads = 0;
    await callAutoLlmRouter({ ...base, historySearch: { source: () => "Final source", verify: async () => true,
        read: async () => { reads++; await Promise.resolve(); } } });
    assert.equal(reads, 1); assert.ok(requests.length <= 2);
});
