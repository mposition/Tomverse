import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { QwenUsage } from "../src/host/qwen-usage";

const thread = "409ef18f-3153-415b-a4ec-e5379f6fcbcb";
const model = "fixture-model";

function fixture() {
  const usage = new QwenUsage();
  const observe = (_meta: Record<string, unknown>) => usage.observe({ sessionUpdate: "agent_message_chunk",
    content: { type: "text", text: "" }, _meta }, thread, model);
  const request = (executionId: string, phase: "started" | "ended", prompt = 1, scopedModel = model) => observe({
    executionLifecycle: { v: 1, kind: "request", phase, executionId, sessionId: thread,
      promptId: `${thread}########${prompt}`, model: scopedModel, ...(phase === "ended" && { outcome: "success" }) },
  });
  return { request, report: (inputTokens: number, outputTokens: number) => observe({ usage: { inputTokens, outputTokens } }), usage };
}

test("Qwen usage includes only linked reports and does not carry earlier prompts into a follow-up", () => {
  const { usage, request, report } = fixture();
  const first = randomUUID(), second = randomUUID();
  usage.startPrompt();
  request(first, "started");
  request(first, "started");
  request(first, "ended");
  report(17, 6);
  report(1000, 1000);
  request(second, "started");
  request(second, "ended");
  usage.observe({ sessionUpdate: "usage_update", used: 5000 }, thread, model);
  report(1000, 1000);
  assert.deepEqual(usage.result(), { source: "qwen_requests", requestCount: 2,
    requests: [{ executionId: first, inputTokens: 17, outputTokens: 6 }] });

  usage.startPrompt();
  request(first, "started");
  request(first, "ended");
  report(17, 6);
  assert.equal(usage.result(), undefined);
  const next = randomUUID();
  request(next, "started", 2);
  request(next, "ended", 2);
  report(31, 7);
  assert.deepEqual(usage.result(), { source: "qwen_requests", requestCount: 1,
    requests: [{ executionId: next, inputTokens: 31, outputTokens: 7 }] });
});

test("Qwen usage leaves out invalid counts and refuses an ambiguous request lifecycle", () => {
  const { usage, request, report } = fixture();
  const first = randomUUID(), second = randomUUID();
  usage.startPrompt();
  request(first, "started");
  request(first, "ended");
  report(-3, 12);
  assert.equal(usage.result(), undefined);
  request(second, "started");
  request(second, "ended");
  report(5, 1);
  assert.deepEqual(usage.result(), { source: "qwen_requests", requestCount: 2,
    requests: [{ executionId: second, inputTokens: 5, outputTokens: 1 }] });
  request(randomUUID(), "started", 1, "foreign-model");
  assert.equal(usage.result(), undefined);
});
