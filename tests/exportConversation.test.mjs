import assert from "node:assert/strict";
import test from "node:test";

import { formatConversationAsText, formatConversationHeader, formatExportMessage } from "../lib/exportConversation.ts";
import { AVAILABLE_MODELS, getModel, isRetiredModel } from "../lib/models.ts";

test("Chat downloads identify the product and retain every model's answer", () => {
  const output = formatConversationAsText({
    title: "A Chat conversation",
    productKey: "chat",
    messages: [
      { role: "user", content: "First question" },
      { role: "assistant", content: "First answer", modelId: "gpt-5-4-mini" },
      { role: "assistant", content: "Follow-up answer", modelId: "gpt-4o" },
    ],
  });
  assert.match(output, /^Tomverse Chat Export\n/);
  assert.match(output, /First answer/);
  assert.match(output, /Follow-up answer/);
  assert.match(output, /\[GPT-4o\]/);
});

test("legacy and Review downloads retain their existing product header", () => {
  for (const productKey of [undefined, null, "review"]) {
    assert.match(formatConversationHeader({ title: "Review", productKey }), /^Tomverse Review Export\n/);
  }
});

// Exporting is one of the few places a retired model's answers are still read
// in full. Retirement deliberately keeps the catalogue entry, so the export
// must print the name the user saw at the time rather than a bare id.

test("an assistant turn is labelled with its model's display name", () => {
  const output = formatExportMessage({
    role: "assistant",
    content: "Answer.",
    modelId: "gpt-5-4-mini",
  });
  assert.match(output, /\[GPT-5\.4 mini\]/);
});

test("a retired model's turns keep the name they were answered under", () => {
  const retired = AVAILABLE_MODELS.filter(isRetiredModel);
  assert.ok(retired.length > 0);
  for (const model of retired) {
    const output = formatExportMessage({
      role: "assistant",
      content: "Historical answer.",
      modelId: model.id,
    });
    assert.ok(
      output.includes(`[${model.name}]`),
      `${model.id} exported as something other than "${model.name}"`
    );
    assert.ok(output.includes("Historical answer."));
  }
});

test("Llama and the older Grok models specifically survive an export", () => {
  for (const modelId of [
    "llama-3-1",
    "llama-3-3",
    "llama-4-scout",
    "grok-4",
    "grok-3",
    "grok-3-mini",
  ]) {
    const model = getModel(modelId);
    assert.ok(model, `${modelId} must stay resolvable`);
    assert.match(
      formatExportMessage({
        role: "assistant",
        content: "Old answer.",
        modelId,
      }),
      new RegExp(`\\[${model.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]`)
    );
  }
});

test("an id no longer in the catalogue falls back rather than breaking", () => {
  assert.match(
    formatExportMessage({ role: "assistant", content: "x", modelId: "gpt-4o" }),
    /\[GPT-4o\]/
  );
  assert.match(
    formatExportMessage({
      role: "assistant",
      content: "x",
      modelId: "some-id-nobody-knows",
    }),
    /\[some-id-nobody-knows\]/
  );
});

test("a user turn is never labelled with a model", () => {
  assert.match(
    formatExportMessage({ role: "user", content: "Question?" }),
    /\[User\]/
  );
});
