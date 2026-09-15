import assert from "node:assert/strict";
import test from "node:test";

import {
  assistantKnowledgeSupademoEmbeds,
  parseAssistantKnowledgeSupademoUrl,
} from "../lib/assistantKnowledgeSupademoCore.ts";

test("Supademo embeds accept only HTTPS Supademo hosts", () => {
  assert.equal(
    parseAssistantKnowledgeSupademoUrl(
      "https://app.supademo.com/showcase/example#step-2"
    ),
    "https://app.supademo.com/showcase/example"
  );
  assert.equal(
    parseAssistantKnowledgeSupademoUrl("https://supademo.com/demo/example"),
    "https://supademo.com/demo/example"
  );

  for (const value of [
    "http://app.supademo.com/demo/example",
    "https://supademo.com.evil.test/demo/example",
    "https://user:secret@app.supademo.com/demo/example",
    "https://app.supademo.com:8443/demo/example",
    "javascript:alert(1)",
  ]) {
    assert.equal(parseAssistantKnowledgeSupademoUrl(value), null);
  }
});

test("localized Supademo embeds are independently optional", () => {
  assert.deepEqual(
    assistantKnowledgeSupademoEmbeds({
      ko: "https://app.supademo.com/demo/korean",
      en: "https://app.supademo.com/demo/english",
      zh: "",
    }),
    {
      ko: "https://app.supademo.com/demo/korean",
      en: "https://app.supademo.com/demo/english",
    }
  );
});
