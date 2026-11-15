import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "ai";
import { getModel } from "../lib/models.ts";
import { getResearchPreviewAiModel, researchPreviewGoogleFetch } from "../lib/researchPreviewModel.ts";

test("Google SDK internal continuation opens no second Research HTTP request", async () => {
  const previousFetch = globalThis.fetch;
  const previousKey = process.env.GOOGLE_GENERATIVE_AI_API_KEY;
  let requests = 0;
  process.env.GOOGLE_GENERATIVE_AI_API_KEY = "offline-research-fixture-only";
  globalThis.fetch = async () => {
    requests++;
    return Response.json({ candidates: [{ content: { role: "model", parts: [{ text: "Unfinished output" }] },
      finishReason: "CONTINUATION", continuationToken: "must-not-be-replayed" }],
      usageMetadata: { promptTokenCount: 20, candidatesTokenCount: 10, thoughtsTokenCount: 5 } });
  };
  try {
    const configuration = { ...getModel("gemini-3-1-pro"), id: "gemini-4-argon", apiModel: "gemini-4-argon" };
    await assert.rejects(generateText({ model: getResearchPreviewAiModel(configuration), prompt: "A public question", maxOutputTokens: 4096, maxRetries: 0 }), /CONTINUATION_REFUSED/);
    assert.equal(requests, 1);
    await assert.rejects(researchPreviewGoogleFetch("https://generativelanguage.googleapis.com", { body: JSON.stringify({ continuationToken: "no" }) }), /CONTINUATION_REFUSED/);
    assert.equal(requests, 1);
  } finally {
    globalThis.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GOOGLE_GENERATIVE_AI_API_KEY; else process.env.GOOGLE_GENERATIVE_AI_API_KEY = previousKey;
  }
});
