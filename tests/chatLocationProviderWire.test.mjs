import assert from "node:assert/strict";
import test from "node:test";
import { generateText } from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { appendChatLocationContext, buildChatLocationPrompt } from "../lib/chatLocationPrompt.ts";
import { getModelGenerationSettings } from "../lib/modelGenerationCompatibility.ts";

test("consecutive located turns cache identical complete history in the actual Anthropic request bytes", async () => {
  const requests = [];
  const provider = createAnthropic({ apiKey: "isolated-wire-fixture", fetch: async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return Response.json({ id: "msg_fixture", type: "message", role: "assistant", model: "claude-haiku-4-5",
      content: [{ type: "text", text: "Fixture answer" }], stop_reason: "end_turn", stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 3 } });
  } });
  const original = [{ role: "user", content: "First question" }];
  const second = [...original, { role: "assistant", content: "First answer" }, { role: "user", content: "Nearby?" }];
  const third = [...second, { role: "assistant", content: "Second answer" }, { role: "user", content: "And here?" }];
  for (const [index, history] of [original, second, third].entries()) {
    const messages = structuredClone(history);
    const suppressAutomatic = appendChatLocationContext(messages, {
      latitude: -27 + index, longitude: 153, accuracy: 150, timestamp: Date.now(),
    }, true);
    await generateText({ model: provider("claude-haiku-4-5"), instructions: buildChatLocationPrompt(), messages,
      maxOutputTokens: 16, maxRetries: 0,
      ...getModelGenerationSettings({ id: "claude-haiku-4-5", provider: "anthropic" }, {
        promptCachePath: suppressAutomatic ? undefined : "chat_turn",
      }),
    });
  }
  assert.equal(requests.length, 3);
  for (const request of requests) {
    assert.equal(request.cache_control, undefined);
    assert.ok(JSON.stringify(request.messages.at(-1)).includes("latitude"));
    assert.ok(!JSON.stringify(request.messages.at(-1)).includes("cache_control"));
  }
  assert.ok(!JSON.stringify(requests[0]).includes("cache_control"));
  const cached = requests[1].messages[1].content.at(-1);
  assert.deepEqual(cached.cache_control, { type: "ephemeral", ttl: "5m" });
  assert.equal(cached.text, "First answer");
  const withoutMarkers = (value) => JSON.parse(JSON.stringify(value, (key, item) => key === "cache_control" ? undefined : item));
  assert.deepEqual(withoutMarkers(requests[1].messages.slice(0, 2)), withoutMarkers(requests[2].messages.slice(0, 2)));
  assert.ok(!JSON.stringify(requests[1].messages.slice(0, 2)).includes("latitude"));
  assert.deepEqual(requests[2].messages[3].content.at(-1).cache_control, { type: "ephemeral", ttl: "5m" });
  assert.equal(original[0].content, "First question");
});
