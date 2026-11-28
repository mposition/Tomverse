import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAT_REASONING_MARKER,
  CHAT_REASONING_MAX_CHARACTERS,
  buildChatReasoningChunk,
  readStoredChatReasoning,
  splitChatReasoning,
  storedChatReasoning,
  withStoredReasoning,
  withoutStoredReasoning,
} from "@/lib/chatReasoningDisplay";
import { chatReasoningDisplayEnabled, createChatReasoningRelay } from "@/lib/chatReasoningRelay";
import {
  getModelGenerationSettings,
  getReasoningSummaryProviderOptions,
} from "@/lib/modelGenerationCompatibility";
import { consumeChatStream } from "@/lib/chatStreamConsumer";
import { chatStreamDisplayText } from "@tomverse/chat-core";
import { toChatRequestMessage } from "@/lib/chatMessageSerialization";
import { toAccountExportMessage } from "@/lib/accountDataExport";
import { chatReasoningCopy, thoughtLabel } from "@/locales/chatReasoning";
import { SUPPORTED_LANGUAGES } from "@/lib/language";

/** Collects what the relay writes, parsed back through the real splitter. */
const harness = (options?: { flushIntervalMs?: number }) => {
  let clock = 1_000;
  const chunks: string[] = [];
  const relay = createChatReasoningRelay({ now: () => clock, flushIntervalMs: options?.flushIntervalMs ?? 0 });
  relay.setSink((chunk) => {
    chunks.push(chunk);
    return true;
  });
  return {
    relay,
    chunks,
    tick: (ms: number) => {
      clock += ms;
    },
    seen: () => splitChatReasoning(chunks.join("")),
  };
};
const part = (type: string, text?: string) => ({ chunk: { type, id: "r1", ...(text !== undefined ? { text } : {}) } });

test("the reasoning marker is NUL-led and one JSON object, like the other out-of-band chunks", () => {
  const chunk = buildChatReasoningChunk({ state: "thinking", text: "Checking the units" });
  assert.ok(chunk.startsWith(`${String.fromCharCode(0)}TOMVERSE_REASONING{`));
  assert.equal(chunk, `${CHAT_REASONING_MARKER}{"state":"thinking","text":"Checking the units"}`);
});

test("summary text accumulates across markers and is folded by done", () => {
  const raw =
    buildChatReasoningChunk({ state: "thinking" }) +
    buildChatReasoningChunk({ state: "thinking", text: "First, " }) +
    buildChatReasoningChunk({ state: "thinking", text: "then second." }) +
    "The answer";
  const thinking = splitChatReasoning(raw);
  assert.equal(thinking.text, "The answer");
  assert.deepEqual(thinking.reasoning, { text: "First, then second.", done: false, durationMs: null, truncated: false });
  assert.equal(thinking.count, 3);

  const done = splitChatReasoning(raw + buildChatReasoningChunk({ state: "done", durationMs: 12_400 }));
  assert.equal(done.reasoning?.done, true);
  assert.equal(done.reasoning?.durationMs, 12_400);
  assert.equal(done.reasoning?.text, "First, then second.");
});

test("a marker torn across two reads is held back, never shown as answer text", () => {
  const whole = `${buildChatReasoningChunk({ state: "thinking", text: "a {brace} \"quote\"" })}Answer`;
  // What the user reads is the display projection; the splitter only has to
  // hold back a half object and never throw on any cut.
  for (let cut = 1; cut < whole.length - "Answer".length; cut += 1) {
    const shown = chatStreamDisplayText(whole.slice(0, cut));
    assert.ok(!shown.includes("TOMVERSE"), `cut ${cut}: ${JSON.stringify(shown)}`);
    assert.ok(!shown.includes(String.fromCharCode(0)), `cut ${cut}`);
    const split = splitChatReasoning(whole.slice(0, cut));
    assert.ok(!split.text.includes('"state"'), `cut ${cut}: ${JSON.stringify(split.text)}`);
  }
  assert.equal(splitChatReasoning(whole).text, "Answer");
  assert.equal(splitChatReasoning(whole).reasoning?.text, 'a {brace} "quote"');
});

test("an unparseable or unknown marker is removed and adds nothing", () => {
  const raw = `${CHAT_REASONING_MARKER}{"state":"mystery"}${CHAT_REASONING_MARKER}{not json}Answer`;
  const split = splitChatReasoning(raw);
  assert.equal(split.text, "Answer");
  assert.equal(split.reasoning, null);
  assert.equal(split.count, 2);
});

test("a stream with no reasoning marker is returned untouched", () => {
  const split = splitChatReasoning("plain answer");
  assert.deepEqual(split, { text: "plain answer", reasoning: null, count: 0 });
});

test("reset starts the summary over, and the browser stops accepting past the limit", () => {
  const raw =
    buildChatReasoningChunk({ state: "thinking", text: "from the model that failed" }) +
    buildChatReasoningChunk({ state: "reset" }) +
    buildChatReasoningChunk({ state: "thinking", text: "x".repeat(CHAT_REASONING_MAX_CHARACTERS + 500) });
  const { reasoning } = splitChatReasoning(raw);
  assert.equal(reasoning?.text.length, CHAT_REASONING_MAX_CHARACTERS);
  assert.equal(reasoning?.truncated, true);
  assert.ok(!reasoning?.text.includes("failed"));
});

test("the display projection hides reasoning markers like every other control", () => {
  const raw = `${buildChatReasoningChunk({ state: "thinking", text: "private thoughts" })}Visible${buildChatReasoningChunk({ state: "done", durationMs: 1000 })} answer`;
  assert.equal(chatStreamDisplayText(raw), "Visible answer");
  // A torn marker is held back rather than shown.
  assert.equal(chatStreamDisplayText(`Visible${CHAT_REASONING_MARKER}{"state":"thi`), "Visible");
});

test("the relay sends a thinking signal even when the provider sends no text, then the time", () => {
  const { relay, tick, seen } = harness();
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  assert.deepEqual(seen().reasoning, { text: "", done: false, durationMs: null, truncated: false });
  tick(4_000);
  observe(part("reasoning-end"));
  observe(part("text-delta", "Hello"));
  const done = seen().reasoning;
  assert.equal(done?.done, true);
  assert.equal(done?.durationMs, 4_000);
  assert.equal(relay.snapshot()?.text, "");
  assert.equal(relay.snapshot()?.durationMs, 4_000);
});

test("the relay streams summary text and folds it at the first visible token", () => {
  const { relay, tick, seen } = harness();
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", "**Plan**\n"));
  tick(1_500);
  observe(part("reasoning-delta", "Compare both options."));
  assert.equal(seen().reasoning?.text, "**Plan**\nCompare both options.");
  assert.equal(seen().reasoning?.done, false);
  tick(500);
  observe(part("reasoning-end"));
  observe(part("text-delta", "The answer"));
  observe(part("text-delta", " continues"));
  assert.equal(seen().reasoning?.done, true);
  assert.equal(seen().reasoning?.durationMs, 2_000);
  // Visible text after the first delta writes nothing more.
  const written = seen().count;
  observe(part("text-delta", " more"));
  assert.equal(seen().count, written);
  assert.deepEqual(relay.snapshot(), { text: "**Plan**\nCompare both options.", durationMs: 2_000 });
});

test("a second reasoning block reads as a new paragraph and the total is restated at the end", () => {
  const { relay, tick, seen } = harness();
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", "First step."));
  tick(1_000);
  observe(part("reasoning-end"));
  observe(part("text-delta", "Searching."));
  tick(3_000);
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", "Second step."));
  tick(2_000);
  observe(part("reasoning-end"));
  relay.finish();
  assert.equal(seen().reasoning?.text, "First step.\n\nSecond step.");
  assert.equal(seen().reasoning?.done, true);
  assert.equal(seen().reasoning?.durationMs, 3_000);
});

test("text that arrives before the sink exists waits and goes out when the stream is attached", () => {
  const chunks: string[] = [];
  const relay = createChatReasoningRelay({ now: () => 0, flushIntervalMs: 0 });
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", "early thought"));
  assert.equal(chunks.length, 0);
  relay.setSink((chunk) => {
    chunks.push(chunk);
    return true;
  });
  assert.equal(splitChatReasoning(chunks.join("")).reasoning?.text, "early thought");
});

test("a fast provider that finishes thinking before the stream exists loses nothing and keeps the order", () => {
  const chunks: string[] = [];
  let clock = 0;
  const relay = createChatReasoningRelay({ now: () => clock, flushIntervalMs: 0 });
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", "quick thought"));
  clock = 2_000;
  observe(part("reasoning-end"));
  observe(part("text-delta", "Answer"));
  relay.setSink((chunk) => {
    chunks.push(chunk);
    return true;
  });
  const seen = splitChatReasoning(chunks.join(""));
  assert.deepEqual(seen.reasoning, { text: "quick thought", done: true, durationMs: 2_000, truncated: false });
});

test("deltas inside the flush interval are coalesced into one chunk", () => {
  const { relay, tick, chunks } = harness({ flushIntervalMs: 200 });
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  const afterStart = chunks.length;
  observe(part("reasoning-delta", "a"));
  tick(50);
  observe(part("reasoning-delta", "b"));
  relay.finish();
  const joined = splitChatReasoning(chunks.slice(afterStart).join(""));
  assert.equal(joined.reasoning?.text, "ab");
  relay.dispose();
});

test("the relay keeps at most the limit and says so", () => {
  const { relay, seen } = harness();
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", "y".repeat(CHAT_REASONING_MAX_CHARACTERS - 5)));
  observe(part("reasoning-delta", "z".repeat(50)));
  observe(part("reasoning-delta", "more"));
  relay.finish();
  assert.equal(seen().reasoning?.text.length, CHAT_REASONING_MAX_CHARACTERS);
  assert.equal(relay.snapshot()?.text.length, CHAT_REASONING_MAX_CHARACTERS);
  assert.equal(relay.snapshot()?.truncated, true);
});

test("a model that never reasons leaves no trace: nothing is written and there is nothing to store", () => {
  const { relay, chunks } = harness();
  const observe = relay.attempt();
  observe(part("text-delta", "Hi"));
  observe(part("tool-call"));
  observe({ chunk: null });
  relay.finish();
  assert.deepEqual(chunks, []);
  assert.equal(relay.snapshot(), null);
});

test("a displaced attempt cannot write into the answer that replaced it, and the browser is told to start over", () => {
  const { relay, seen } = harness();
  const first = relay.attempt();
  first(part("reasoning-start"));
  first(part("reasoning-delta", "the failed model thought this"));
  const second = relay.attempt();
  first(part("reasoning-delta", "late text from the displaced attempt"));
  assert.equal(seen().reasoning, null);
  second(part("reasoning-start"));
  second(part("reasoning-delta", "the fallback thought this"));
  assert.equal(seen().reasoning?.text, "the fallback thought this");
});

test("once the response stream refuses a chunk the relay stops writing", () => {
  let accepted = 0;
  const relay = createChatReasoningRelay({ now: () => 0, flushIntervalMs: 0 });
  relay.setSink(() => {
    accepted += 1;
    return false;
  });
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", "a"));
  observe(part("reasoning-delta", "b"));
  assert.equal(accepted, 1);
});

test("a NUL in model text is dropped so it cannot forge a marker", () => {
  const { relay, seen } = harness();
  const observe = relay.attempt();
  observe(part("reasoning-start"));
  observe(part("reasoning-delta", `before${String.fromCharCode(0)}TOMVERSE_STREAM_KEEPALIVE{}after`));
  assert.equal(seen().reasoning?.text, "beforeTOMVERSE_STREAM_KEEPALIVE{}after");
});

test("the stored copy round-trips, is bounded, and is read defensively", () => {
  const stored = storedChatReasoning({ text: "plan", durationMs: 7_000, truncated: false });
  const metadata = withStoredReasoning({ requested: false }, stored);
  assert.deepEqual(readStoredChatReasoning(metadata), { text: "plan", done: true, durationMs: 7_000, truncated: false });
  assert.equal(withStoredReasoning({ requested: false }, null).hasOwnProperty("reasoning"), false);
  assert.deepEqual(withStoredReasoning(null, stored), { reasoning: stored });

  assert.equal(readStoredChatReasoning(null), null);
  assert.equal(readStoredChatReasoning([]), null);
  assert.equal(readStoredChatReasoning({ reasoning: "text" }), null);
  assert.equal(readStoredChatReasoning({ reasoning: { text: 5 } }), null);
  const huge = readStoredChatReasoning({ reasoning: { text: "q".repeat(CHAT_REASONING_MAX_CHARACTERS * 2), durationMs: -3 } });
  assert.equal(huge?.text.length, CHAT_REASONING_MAX_CHARACTERS);
  assert.equal(huge?.truncated, true);
  assert.equal(huge?.durationMs, null);
});

test("the saved summary never rides a request transcript or an account export", () => {
  const stored = storedChatReasoning({ text: "private thoughts", durationMs: 1, truncated: false });
  const metadata = withStoredReasoning({ requested: true, supported: true, executed: false, provider: "none", citations: [] }, stored);
  assert.equal(JSON.stringify(withoutStoredReasoning(metadata)).includes("private thoughts"), false);
  assert.deepEqual(withoutStoredReasoning({ requested: true }), { requested: true });
  assert.equal(withoutStoredReasoning(null), null);

  const request = toChatRequestMessage({
    id: "a",
    role: "assistant",
    content: "answer",
    searchMetadata: metadata as never,
    reasoning: { text: "runtime thoughts", done: true, durationMs: 1, truncated: false },
  });
  const wire = JSON.stringify(request);
  assert.equal(wire.includes("private thoughts"), false);
  assert.equal(wire.includes("runtime thoughts"), false);
  assert.equal(request.searchMetadata?.requested, true);

  const exported = toAccountExportMessage({
    role: "assistant",
    content: "answer",
    modelId: "m",
    createdAt: new Date(0),
    searchMetadata: metadata,
  });
  assert.equal(JSON.stringify(exported).includes("private thoughts"), false);
});

test("the switch is off unless it is exactly true", () => {
  assert.equal(chatReasoningDisplayEnabled({}), false);
  for (const value of ["", "1", "TRUE", "True", "yes", "on", " true"]) {
    assert.equal(chatReasoningDisplayEnabled({ CHAT_REASONING_DISPLAY_ENABLED: value }), false, value);
  }
  assert.equal(chatReasoningDisplayEnabled({ CHAT_REASONING_DISPLAY_ENABLED: "true" }), true);
});

/* ---- the request: only a model that already reasons gets a summary option ---- */

const model = (provider: string, reasoning?: "none" | "low" | "medium" | "high") => ({
  id: `${provider}-model`,
  provider,
  reasoning,
  apiModel: `${provider}-model`,
}) as Parameters<typeof getModelGenerationSettings>[0];

test("with the summary option off the request is exactly what it was", () => {
  for (const candidate of [model("anthropic", "high"), model("openai", "medium"), model("google"), model("deepseek", "high"), model("openai")]) {
    assert.deepEqual(
      getModelGenerationSettings(candidate, { reasoningSummary: false }),
      getModelGenerationSettings(candidate)
    );
    assert.deepEqual(
      getModelGenerationSettings(candidate, { reasoningSummary: undefined }),
      getModelGenerationSettings(candidate)
    );
  }
});

test("the summary option changes what comes back and never how much the model reasons", () => {
  const anthropic = getModelGenerationSettings(model("anthropic", "high"), { reasoningSummary: true });
  assert.deepEqual(anthropic.providerOptions, {
    anthropic: { thinking: { type: "adaptive", display: "summarized" }, effort: "high" },
  });
  const openai = getModelGenerationSettings(model("openai", "medium"), { reasoningSummary: true });
  assert.deepEqual(openai.providerOptions, { openai: { reasoningEffort: "medium", reasoningSummary: "auto" } });
  const google = getModelGenerationSettings(model("google"), { reasoningSummary: true });
  assert.deepEqual(google.providerOptions, { google: { thinkingConfig: { includeThoughts: true } } });
  // Effort, where there is one, is carried through untouched.
  for (const [candidate, namespace, key] of [
    [model("anthropic", "low"), "anthropic", "effort"],
    [model("openai", "high"), "openai", "reasoningEffort"],
  ] as const) {
    const base = getModelGenerationSettings(candidate).providerOptions as Record<string, Record<string, unknown>>;
    const withSummary = getModelGenerationSettings(candidate, { reasoningSummary: true }).providerOptions as Record<string, Record<string, unknown>>;
    assert.equal(withSummary[namespace][key], base[namespace][key]);
  }
});

test("a model that does not reason is never asked to start", () => {
  // No reasoning profile, an explicit "none", and providers with no summary option.
  assert.equal(getReasoningSummaryProviderOptions(model("anthropic")), undefined);
  assert.equal(getReasoningSummaryProviderOptions(model("anthropic", "none")), undefined);
  assert.equal(getReasoningSummaryProviderOptions(model("openai")), undefined);
  assert.equal(getReasoningSummaryProviderOptions(model("openai", "none")), undefined);
  for (const provider of ["deepseek", "xai", "qwen", "zhipu", "minimax", "moonshot", "mistral", "groq", "perplexity", "cohere"]) {
    assert.equal(getReasoningSummaryProviderOptions(model(provider, "high")), undefined, provider);
  }
  // The same model with no profile gets no providerOptions at all.
  assert.deepEqual(getModelGenerationSettings(model("anthropic"), { reasoningSummary: true }), {});
});

/* ---- the browser's reader ------------------------------------------------ */

const streamOf = (pieces: string[]) => {
  const encoder = new TextEncoder();
  let index = 0;
  return {
    read: async () =>
      index < pieces.length
        ? { done: false as const, value: encoder.encode(pieces[index++]) }
        : { done: true as const, value: undefined },
  } as unknown as ReadableStreamDefaultReader<Uint8Array>;
};
const liveness = { noteKeepalive() {}, noteVisibleChunk() {}, noteServerSignal() {} };

test("the stream reader reports the summary beside the answer and never inside it", async () => {
  const raw =
    buildChatReasoningChunk({ state: "thinking" }) +
    buildChatReasoningChunk({ state: "thinking", text: "Weighing options. " }) +
    "Hello" +
    buildChatReasoningChunk({ state: "done", durationMs: 3_000 }) +
    " world";
  // Cut inside a marker's JSON to prove a torn read is not shown.
  const cut = raw.indexOf("Weighing") + 4;
  const progress: Array<{ displayText: string; reasoning: unknown }> = [];
  const result = await consumeChatStream({
    reader: streamOf([raw.slice(0, cut), raw.slice(cut)]),
    liveness,
    onProgress: ({ displayText, reasoning }) => progress.push({ displayText, reasoning }),
  });
  assert.ok(progress.every((step) => !step.displayText.includes("TOMVERSE")));
  assert.equal(result.displayText, "Hello world");
  assert.deepEqual(result.reasoning, { text: "Weighing options. ", done: true, durationMs: 3_000, truncated: false });
});

test("a stream with no reasoning reports none and reads as it always did", async () => {
  const result = await consumeChatStream({
    reader: streamOf(["Plain ", "answer"]),
    liveness,
    onProgress: ({ reasoning }) => assert.equal(reasoning, null),
  });
  assert.equal(result.displayText, "Plain answer");
  assert.equal(result.reasoning, null);
});

test("reasoning chunks count as the server writing, not as the answer progressing", async () => {
  const calls: string[] = [];
  await consumeChatStream({
    reader: streamOf([buildChatReasoningChunk({ state: "thinking", text: "hm" }), "A"]),
    liveness: {
      noteKeepalive: () => calls.push("keepalive"),
      noteVisibleChunk: () => calls.push("visible"),
      noteServerSignal: () => calls.push("signal"),
    },
    onProgress: () => {},
  });
  assert.deepEqual(calls, ["signal", "visible"]);
});

/* ---- words ---------------------------------------------------------------- */

test("every language has the words and the duration label fills its numbers", () => {
  for (const language of SUPPORTED_LANGUAGES) {
    const copy = chatReasoningCopy[language];
    assert.ok(copy, language);
    for (const value of Object.values(copy)) assert.ok(value.trim().length > 0, language);
    assert.ok(copy.thoughtSeconds.includes("{seconds}"), language);
    assert.ok(copy.thoughtMinutes.includes("{minutes}") && copy.thoughtMinutes.includes("{seconds}"), language);
    assert.ok(!thoughtLabel(copy, 12_000).includes("{"), language);
    assert.ok(!thoughtLabel(copy, 125_000).includes("{"), language);
    assert.equal(thoughtLabel(copy, null), copy.thought);
  }
  assert.equal(thoughtLabel(chatReasoningCopy.en, 12_400), "Thought for 12s");
  assert.equal(thoughtLabel(chatReasoningCopy.en, 100), "Thought for 1s");
  assert.equal(thoughtLabel(chatReasoningCopy.en, 125_000), "Thought for 2m 5s");
  assert.equal(thoughtLabel(chatReasoningCopy.ko, 12_000), "12초 동안 생각함");
});
