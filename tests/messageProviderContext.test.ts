import assert from "node:assert/strict";
import test from "node:test";

import {
  parseProviderResponseMessages,
  providerContextText,
  serializeProviderResponseMessages,
} from "../lib/messageProviderContext";

test("provider reasoning state round-trips privately for a later turn", () => {
  const response = [
    {
      role: "assistant",
      content: [
        { type: "reasoning", text: "private reasoning" },
        { type: "text", text: "visible answer" },
      ],
    },
  ];
  const stored = serializeProviderResponseMessages(response);
  assert.ok(stored);
  const restored = parseProviderResponseMessages(stored!.messages);
  assert.deepEqual(restored, response);
  assert.equal(
    providerContextText(restored!),
    "private reasoning\nvisible answer"
  );
});

test("provider reasoning state is bounded and accepts response roles only", () => {
  assert.equal(
    serializeProviderResponseMessages([
      { role: "user", content: "not a provider response" },
    ]),
    null
  );
  assert.equal(
    serializeProviderResponseMessages([
      { role: "assistant", content: "x".repeat(2 * 1024 * 1024) },
    ]),
    null
  );
});
