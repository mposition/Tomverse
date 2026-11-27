import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  CODE_EXECUTION_CODE_META,
  CODE_EXECUTION_MAX_CALLS_PER_TURN,
  CODE_EXECUTION_OUTPUT_META,
  CODE_EXECUTION_PRICE_REGISTER,
  CODE_EXECUTION_RESERVED_PASSES,
  CODE_EXECUTION_TOOL_NAME,
  codeExecutionFenceKind,
  codeExecutionMarkdown,
  codeExecutionReservedPasses,
  createCodeExecutionTextStream,
  modelSupportsCodeExecution,
  resolveCodeExecution,
} from "../lib/chatCodeExecutionCore.ts";
import { withCodeExecutionTool } from "../lib/chatCodeExecutionTool.ts";
import { createChatBudget } from "../lib/chatSecurity.ts";
import { getModel } from "../lib/models.ts";
import { streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";

/**
 * Code execution: docs/policy/chat-attachment-formats.md section 2.3.1.
 *
 * No provider is called. The stream parts below are the shapes the installed
 * @ai-sdk/google emits for Gemini's executableCode / codeExecutionResult parts
 * (a provider-executed `tool-call` with `{ language, code }`, then a
 * `tool-result` with `{ outcome, output }`), so what is proven is this module's
 * handling of that shape -- not that a real Gemini turn produces it.
 */

const ON = { CHAT_CODE_EXECUTION_ENABLED: "true" };
const gemini = { provider: "google", apiModel: "gemini-3.7-flash" };
const decide = (overrides = {}) =>
  resolveCodeExecution({
    env: ON, model: gemini, accessKind: "user", researchTurn: false, applicationToolLoop: false, ...overrides,
  });

test("off unless the switch reads true, for every model", () => {
  for (const value of [undefined, "", "1", "TRUE", "false"]) {
    assert.deepEqual(decide({ env: { CHAT_CODE_EXECUTION_ENABLED: value } }), {
      enabled: false, reason: "switch_off",
    });
  }
  assert.deepEqual(decide(), {
    enabled: true, provider: "google",
    maxCalls: CODE_EXECUTION_MAX_CALLS_PER_TURN, reservedPasses: CODE_EXECUTION_RESERVED_PASSES,
  });
});

test("guests and research turns never get the tool", () => {
  assert.deepEqual(decide({ accessKind: "guest" }), { enabled: false, reason: "guest" });
  assert.deepEqual(decide({ researchTurn: true }), { enabled: false, reason: "research_turn" });
});

// Review r-20261127-073816-5a1bf4: a run bills the prompt again, so its pass is
// reserved before the request, and a turn whose tool loop would share those
// passes does not get the tool.
test("a turn with an application tool loop does not get the tool", () => {
  assert.deepEqual(decide({ applicationToolLoop: true }), { enabled: false, reason: "tool_loop" });
  assert.equal(codeExecutionReservedPasses(decide({ applicationToolLoop: true })), 1);
});

test("every run that can be billed is a reserved provider pass", () => {
  // The request, the runs shown, and the one past the ceiling that aborts.
  assert.equal(CODE_EXECUTION_RESERVED_PASSES, 1 + CODE_EXECUTION_MAX_CALLS_PER_TURN + 1);
  assert.equal(codeExecutionReservedPasses(decide()), CODE_EXECUTION_RESERVED_PASSES);
  assert.equal(codeExecutionReservedPasses({ enabled: false, reason: "switch_off" }), 1);
  // The budget holds that many passes rather than clamping them down, on an
  // ordinary turn and on a long-context one.
  const model = getModel("gemini-3-6-flash");
  assert.ok(model && modelSupportsCodeExecution(model));
  const passes = codeExecutionReservedPasses(decide());
  for (const input of [2_000, 200_000]) {
    const withRuns = createChatBudget("user", model, input, {
      toolInputPasses: passes, longContextToolInputPasses: passes,
    });
    assert.equal(withRuns.providerCallPasses, CODE_EXECUTION_RESERVED_PASSES, String(input));
    assert.equal(createChatBudget("user", model, input).providerCallPasses, undefined, String(input));
    assert.equal(
      withRuns.inputTokens,
      withRuns.contextInputTokens * CODE_EXECUTION_RESERVED_PASSES +
        withRuns.maxOutputTokens * (CODE_EXECUTION_RESERVED_PASSES - 1),
      String(input)
    );
  }
  // Both pass counts the route builds carry the runs.
  const route = readFileSync(new URL("../app/api/chat/route.ts", import.meta.url), "utf8");
  assert.equal(route.split("codeExecutionReservedPasses(codeExecution)").length - 1, 2);
});

test("a provider that bills the tool on top of tokens waits for its surcharge", () => {
  for (const provider of ["openai", "anthropic"]) {
    assert.deepEqual(decide({ model: { provider, apiModel: "any" } }), {
      enabled: false, reason: "surcharge_unapproved",
    }, provider);
    const entry = CODE_EXECUTION_PRICE_REGISTER.find((candidate) => candidate.provider === provider);
    assert.equal(entry.additionalCharge, true);
    assert.equal(entry.surchargeCredits, null);
    assert.match(entry.priceSource, /^https:\/\//);
    assert.equal(entry.checkedAt, "2026-11-27");
  }
  const google = CODE_EXECUTION_PRICE_REGISTER.find((candidate) => candidate.provider === "google");
  assert.equal(google.additionalCharge, false);
  assert.equal(google.price, null);
  assert.deepEqual(decide({ model: { provider: "xai", apiModel: "grok" } }), {
    enabled: false, reason: "provider_unsupported",
  });
});

test("only Gemini 3.x Flash and Pro, by API name, take the tool", () => {
  for (const apiModel of ["gemini-3.7-flash", "gemini-3.6-flash", "gemini-3.1-pro-preview", "gemini-4.0-pro"]) {
    assert.equal(modelSupportsCodeExecution({ provider: "google", apiModel }), true, apiModel);
  }
  for (const apiModel of ["gemini-2.5-pro", "gemini-3.5-flash-lite", "gemini-flash-lite-latest", "gemma-3-27b-it"]) {
    assert.equal(modelSupportsCodeExecution({ provider: "google", apiModel }), false, apiModel);
  }
  assert.equal(modelSupportsCodeExecution({ provider: "openai", apiModel: "gemini-3.7-flash" }), false);
  assert.deepEqual(decide({ model: { provider: "google", apiModel: "gemini-2.5-pro" } }), {
    enabled: false, reason: "model_unverified",
  });
});

test("a refused turn keeps its exact tool configuration", () => {
  const refused = { enabled: false, reason: "switch_off" };
  const config = { tools: { web_search: { type: "function" } }, stopWhen: "x" };
  assert.equal(withCodeExecutionTool(config, refused), config);
  assert.equal(withCodeExecutionTool(undefined, refused), undefined);
});

test("an admitted turn adds Google's provider tool beside the others", () => {
  const config = { tools: { web_search: { type: "function" } }, stopWhen: "x" };
  const merged = withCodeExecutionTool(config, decide());
  assert.notEqual(merged, config);
  assert.equal(merged.stopWhen, "x");
  assert.deepEqual(Object.keys(merged.tools), ["web_search", CODE_EXECUTION_TOOL_NAME]);
  assert.equal(merged.tools.code_execution.type, "provider");
  assert.equal(merged.tools.code_execution.id, "google.code_execution");
  assert.deepEqual(Object.keys(withCodeExecutionTool(undefined, decide()).tools), [CODE_EXECUTION_TOOL_NAME]);
});

test("a run reads as two fences the composer folds", () => {
  const markdown = codeExecutionMarkdown(
    { language: "PYTHON", code: "rows = [3, 4, 5]\nprint(sum(rows))\n" },
    { outcome: "OUTCOME_OK", output: "12\n" }
  );
  assert.ok(markdown.includes(`\`\`\`python ${CODE_EXECUTION_CODE_META}\nrows = [3, 4, 5]\nprint(sum(rows))\n\`\`\``));
  assert.ok(markdown.includes(`\`\`\`text ${CODE_EXECUTION_OUTPUT_META}\n12\n\`\`\``));
  const failed = codeExecutionMarkdown({ code: "1/0" }, { outcome: "OUTCOME_FAILED", output: "ZeroDivisionError" });
  assert.ok(failed.includes("[OUTCOME_FAILED]\nZeroDivisionError"));
  // A backtick run in the code cannot close the fence.
  const fenced = codeExecutionMarkdown({ code: "s = '```'" }, { outcome: "OUTCOME_OK", output: "" });
  assert.ok(fenced.includes(`\`\`\`\`python ${CODE_EXECUTION_CODE_META}\ns = '\`\`\`'\n\`\`\`\``));
  assert.ok(fenced.includes("(no output)"));
  assert.equal(codeExecutionMarkdown({ code: "  " }, {}), null);
  assert.ok(codeExecutionMarkdown({ language: "py; rm", code: "x" }, {}).includes("```python "));
});

const read = async (stream) => {
  let text = "";
  for await (const chunk of stream) text += chunk;
  return text;
};
const parts = (...items) => (async function* () { yield* items; })();
const call = (id, code) => ({
  type: "tool-call", toolCallId: id, toolName: "code_execution", providerExecuted: true,
  input: { language: "PYTHON", code },
});
const result = (id, output) => ({
  type: "tool-result", toolCallId: id, toolName: "code_execution", providerExecuted: true,
  output: { outcome: "OUTCOME_OK", output },
});

test("the answer stream carries text and each run where it happened", async () => {
  let ceilings = 0;
  const text = await read(createCodeExecutionTextStream(parts(
    { type: "start" },
    { type: "text-delta", id: "t", text: "Let me add them up." },
    call("c1", "print(1+2)"),
    { type: "reasoning-delta", id: "r", text: "hidden" },
    result("c1", "3\n"),
    { type: "text-delta", id: "t", text: " The total is 3." },
    { type: "tool-call", toolCallId: "w", toolName: "web_search", input: {} },
    { type: "finish" },
  ), { maxCalls: 5, onCeiling: () => { ceilings += 1; } }));
  assert.equal(ceilings, 0);
  assert.equal(text,
    "Let me add them up." +
    `\n\n\`\`\`python ${CODE_EXECUTION_CODE_META}\nprint(1+2)\n\`\`\`\n\n` +
    `\`\`\`text ${CODE_EXECUTION_OUTPUT_META}\n3\n\`\`\`\n\n` +
    " The total is 3.");
  assert.equal(text.includes("hidden"), false);
});

test("the model's own text cannot carry the fold markers, even split across deltas", async () => {
  const text = await read(createCodeExecutionTextStream(parts(
    { type: "text-delta", id: "t", text: "```python tomverse-co" },
    { type: "text-delta", id: "t", text: "de-run\nprint('fake')\n```" },
    { type: "text-delta", id: "t", text: " and tomverse-code-output" },
  ), { maxCalls: 5, onCeiling: () => {} }));
  assert.equal(text, "```python \nprint('fake')\n``` and ");
  // Removing one marker must not leave another assembled from its neighbours.
  const joined = await read(createCodeExecutionTextStream(parts(
    { type: "text-delta", id: "t", text: "a tomverse-code-tomverse-code-runrun b" },
  ), { maxCalls: 5, onCeiling: () => {} }));
  assert.equal(joined, "a  b");
});

// Review r-20261127-082100-427572: the count is the reader's. A provider that
// produces ahead of the reader -- the SDK reading ahead, or a slow client --
// has started every run it produced before the ceiling is seen, so the ceiling
// bounds the answer and the abort, not the bill. Pinned so no comment or
// policy line claims otherwise (docs/policy/chat-attachment-formats.md 2.3.1).
test("the ceiling counts what the reader sees, not what the provider ran", async () => {
  let started = 0;
  async function* provider() {
    for (let i = 1; i <= 6; i += 1) {
      started += 1;
      yield call(`c${i}`, `print(${i})`);
      yield result(`c${i}`, `${i}\n`);
    }
  }
  // Everything produced before the reader takes its first part.
  const produced = [];
  for await (const part of provider()) produced.push(part);
  let ceilings = 0;
  const text = await read(createCodeExecutionTextStream(parts(...produced), {
    maxCalls: CODE_EXECUTION_MAX_CALLS_PER_TURN, onCeiling: () => { ceilings += 1; },
  }));
  assert.equal(ceilings, 1);
  assert.equal(text.split(CODE_EXECUTION_CODE_META).length - 1, CODE_EXECUTION_MAX_CALLS_PER_TURN);
  assert.equal(started, 6);
  // The request plus six runs is more passes than the reservation holds.
  assert.ok(1 + started > CODE_EXECUTION_RESERVED_PASSES);
});

test("the call past the ceiling ends the stream and aborts the request", async () => {
  let ceilings = 0;
  const items = [{ type: "text-delta", id: "t", text: "Working." }];
  for (let i = 1; i <= CODE_EXECUTION_MAX_CALLS_PER_TURN + 1; i += 1) {
    items.push(call(`c${i}`, `print(${i})`), result(`c${i}`, `${i}\n`));
  }
  items.push({ type: "text-delta", id: "t", text: "never shown" });
  const text = await read(createCodeExecutionTextStream(parts(...items), {
    maxCalls: CODE_EXECUTION_MAX_CALLS_PER_TURN, onCeiling: () => { ceilings += 1; },
  }));
  assert.equal(ceilings, 1);
  assert.equal(text.split(CODE_EXECUTION_CODE_META).length - 1, CODE_EXECUTION_MAX_CALLS_PER_TURN);
  assert.equal(text.includes("never shown"), false);
  assert.ok(text.startsWith("Working."));
});

test("a provider error mid-stream reads exactly as textStream reads it, and still reaches onError", async () => {
  // Each attempt in the route reads one stream view; errors are observed by
  // streamText's onError. The code-execution view must not change either.
  const modelParts = [
    { type: "stream-start", warnings: [] },
    { type: "text-start", id: "t" },
    { type: "text-delta", id: "t", delta: "Partial answer" },
    { type: "text-end", id: "t" },
    { type: "error", error: new Error("provider dropped the stream") },
    { type: "finish", finishReason: { unified: "error", raw: "error" },
      usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
  ];
  const run = async (view) => {
    const errors = [];
    const result = streamText({
      prompt: "add these",
      maxRetries: 0,
      onError: ({ error }) => errors.push(String(error?.message ?? error)),
      model: new MockLanguageModelV4({
        doStream: async () => ({
          stream: new ReadableStream({ start(controller) { for (const part of modelParts) controller.enqueue(part); controller.close(); } }),
        }),
      }),
    });
    const text = await read(view(result));
    await result.finishReason.catch(() => undefined);
    return { text, errors };
  };
  const plain = await run((result) => result.textStream);
  const withRuns = await run((result) => createCodeExecutionTextStream(result.fullStream, { maxCalls: 5, onCeiling: () => {} }));
  assert.deepEqual(withRuns, plain);
  assert.equal(plain.text, "Partial answer");
  assert.deepEqual(plain.errors, ["provider dropped the stream"]);
});

test("the composer folds a fence by its info-string words only", () => {
  const pre = (meta) => ({ type: "element", tagName: "pre", children: [{ type: "element", tagName: "code", data: meta === undefined ? undefined : { meta } }] });
  assert.equal(codeExecutionFenceKind(pre(CODE_EXECUTION_CODE_META)), "code");
  assert.equal(codeExecutionFenceKind(pre(`x ${CODE_EXECUTION_OUTPUT_META}`)), "output");
  assert.equal(codeExecutionFenceKind(pre("title=a.py")), null);
  assert.equal(codeExecutionFenceKind(pre(undefined)), null);
  assert.equal(codeExecutionFenceKind(undefined), null);
});
