import assert from "node:assert/strict";
import test from "node:test";
import { createApiTransport } from "../apps/mobile/src/apiTransport";
import { confirmNativeReviewSource } from "../apps/mobile/src/nativeReviewChat";
import type { ChatTransport } from "../apps/mobile/src/chatTransport";
import { nativeParityBearerRoute } from "../lib/nativeBearerGate";
import { makeReviewReportFixture } from "./fixtures/reviewAnalysisReport";

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
  const calls: string[] = [];
  const transport = createApiTransport(async path => {
    calls.push(path);
    assert.equal(path, "/api/products/mobile/capabilities");
    return Response.json({ reviewEasy: true, assistants: true, maxModels: 3, plan: "Free" });
  });
  await assert.rejects(transport.quickSummaryPreview!("chat-1"), /NATIVE_QUICK_SUMMARY_UNAVAILABLE/);
  await assert.rejects(transport.runQuickSummary!("chat-1"), /NATIVE_QUICK_SUMMARY_UNAVAILABLE/);
  assert.deepEqual(calls, ["/api/products/mobile/capabilities"]);
});

test("reading a native summary cannot start its paid execution", async () => {
  const calls: Array<{ path: string; method: string }> = [];
  const transport = createApiTransport(async (path, init) => {
    calls.push({ path, method: init?.method ?? "GET" });
    return Response.json(path === "/api/products/mobile/capabilities"
      ? { reviewAnalysis: { quickSummary: true }, reviewEasy: true, assistants: true, maxModels: 3, plan: "Free" }
      : { available: true, estimatedCredits: 0.2 });
  });
  await transport.quickSummaryPreview!("chat-1");
  assert.equal(calls.some(row => row.method === "POST"), false);
  await transport.runQuickSummary!("chat-1");
  assert.deepEqual(calls.at(-1), { path: "/api/conversations/chat-1/compare-summary", method: "POST" });
});

test("Review to Chat requires the same currently owned, saved source and result", async () => {
  const source = makeReviewReportFixture();
  let setup = { ...source.setup, storedReview: source.review };
  const transport = { reviewPreview: async () => setup } as unknown as ChatTransport;
  assert.equal(await confirmNativeReviewSource(source, transport), true);
  setup = { ...setup, source: { ...setup.source!, question: "A newer question" } };
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
