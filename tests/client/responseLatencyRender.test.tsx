import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { ResponseLatencyEvidenceView } from "@/components/admin/ResponseLatencyEvidenceView";
import { summarizeResponseLatency, type ResponseLatencyEvidence } from "@/lib/responseLatencyCore";

const evidence: ResponseLatencyEvidence = {
  status: "available", windowDays: 7, truncated: false,
  ...summarizeResponseLatency([1000, 2000, 3000].map(firstContentMs => ({
    product: "chat", mode: "auto", modelId: null, provider: null,
    source: "client", outcome: "completed", timings: { firstContentMs, completionMs: firstContentMs + 4000 },
  }))),
};

test("current timing evidence renders independently with distinct first-content and completion percentiles", () => {
  const html = renderToStaticMarkup(createElement(ResponseLatencyEvidenceView, { evidence, current: true, onRefresh: () => {} }));
  assert.match(html, /data-testid="response-latency-current"/);
  assert.match(html, /open=""/);
  assert.match(html, /data-testid="response-latency-refresh"/);
  for (const value of ["p50", "p95", "2.00", "3.00", "6.00", "7.00", "n=3"]) assert.ok(html.includes(value), value);
});

test("historical cycle evidence stays collapsed and unavailable current evidence remains refreshable", () => {
  const historical = renderToStaticMarkup(createElement(ResponseLatencyEvidenceView, { evidence }));
  assert.doesNotMatch(historical, /open=""|response-latency-refresh/);
  const unavailable = renderToStaticMarkup(createElement(ResponseLatencyEvidenceView, {
    evidence: { status: "unavailable", windowDays: 7 }, current: true, onRefresh: () => {},
  }));
  assert.match(unavailable, /response-latency-refresh/);
  assert.doesNotMatch(unavailable, /<table/);
});
