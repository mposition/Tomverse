/** Offline paired benchmark: real orchestration, controlled transports, no paid calls.
 * Run with --conditions=react-server --experimental-test-module-mocks --import tsx.
 * Optional first argument pins the baseline commit (default: origin/develop).
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, unlinkSync, rmdirSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, join } from "node:path";
import { mock } from "node:test";
import { pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { getEncoding } from "js-tiktoken";
import { z } from "zod";

const root = resolve(import.meta.dirname, "..");
const baseline = execFileSync("git", ["rev-parse", process.argv[2] ?? "origin/develop"], { cwd: root, encoding: "utf8" }).trim();
const baselineSource = execFileSync("git", ["show", `${baseline}:lib/autoLlmRouter.ts`], { cwd: root, encoding: "utf8" });
// Keep interrupted runs outside the application's TypeScript/lint inputs while
// retaining normal resolution of the installed SDK and the project's aliases.
const temporary = mkdtempSync(join(root, "node_modules", ".smart-latency-baseline-"));
const baselineFile = join(temporary, "router.ts");
// tsx deliberately does not expand project aliases inside node_modules. Resolve
// this baseline module's imports explicitly; its request-building code is intact.
writeFileSync(baselineFile, baselineSource.replace(/from (["'])@\/([^"']+)\1/g,
  (_match, _quote, path) => `from ${JSON.stringify(resolve(root, `${path}.ts`))}`));

process.env.E2E_DISABLE_DATABASE = "true";
process.env.DATABASE_URL = "postgresql://offline:offline@127.0.0.1:1/offline";
process.env.BRAVE_SEARCH_API_KEY = "offline-fixture";
delete process.env.WEB_SEARCH_FAKE_BACKEND;
const require = createRequire(import.meta.url);
let captured;
mock.module("ai", { namedExports: { ...require("ai"), generateText: async (request) => {
  captured = request;
  return { output: { modelId: "gpt-6-luna", reason: "fixture", topic: "fixture", requiresFileGeneration: false, imageIntent: null } };
} } });
mock.module(pathToFileURL(join(root, "lib/activeAiModel.ts")).href, { namedExports: { getActiveAiModel: () => ({}) } });

const quantiles = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return Object.fromEntries([50, 95].map(p => [`p${p}`, +sorted[Math.ceil(sorted.length * p / 100) - 1].toFixed(2)]));
};
try {
  const { buildAppManagedWebSearchTool } = await import("../lib/appManagedWebSearchTool.ts");
  const { APP_MANAGED_WEB_SEARCH_TOOL_DEFINITION_TOKENS } = await import("../lib/appManagedWebSearchPrompt.ts");
  const { callAutoLlmRouter: beforeRouter } = await import(pathToFileURL(baselineFile).href);
  const { callAutoLlmRouter: afterRouter } = await import("../lib/autoLlmRouter.ts");
  const { chatImageIntentUserMessage } = await import("../lib/chatImageIntentCore.ts");
  const { AVAILABLE_MODELS } = await import("../lib/models.ts");
  const { autoLlmRouterCandidates, AUTO_LLM_ROUTER_DEFAULT_GUIDANCE } = await import("../lib/autoLlmRouterCore.ts");
  const tokenizer = getEncoding("o200k_base");
  const definition = buildAppManagedWebSearchTool({ backend: "brave", maxQueries: 5 }).tools.web_search;
  const definitionTokens = tokenizer.encode(JSON.stringify({ name: "web_search", description: definition.description, parameters: z.toJSONSchema(definition.inputSchema) })).length;
  assert.ok(definitionTokens <= APP_MANAGED_WEB_SEARCH_TOOL_DEFINITION_TOKENS, "tool definition stays within its existing reservation");

  const imageCandidates = [{ id: "gpt-image-2", name: "Image", latency: "fast", credits: { standard: 8, final: 20 } }];
  const model = AVAILABLE_MODELS.find(model => model.id === "gpt-6-luna");
  const candidates = autoLlmRouterCandidates(["gpt-6-luna", "deepseek-v4-flash"], AVAILABLE_MODELS, { "gpt-6-luna": 3, "deepseek-v4-flash": 2 });
  const payloads = [];
  for (const [name, message, previous, attachedPhoto] of [
    ["text", "Compare the current Brisbane and Sydney weather using official sources.", null, false],
    ["document", "Create a PDF comparing current Brisbane and Sydney weather, with sources.", null, false],
    ["image", "Draw a cat in watercolour.", null, false],
    ["image_follow_up", "Make the hat blue.", "A watercolour cat wearing a red hat.", false],
    ["photo_edit", "Remove the sign in the attached photo.", null, true],
    ["photo_analysis", "Describe the text in this attached photo.", null, true],
  ]) {
    const input = { routerModel: model, candidates, guidance: AUTO_LLM_ROUTER_DEFAULT_GUIDANCE,
      prompt: message, previousAnswer: null, session: null, rewrite: true,
      imageIntent: { modelId: model.id, candidates: imageCandidates, previousImagePrompt: previous, attachedPhoto,
        message, prompt: chatImageIntentUserMessage(message, imageCandidates, previous, attachedPhoto),
        maxOutputTokens: previous ? 2500 : 400, timeoutMs: previous ? 12000 : 8000 } };
    const tokens = [];
    for (const call of [beforeRouter, afterRouter]) {
      await call(input);
      tokens.push(tokenizer.encode(captured.system + captured.prompt).length);
    }
    payloads.push({ case: name, beforeInputTokens: tokens[0], afterInputTokens: tokens[1], reductionPercent: +(100 * (1 - tokens[1] / tokens[0])).toFixed(1) });
  }

  // A model fixture pauses 20 ms before each tool call, returns the same queries
  // and text, and takes 20 ms to finish. This measures scheduling, NOT LLM quality.
  const queries = ["brisbane forecast", "sydney forecast", "brisbane warnings", "sydney warnings"];
  const samples = { sequential: [], batch: [] };
  let fetchCount = 0;
  globalThis.fetch = async (url) => {
    fetchCount++;
    const query = new URL(url).searchParams.get("q");
    await sleep(10 + queries.indexOf(query) * 2);
    return { ok: true, status: 200, json: async () => ({ web: { results: [{ title: query, url: `https://example.test/${queries.indexOf(query)}`, description: "Controlled evidence." }] } }) };
  };
  const iterations = 40;
  for (let i = 0; i < iterations; i++) {
    // Alternate order to reduce warm-up/order bias.
    for (const mode of i % 2 ? ["batch", "sequential"] : ["sequential", "batch"]) {
      const config = buildAppManagedWebSearchTool({ backend: "brave", maxQueries: 5 });
      const execute = config.tools.web_search.execute;
      const started = performance.now();
      const outputs = [];
      for (const query of mode === "batch" ? [queries] : queries) {
        await sleep(20);
        outputs.push(await execute({ query }, { toolCallId: "fixture", messages: [] }));
      }
      const searches = outputs.flatMap(result => result.status === "batch" ? result.searches : [result]);
      assert.ok(searches.every(result => result.status === "ok"));
      assert.deepEqual(searches.flatMap(result => result.results.map(source => source.url)), queries.map((_, i) => `https://example.test/${i}`));
      assert.equal(config.session.snapshot().backendRequestCount, 4);
      assert.equal(config.session.snapshot().succeededRequestCount, 4);
      await sleep(20);
      const firstContentMs = performance.now() - started;
      await sleep(20);
      samples[mode].push({ firstContentMs, completionMs: performance.now() - started });
    }
  }
  console.log(JSON.stringify({ baseline, measuredAt: new Date().toISOString(), kind: "offline_controlled_transport",
    limitations: "No provider or production calls. Fixed query/answer fixture verifies scheduling and source preservation, not model quality, batch adoption, or production latency.",
    samplesPerVariant: iterations, modelRoundTripMs: 20, searchDelaysMs: [10, 12, 14, 16], backendRequestsPerTurn: 4,
    toolRoundTrips: { before: 4, after: 1 }, fetchCount, toolDefinitionTokens: definitionTokens,
    toolDefinitionReservationTokens: APP_MANAGED_WEB_SEARCH_TOOL_DEFINITION_TOKENS,
    routingPayloads: payloads,
    timings: Object.fromEntries(Object.entries(samples).map(([mode, rows]) => [mode, {
      firstContentMs: quantiles(rows.map(row => row.firstContentMs)), completionMs: quantiles(rows.map(row => row.completionMs)),
    }])), samples,
  }, null, 2));
} finally {
  unlinkSync(baselineFile);
  rmdirSync(temporary);
}
