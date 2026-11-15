import assert from "node:assert/strict";
import test from "node:test";
import type { LanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import { getActiveAiModel } from "../lib/activeAiModel";
import { getModel } from "../lib/models";

test("the pinned native Cohere adapter is assignable to the installed AI SDK protocol", () => {
  const configuration = getModel("command-a-plus");
  assert.ok(configuration);
  const previous = process.env.COHERE_CHAT_ENABLED;
  delete process.env.COHERE_CHAT_ENABLED;
  try {
    const providerModel: LanguageModelV4 = getActiveAiModel(configuration);
    const coreModel: LanguageModel = providerModel;
    assert.equal(coreModel.specificationVersion, "v4");
  } finally {
    if (previous === undefined) delete process.env.COHERE_CHAT_ENABLED;
    else process.env.COHERE_CHAT_ENABLED = previous;
  }
});
