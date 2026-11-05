import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import test from "node:test";

import { APICallError, jsonSchema, streamText } from "ai";
import { MockLanguageModelV4 } from "ai/test";

import { logStreamErrorWithoutContent } from "../lib/providerErrorClassification.ts";

// A stream error reaches the log as metadata and nothing else.
//
// The SDK's default `onError` is `console.error(error)`, and its errors carry
// what the model and the user wrote: reasoning on a tool choice violation, the
// request and response bodies on an API call error. These cases go through the
// real `streamText`, because what an error object holds is the SDK's to decide.

const PROMPT = "SYNTHETIC-PROMPT-MARKER";
const REASONING = "SYNTHETIC-REASONING-MARKER";
const ANSWER = "SYNTHETIC-ANSWER-MARKER";
const MARKERS = [PROMPT, REASONING, ANSWER];

const ALLOWED_FIELDS = new Set([
  "event",
  "traceId",
  "modelId",
  "name",
  "code",
  "statusCode",
  "isRetryable",
  "finishReason",
]);

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

const modelStreaming = (parts) =>
  new MockLanguageModelV4({
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          for (const part of parts) controller.enqueue(part);
          controller.close();
        },
      }),
    }),
  });

const apiCallError = () =>
  new APICallError({
    message: "provider refused the request",
    url: "https://provider.invalid/v1",
    requestBodyValues: { prompt: PROMPT },
    responseBody: JSON.stringify({ output: ANSWER, reasoning: REASONING }),
    statusCode: 500,
    isRetryable: false,
  });

/** Runs one stream with the route's `onError`, capturing console.error. */
const drive = async (options) => {
  const logged = [];
  const realError = console.error;
  console.error = (...args) => logged.push(args);
  let text = "";
  try {
    const result = streamText({
      prompt: PROMPT,
      maxRetries: 0,
      onError: logStreamErrorWithoutContent({
        traceId: "trace-1",
        modelId: "gpt-test",
      }),
      ...options,
    });
    for await (const chunk of result.textStream) text += chunk;
    await result.finishReason.catch(() => undefined);
  } finally {
    console.error = realError;
  }
  return { logged, text };
};

const assertMetadataOnly = (logged) => {
  assert.ok(logged.length > 0, "the error was not logged at all");
  for (const args of logged) {
    assert.equal(args.length, 1, "an extra console argument can carry an object");
    assert.equal(typeof args[0], "string");
    for (const marker of MARKERS) {
      assert.equal(args[0].includes(marker), false, `${marker} reached the log`);
    }
    const record = JSON.parse(args[0]);
    for (const field of Object.keys(record)) {
      assert.ok(ALLOWED_FIELDS.has(field), `unexpected log field: ${field}`);
    }
    assert.equal(record.event, "chat_stream_error");
    assert.equal(record.traceId, "trace-1");
    assert.equal(record.modelId, "gpt-test");
  }
};

test("a tool choice violation logs its name and finish reason, not the reasoning", async () => {
  const { logged } = await drive({
    model: modelStreaming([
      { type: "reasoning-start", id: "r" },
      { type: "reasoning-delta", id: "r", delta: REASONING },
      { type: "reasoning-end", id: "r" },
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: ANSWER },
      { type: "text-end", id: "t" },
      { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage },
    ]),
    tools: {
      web_search: {
        description: "search",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
      },
    },
    toolChoice: "required",
  });
  assertMetadataOnly(logged);
  const record = JSON.parse(logged[0][0]);
  assert.equal(record.name, "AI_ToolChoiceViolationError");
  assert.equal(record.finishReason, "stop");
});

test("an API call error logs its status, not the prompt or the response body", async () => {
  const { logged } = await drive({
    model: new MockLanguageModelV4({
      doStream: async () => {
        throw apiCallError();
      },
    }),
  });
  assertMetadataOnly(logged);
  const record = JSON.parse(logged[0][0]);
  assert.equal(record.name, "AI_APICallError");
  assert.equal(record.statusCode, 500);
  assert.equal(record.isRetryable, false);
});

test("an error part mid-stream logs metadata and the text already sent still arrives", async () => {
  const { logged, text } = await drive({
    model: modelStreaming([
      { type: "text-start", id: "t" },
      { type: "text-delta", id: "t", delta: ANSWER },
      { type: "text-end", id: "t" },
      { type: "error", error: apiCallError() },
      { type: "finish", finishReason: { unified: "error", raw: "error" }, usage },
    ]),
  });
  assertMetadataOnly(logged);
  assert.equal(text, ANSWER);
});

test("fields shaped like prose are dropped, whatever object the provider sent", () => {
  for (const error of [
    `${PROMPT} ${ANSWER}`,
    { message: REASONING, content: REASONING, text: ANSWER },
    { name: `${REASONING} with spaces`, code: `${ANSWER} with spaces`, finishReason: REASONING },
    null,
    undefined,
  ]) {
    const logged = [];
    const realError = console.error;
    console.error = (...args) => logged.push(args);
    let returned;
    try {
      returned = logStreamErrorWithoutContent({ traceId: "trace-1", modelId: "gpt-test" })({
        error,
      });
    } finally {
      console.error = realError;
    }
    assert.equal(returned, undefined, "an onError result can ask the SDK to retry");
    assertMetadataOnly(logged);
  }
});

/* -------------------------------------------------------------------------- */
/* No streaming call is left to the SDK's default                              */
/* -------------------------------------------------------------------------- */

const root = resolve(import.meta.dirname, "..");

const sourceFiles = (dir, found = []) => {
  for (const entry of readdirSync(join(root, dir))) {
    const full = join(dir, entry);
    if (statSync(join(root, full)).isDirectory()) sourceFiles(full, found);
    else if ([".ts", ".tsx", ".mjs"].includes(extname(entry))) found.push(full);
  }
  return found;
};

/** The options object of every call to a primitive that defaults to console.error. */
const streamingCalls = (source) => {
  // Docs quote `streamText({ maxOutputTokens })`; only code is a call.
  const code = source
    .split("\n")
    .filter((line) => !/^\s*(?:\/\/|\/?\*)/.test(line))
    .join("\n");
  return [...code.matchAll(/\b(?:streamText|streamObject|streamSpeech)\(\{/g)].map((match) => {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < code.length && depth > 0) {
      if (code[index] === "{") depth += 1;
      else if (code[index] === "}") depth -= 1;
      index += 1;
    }
    return code.slice(match.index + match[0].length, index - 1);
  });
};

test("every streaming SDK call passes its own onError", () => {
  let calls = 0;
  for (const file of [...sourceFiles("app"), ...sourceFiles("lib")]) {
    for (const options of streamingCalls(readFileSync(join(root, file), "utf8"))) {
      calls += 1;
      assert.match(options, /(?:^|\n)\s*onError\s*[:,]/, `${file} relies on the SDK's console.error`);
    }
  }
  // Two in the chat route and one on the pinned path. Finding none would mean
  // this pattern stopped matching, not that the rule holds.
  assert.ok(calls >= 3, `found only ${calls} streaming calls`);
});
