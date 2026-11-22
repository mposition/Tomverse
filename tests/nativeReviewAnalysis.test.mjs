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
