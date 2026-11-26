import assert from "node:assert/strict";
import test from "node:test";
import { chatExtrasInput } from "../src/chat-extras-contract";
import { createHash } from "node:crypto";
import { reviewExportFile, runChatExtras } from "../src/host/chat-extras";
import { compareFailureText } from "../src/renderer/compare-failure";
import type { CompareSummaryOutcome } from "../src/chat-extras-contract";
import { failureText } from "../src/renderer/AnswerFeedback";
import { webLocales } from "../src/renderer/answer-locales";

type Call = { path: string; method?: string; body?: object };
function fake(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  return { calls, send: async (call: Call) => { calls.push(call); return respond(call); } };
}
const feedback = { action: "feedback", product: "chat", messageId: "msg_1", message: "  The second paragraph is wrong.  ", modelId: "gpt-5" };

test("an answer report is posted as the web does, tied to the saved answer, with only typed fields", async () => {
  const api = fake(() => Response.json({ success: true, feedbackId: "cm1234abcdefgh", reference: "ABCD1234", emailUpdatesEnabled: true }));
  const outcome = await runChatExtras({ ...feedback, emailUpdates: true }, api);
  assert.deepEqual(outcome, { ok: true, reference: "ABCD1234", emailUpdatesEnabled: true });
  assert.equal(api.calls.length, 1);
  assert.equal(api.calls[0].path, "/api/feedback");
  assert.equal(api.calls[0].method, "POST");
  assert.deepEqual(api.calls[0].body, {
    type: "bug", message: "The second paragraph is wrong.", messageId: "msg_1", answerSignal: "needs_improvement",
    modelId: "gpt-5", path: "/desktop/chat", emailUpdates: true,
  });
});

test("a refused or unreachable report maps to the same failure classes the web shows", async () => {
  for (const [status, failure] of [[400, "invalid"], [429, "rateLimited"], [500, "server"], [413, "tooLarge"], [401, "verification"]] as const) {
    const outcome = await runChatExtras(feedback, fake(() => Response.json({ error: "x" }, { status })));
    assert.deepEqual(outcome, { ok: false, failure });
  }
  const unreachable = await runChatExtras(feedback, { send: async () => { throw new Error("offline"); } });
  assert.deepEqual(unreachable, { ok: false, failure: "network" });
});

test("the extras input refuses routes, short reports and unknown fields", () => {
  assert.equal(chatExtrasInput.safeParse({ ...feedback, path: "/api/admin" }).success, false);
  assert.equal(chatExtrasInput.safeParse({ ...feedback, message: "bad" }).success, false);
  assert.equal(chatExtrasInput.safeParse({ ...feedback, messageId: "../x" }).success, false);
  assert.equal(chatExtrasInput.safeParse({ action: "unknown" }).success, false);
});

test("every supported language has a sentence for each report failure", () => {
  for (const language of Object.keys(webLocales) as (keyof typeof webLocales)[]) {
    for (const failure of ["invalid", "verification", "tooLarge", "rateLimited", "server", "network", "unknown"] as const) {
      assert.ok(failureText(webLocales[language].feedback, failure).length > 0, `${language}:${failure}`);
    }
  }
});

const quick = {
  id: "q1", reviewerModelId: "gpt-5", usageCredits: 3, cached: false,
  result: {
    commonConclusions: [{ text: "Both agree.", verified: true, citations: [{ responseId: "A", quote: "agree", verified: true }] }],
    importantDifferences: [], modelKeyClaims: [{ responseId: "A", claims: [{ claim: "Claim", quote: "q", verified: false }] }],
    verificationNeeded: ["Check the date"], confidence: "high", groundingStats: { totalCitations: 2, verifiedCitations: 1 },
  },
  responseMap: [{ responseId: "A", messageId: "m1", modelId: "gpt-5", modelName: "GPT" }],
};

test("the quick summary is read with a free estimate first and posted only on request", async () => {
  const api = fake((call) => call.method === "POST" ? Response.json(quick) : Response.json({ available: true, estimatedCredits: 3, cached: false }));
  assert.deepEqual(await runChatExtras({ action: "compareEstimate", conversationId: "conv_1" }, api), { ok: true, available: true, estimatedCredits: 3, cached: false });
  const summary = await runChatExtras({ action: "compareSummary", conversationId: "conv_1" }, api) as CompareSummaryOutcome;
  assert.equal(summary.ok && summary.summary.result.commonConclusions[0].text, "Both agree.");
  assert.deepEqual(api.calls.map(({ path, method }) => [path, method ?? "GET"]),
    [["/api/conversations/conv_1/compare-summary", "GET"], ["/api/conversations/conv_1/compare-summary", "POST"]]);
});

test("a refused quick summary keeps only the server's error code", async () => {
  const refused = await runChatExtras({ action: "compareSummary", conversationId: "conv_1" },
    fake(() => Response.json({ error: "private words", code: "API_RATE_LIMITED" }, { status: 429 })));
  assert.deepEqual(refused, { ok: false, code: "API_RATE_LIMITED" });
  const malformed = await runChatExtras({ action: "compareSummary", conversationId: "conv_1" }, fake(() => Response.json({ id: "x" })));
  assert.deepEqual(malformed, { ok: false, code: null });
  for (const language of Object.keys(webLocales) as (keyof typeof webLocales)[]) {
    for (const code of ["COMPARISON_RESPONSES_REQUIRED", "API_RATE_LIMITED", "QUICK_COMPARISON_REVIEWER_UNAVAILABLE", "QUICK_COMPARISON_FAILED", null]) {
      assert.ok(compareFailureText(webLocales[language].chat, code).length > 0);
    }
  }
});

test("a web check and an item verdict use the web routes, and a repeated verdict is withdrawn with DELETE", async () => {
  const api = fake((call) => call.path.endsWith("/verify-item")
    ? Response.json({ status: "supported", summary: "Matches.", usageCredits: 1, reviewerModelId: "sonar" }) : Response.json({ ok: true }));
  assert.deepEqual(await runChatExtras({ action: "verifyItem", conversationId: "conv_1", item: " Check the date " }, api),
    { ok: true, status: "supported", summary: "Matches.", usageCredits: 1 });
  assert.deepEqual(api.calls[0], { path: "/api/conversations/conv_1/comparison-reviews/verify-item", method: "POST", body: { item: "Check the date" } });
  await runChatExtras({ action: "itemFeedback", conversationId: "conv_1", reviewId: "r1", reviewItemId: "i1", verdict: "incorrect" }, api);
  await runChatExtras({ action: "itemFeedback", conversationId: "conv_1", reviewId: "r1", reviewItemId: "i1", verdict: null }, api);
  assert.deepEqual(api.calls.slice(1), [
    { path: "/api/conversations/conv_1/comparison-reviews/item-feedback", method: "PUT", body: { reviewId: "r1", reviewItemId: "i1", verdict: "incorrect" } },
    { path: "/api/conversations/conv_1/comparison-reviews/item-feedback", method: "DELETE", body: { reviewId: "r1", reviewItemId: "i1" } },
  ]);
  assert.equal(chatExtrasInput.safeParse({ action: "itemFeedback", conversationId: "conv_1", reviewId: "r", reviewItemId: "i", verdict: "bad" }).success, false);
  assert.deepEqual(await runChatExtras({ action: "verifyItem", conversationId: "conv_1", item: "x" }, fake(() => new Response("{}", { status: 503 }))), { ok: false });
});

test("an exported analysis is saved only when its declared size and digest match the bytes", async () => {
  const analysis = { kind: "review", reviewId: "r1", reviewMode: "balanced", includeSynthesis: false, reviewer: "primary", fingerprint: "a".repeat(64), language: "ko" };
  const body = Buffer.from("analysis report");
  const headers = (bytes: Buffer, digest = createHash("sha256").update(bytes).digest("hex")) =>
    ({ "x-export-bytes": String(bytes.byteLength), "x-export-sha256": digest });
  const api = fake(() => new Response(body, { headers: headers(body) }));
  const file = await reviewExportFile({ conversationId: "conv_1", format: "md", analysis }, api);
  assert.equal(Buffer.from(file.bytes).toString(), "analysis report");
  assert.equal(file.suggestedName, "answer-analysis.md");
  assert.deepEqual(api.calls[0], { path: "/api/conversations/conv_1/analysis/export", method: "POST", body: { analysis, format: "md" } });
  await assert.rejects(reviewExportFile({ conversationId: "conv_1", format: "md", analysis },
    fake(() => new Response(body, { headers: headers(body, "b".repeat(64)) }))), /verification/);
  await assert.rejects(reviewExportFile({ conversationId: "conv_1", format: "md", analysis },
    fake(() => new Response(body, { headers: { ...headers(body), "x-export-bytes": "3" } }))), /verification/);
  await assert.rejects(reviewExportFile({ conversationId: "conv_1", format: "md", analysis }, fake(() => new Response("{}", { status: 403 }))), /could not export/);
  await assert.rejects(reviewExportFile({ conversationId: "conv_1", format: "exe", analysis }, api));
});
