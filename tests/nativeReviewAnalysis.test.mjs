import assert from "node:assert/strict";
import test from "node:test";
// .mjs like the other tests that import apps/mobile: the root tsc does not
// type-check apps/mobile (it needs vite/client types), and a .ts test here
// would pull those files into the root project.
import { createApiTransport } from "../apps/mobile/src/apiTransport.ts";
import { confirmNativeReviewSource } from "../apps/mobile/src/nativeReviewChat.ts";
import { nativeParityBearerRoute } from "../lib/nativeBearerGate.ts";
import { makeReviewReportFixture } from "./fixtures/reviewAnalysisReport.ts";

test("quick summary enrolls only exact GET and POST routes behind native parity", () => {
  const path = "/api/conversations/owner_chat-1/compare-summary";
  for (const method of ["GET", "POST"]) {
    assert.equal(nativeParityBearerRoute(path, method, false), false);
    assert.equal(nativeParityBearerRoute(path, method, true), true);
  }
  for (const method of ["PUT", "PATCH", "DELETE", "OPTIONS"]) assert.equal(nativeParityBearerRoute(path, method, true), false);
  for (const suffix of ["/export", "/", "-all"]) assert.equal(nativeParityBearerRoute(path + suffix, "POST", true), false);
});

test("an older server cannot receive native quick-summary executions", async () => {
  const calls = [];
  const transport = createApiTransport(async path => {
    calls.push(path);
    assert.equal(path, "/api/products/mobile/capabilities");
    return Response.json({ reviewEasy: true, assistants: true, maxModels: 3, plan: "Free" });
  });
  await assert.rejects(transport.quickSummaryPreview("chat-1"), /NATIVE_QUICK_SUMMARY_UNAVAILABLE/);
  await assert.rejects(transport.runQuickSummary("chat-1"), /NATIVE_QUICK_SUMMARY_UNAVAILABLE/);
  assert.deepEqual(calls, ["/api/products/mobile/capabilities"]);
});

test("reading a native summary cannot start its paid execution", async () => {
  const calls = [];
  const transport = createApiTransport(async (path, init) => {
    const request = typeof init === "function" ? init() : init;
    calls.push({ path, method: request?.method ?? "GET" });
    return Response.json(path === "/api/products/mobile/capabilities"
      ? { reviewAnalysis: { quickSummary: true }, reviewEasy: true, assistants: true, maxModels: 3, plan: "Free" }
      : { available: true, estimatedCredits: 0.2 });
  });
  await transport.quickSummaryPreview("chat-1");
  assert.equal(calls.some(row => row.method === "POST"), false);
  await transport.runQuickSummary("chat-1");
  assert.deepEqual(calls.at(-1), { path: "/api/conversations/chat-1/compare-summary", method: "POST" });
});

test("Review to Chat requires the same currently owned, saved source and result", async () => {
  const source = makeReviewReportFixture();
  let setup = { ...source.setup, storedReview: source.review };
  const transport = { reviewPreview: async () => setup };
  assert.equal(await confirmNativeReviewSource(source, transport), true);
  setup = { ...setup, source: { ...setup.source, question: "A newer question" } };
  assert.equal(await confirmNativeReviewSource(source, transport), false);
  for (const storedReview of [ { ...source.review, guest: true }, { ...source.review, persisted: false }, { ...source.review, id: "another-review" } ]) {
    setup = { ...source.setup, storedReview };
    assert.equal(await confirmNativeReviewSource(source, transport), false);
  }
  setup = { ...source.setup, available: false, storedReview: source.review };
  assert.equal(await confirmNativeReviewSource(source, transport), false);
  transport.reviewPreview = async () => { throw Object.assign(Error("Access revoked"), { status: 401 }); };
  await assert.rejects(confirmNativeReviewSource(source, transport), /Access revoked/);
});

import { appendNativeReviewChatDraft, sameNativeChatDraft, hasNativeChatDraft, NATIVE_CHAT_DRAFT_LIMIT } from "../apps/mobile/src/nativeReviewChat.ts";

const capabilities = { reviewAnalysis: { crossReview: true, quickSummary: true }, reviewEasy: true, assistants: true, maxModels: 3, plan: "Pro" };
function readbackTransport(answer) {
  const calls = [];
  const transport = createApiTransport(async (path, init) => {
    const request = typeof init === "function" ? init() : init ?? {};
    calls.push({ path, method: request.method ?? "GET", signal: request.signal });
    if (path === "/api/products/mobile/capabilities") return Response.json(capabilities);
    return answer(path, request);
  });
  return { transport, calls };
}
const reviewItems = [{ id: "server-item-1", reviewer: "secondary", section: "consensus", ordinal: 0 }];

test("Review→Chat readback is GET-only: no create, message, provider, reservation or upload request", async () => {
  const source = { ...makeReviewReportFixture(), reviewer: "secondary" };
  const { transport, calls } = readbackTransport(() => Response.json({ ...source.setup, storedReview: { ...source.review, reviewItems } }));
  assert.equal(await confirmNativeReviewSource(source, transport, { section: "consensus", ordinal: 0, itemId: "server-item-1" }), true);
  const quick = { kind: "quick", conversationId: source.conversationId, setup: source.setup, review: { id: "quick-1", reviewerModelId: "r", responseMap: source.review.responseMap, result: { commonConclusions: [], importantDifferences: [], modelKeyClaims: [], verificationNeeded: [] } } };
  const q = readbackTransport(() => Response.json({ available: true, cached: true, source: source.setup.source, storedSummary: quick.review }));
  assert.equal(await confirmNativeReviewSource(quick, q.transport), true);
  for (const call of [...calls, ...q.calls]) {
    assert.equal(call.method, "GET", call.path);
    assert.doesNotMatch(call.path, /\/messages|\/api\/chat|reservation|upload|\/api\/products\/chat\/conversations$/);
  }
  assert.deepEqual(calls.map(call => call.path), ["/api/products/mobile/capabilities", "/api/conversations/qa-conversation/comparison-reviews?reviewMode=balanced&includeSynthesis=false"]);
  assert.equal(q.calls.at(-1).path, "/api/conversations/qa-conversation/compare-summary?handoff=1");
});

test("a stale server item, another reviewer or an uncached Quick result refuses the offer", async () => {
  const source = { ...makeReviewReportFixture(), reviewer: "secondary" };
  for (const items of [[], [{ ...reviewItems[0], reviewer: "primary" }], [{ ...reviewItems[0], ordinal: 1 }]]) {
    const { transport } = readbackTransport(() => Response.json({ ...source.setup, storedReview: { ...source.review, reviewItems: items } }));
    assert.equal(await confirmNativeReviewSource(source, transport, { section: "consensus", ordinal: 0, itemId: "server-item-1" }), false);
  }
  const quick = { kind: "quick", conversationId: source.conversationId, setup: source.setup, review: { id: "quick-1", reviewerModelId: "r", responseMap: source.review.responseMap, result: { commonConclusions: [], importantDifferences: [], modelKeyClaims: [], verificationNeeded: [] } } };
  for (const body of [{ available: true, cached: false, source: source.setup.source, storedSummary: quick.review }, { available: true, cached: true, source: source.setup.source },
    { available: true, cached: true, source: source.setup.source, storedSummary: { ...quick.review, result: { ...quick.review.result, verificationNeeded: ["changed"] } } }]) {
    const { transport } = readbackTransport(() => Response.json(body));
    assert.equal(await confirmNativeReviewSource(quick, transport), false);
  }
});

test("lock, deletion, other owner and rate refusals reject instead of applying", async () => {
  const source = makeReviewReportFixture();
  for (const status of [403, 404, 423, 429]) {
    const { transport, calls } = readbackTransport(() => Response.json({ code: "REFUSED" }, { status }));
    await assert.rejects(confirmNativeReviewSource(source, transport), error => error.status === status || /REFUSED|MOBILE/.test(String(error.code ?? error.message)));
    assert.ok(calls.every(call => call.method === "GET"));
  }
});

test("cancelling the readback aborts the GET and never resolves as valid", async () => {
  const source = makeReviewReportFixture();
  let seen;
  const { transport } = readbackTransport((path, request) => { seen = request.signal; return new Promise((_, reject) => request.signal.addEventListener("abort", () => reject(request.signal.reason), { once: true })); });
  const controller = new AbortController();
  const pending = confirmNativeReviewSource(source, transport, undefined, controller.signal);
  await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(seen, "signal reaches the native request");
  controller.abort();
  await assert.rejects(pending, error => error.name === "AbortError");
  const late = new AbortController(); late.abort();
  await assert.rejects(confirmNativeReviewSource(source, readbackTransport(() => Response.json({ ...source.setup, storedReview: source.review })).transport, undefined, late.signal), error => error.name === "AbortError");
});

test("the new-Chat draft append keeps text, whitespace and files, and refuses rather than truncates", () => {
  assert.equal(appendNativeReviewChatDraft("", "ref"), "ref");
  assert.equal(appendNativeReviewChatDraft("  \n", "ref"), "  \n\n\nref");
  assert.equal(appendNativeReviewChatDraft("mine", "ref"), "mine\n\nref");
  assert.equal(appendNativeReviewChatDraft("x".repeat(NATIVE_CHAT_DRAFT_LIMIT - 5), "reference"), null);
  assert.equal(appendNativeReviewChatDraft("x".repeat(NATIVE_CHAT_DRAFT_LIMIT - 11), "reference").length, NATIVE_CHAT_DRAFT_LIMIT);
  const base = { owner: "account:a", generation: 2, text: "", files: [{ uploadId: "u1", name: "a.pdf" }] };
  assert.equal(hasNativeChatDraft(base), true, "an attachment-only draft is a draft");
  assert.equal(hasNativeChatDraft({ ...base, files: [] }), false);
  assert.equal(sameNativeChatDraft(base, { ...base, files: [...base.files] }), true);
  for (const changed of [{ ...base, generation: 3 }, { ...base, owner: "account:b" }, { ...base, text: " " }, { ...base, files: [] }, { ...base, files: [{ uploadId: "u2", name: "a.pdf" }] }]) assert.equal(sameNativeChatDraft(base, changed), false);
  assert.equal(sameNativeChatDraft(null, base), false);
});
