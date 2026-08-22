import assert from "node:assert/strict";
import test from "node:test";

import { streamText } from "ai";

import { splitProviderInstructions } from "../lib/chatProviderPrompt.ts";

// The split that keeps `ai@7` from refusing the turn.
//
// The shape assertions below are the cheap half. The half that matters is at
// the bottom: it hands the result to the real `streamText`, because both times
// this broke, the code looked right and only the SDK disagreed. A test that
// re-states the rule in its own words would have passed on both bugs.

const user = { role: "user", content: "hi" };
const assistant = { role: "assistant", content: "hello" };

test("a system message becomes instructions and leaves messages", () => {
  const result = splitProviderInstructions([
    { role: "system", content: "be brief" },
    user,
  ]);
  assert.equal(result.instructions, "be brief");
  assert.deepEqual(result.messages, [user]);
});

test("several system blocks are joined in order", () => {
  // The order is the policy's: context first, then the artifact block.
  const result = splitProviderInstructions([
    { role: "system", content: "context" },
    { role: "system", content: "artifact" },
    user,
  ]);
  assert.equal(result.instructions, "context\n\nartifact");
  assert.deepEqual(result.messages, [user]);
});

test("a system message anywhere in the array is still extracted", () => {
  // Not only leading ones: a filter that assumed position is a filter that
  // leaves one behind the first time the assembly order changes.
  const result = splitProviderInstructions([user, { role: "system", content: "s" }, assistant]);
  assert.equal(result.instructions, "s");
  assert.deepEqual(result.messages, [user, assistant]);
});

test("no system message means no instructions key at all", () => {
  const result = splitProviderInstructions([user, assistant]);
  assert.equal("instructions" in result, false);
  assert.deepEqual(result.messages, [user, assistant]);
});

test("an empty or whitespace system block is dropped, not sent as empty", () => {
  assert.equal("instructions" in splitProviderInstructions([{ role: "system", content: "   " }, user]), false);
});

test("text parts are kept and other parts are dropped rather than stringified", () => {
  const result = splitProviderInstructions([
    {
      role: "system",
      content: [
        { type: "text", text: "one" },
        { type: "file", data: "x", mediaType: "image/png" },
        { type: "text", text: "two" },
      ],
    },
    user,
  ]);
  assert.equal(result.instructions, "one\n\ntwo");
  assert.ok(!String(result.instructions).includes("object Object"));
});

test("the user's own messages are untouched, including their order", () => {
  const conversation = [user, assistant, { role: "user", content: "again" }];
  const result = splitProviderInstructions([
    { role: "system", content: "s" },
    ...conversation,
  ]);
  assert.deepEqual(result.messages, conversation);
});

/* -------------------------------------------------------------------------- */
/* The half with teeth                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A model that never answers.
 *
 * `streamText` validates the prompt before it reaches the model, which is the
 * only thing under test here -- so the model only has to be shaped like one.
 */
const silentModel = {
  specificationVersion: "v3",
  provider: "test",
  modelId: "test",
  supportedUrls: {},
  async doStream() {
    return {
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "stream-start", warnings: [] });
          controller.enqueue({
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          });
          controller.close();
        },
      }),
    };
  },
};

/**
 * Everything that went wrong for one call.
 *
 * Collected through `onError` as well as the awaited rejection, because the
 * two are not the same error and only one of them names the cause. The prompt
 * rejection is raised inside the stream's own task and reaches the consumer
 * wrapped as `AI_NoOutputGeneratedError` with no `cause` -- which is exactly
 * why this shipped looking like a provider fault.
 */
const drive = async (options) => {
  const errors = [];
  const result = streamText({
    model: silentModel,
    onError: ({ error }) => errors.push(error),
    ...options,
  });
  try {
    for await (const chunk of result.textStream) void chunk;
    await result.finishReason;
  } catch (error) {
    errors.push(error);
  }
  return errors.map((error) => `${error?.name ?? ""}: ${error?.message ?? error}`);
};

test("the real streamText accepts what this returns", async () => {
  const { messages, instructions } = splitProviderInstructions([
    { role: "system", content: "context" },
    { role: "system", content: "artifact" },
    user,
  ]);
  assert.deepEqual(await drive({ messages, instructions }), []);
});

test("and refuses the array this split exists to prevent", async () => {
  // Proof that the test above is not passing vacuously: the same messages
  // without the split are exactly the request that reached staging.
  //
  // Note what the caller sees. The prompt rejection arrives at the consumer as
  // `AI_NoOutputGeneratedError` -- "no output generated" -- which this
  // application classifies as an empty response and reports as "the provider
  // ended the request without an answer". That is why the bug read as a
  // provider fault in the UI and named nothing about a prompt: trace
  // cbd6b2b5-9cae-4aa8-976e-b220f25b7232 on staging.
  const errors = await drive({
    messages: [{ role: "system", content: "artifact" }, user],
  });
  assert.ok(
    errors.some((error) => /System messages are not allowed/.test(error)),
    `expected a prompt rejection, got: ${JSON.stringify(errors)}`
  );
  assert.ok(errors.some((error) => /NoOutputGenerated/.test(error)));
});
