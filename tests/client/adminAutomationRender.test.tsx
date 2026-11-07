import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminReportsPanel } from "@/components/admin/AdminReportsPanel";
import { AdminScheduledJobsView } from "@/components/admin/AdminScheduledJobsPanel";
import { AdminWebhookView } from "@/components/admin/AdminWebhookPanel";

/**
 * Automation, rendered: scheduled jobs, webhooks and reports. The views are
 * hook-free apart from the message context, so they are called with a read, a
 * failed read, or no rows.
 */

const job = (over: Record<string, unknown> = {}) => ({
  key: "retention_cleanup",
  name: "Retention cleanup",
  schedule: "Daily at 03:30",
  status: "succeeded",
  delayed: false,
  nextScheduledAt: "2026-11-08T03:30:00.000Z",
  lastRunAt: "2026-11-07T03:30:00.000Z",
  lastSuccessAt: "2026-11-07T03:30:10.000Z",
  lastFailureAt: null,
  lastError: null,
  lastProcessedCount: 1204,
  consecutiveFailures: 0,
  ...over,
});

const failing = job({
  key: "provider_usage_sync",
  name: "Provider usage sync",
  schedule: "Every 6 hours",
  status: "failed",
  lastFailureAt: "2026-11-06T10:00:00.000Z",
  lastError: "OpenAI answered 429",
  consecutiveFailures: 3,
});

const jobs = (over: Partial<Parameters<typeof AdminScheduledJobsView>[0]> = {}) =>
  renderToStaticMarkup(
    <AdminScheduledJobsView
      rows={[job(), failing]}
      loading={false}
      error={null}
      onRefresh={() => {}}
      {...over}
    />
  );

test("each job is a row with its last run in AEST and a status chip", () => {
  const html = jobs();
  assert.match(html, /<table/);
  assert.match(html, /2026-11-07 13:30 AEST/);
  assert.match(html, /data-tone="ok"[^>]*>Succeeded</);
  assert.match(html, /data-tone="bad"[^>]*>Failed</);
  assert.doesNotMatch(html, /UTC|GMT/);
});

test("a job that keeps failing says so on its row and gets an explanation card", () => {
  const html = jobs();
  assert.match(html, /3 in a row failed/);
  assert.match(html, /data-testid="scheduled-job-failure"/);
  assert.match(html, /Provider usage sync failed 3 times in a row/);
  // The SRE avatar is drawn for it, and the raw error stays closed.
  assert.match(html, /crispEdges/);
  assert.match(html, /<details[^>]*>[\s\S]*OpenAI answered 429/);
});

test("a job that never failed has no explanation card", () => {
  const html = jobs({ rows: [job()] });
  assert.doesNotMatch(html, /scheduled-job-failure/);
});

test("a job that has never run is idle, not healthy", () => {
  const html = jobs({
    rows: [job({ status: "not_run", lastRunAt: null, lastSuccessAt: null, lastProcessedCount: null })],
  });
  assert.match(html, /data-tone="idle"[^>]*>Not run yet</);
  assert.match(html, /Never/);
});

test("a failed read is an alert with a retry, never an empty table", () => {
  const html = jobs({ rows: [], error: "Could not load scheduled jobs." });
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load scheduled jobs\./);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /<table/);
});

const hook = (over: Record<string, unknown> = {}) => ({
  id: "wh-1",
  stripeEventId: "evt_failed_checkout",
  eventType: "checkout.session.completed",
  status: "failed",
  error: "No plan matched",
  receivedAt: "2026-11-07T04:00:00.000Z",
  processedAt: null,
  replayedAt: null,
  ...over,
});

const hooks = (over: Partial<Parameters<typeof AdminWebhookView>[0]> = {}) =>
  renderToStaticMarkup(
    <AdminWebhookView
      rows={[hook(), hook({ id: "wh-2", stripeEventId: "evt_ok", status: "processed", error: null })]}
      loading={false}
      error={null}
      reprocessingId={null}
      onRefresh={() => {}}
      onReprocess={() => {}}
      {...over}
    />
  );

test("webhook counts lead, and a failed event offers Reprocess", () => {
  const html = hooks();
  assert.match(html, /Received/);
  assert.match(html, /Processed/);
  assert.match(html, /Each one can be reprocessed below/);
  assert.match(html, /evt_failed_checkout/);
  assert.match(html, /No plan matched/);
  assert.match(html, />Reprocess</);
  // Only the failed one has the button.
  assert.equal((html.match(/>Reprocess</g) ?? []).length >= 1, true);
  assert.doesNotMatch(html.slice(html.indexOf("evt_ok")), /data-step-up/);
});

test("webhook counts that could not be read say Unavailable, not zero", () => {
  const html = hooks({ rows: null, error: "Could not load webhook logs." });
  assert.match(html, /data-unread="true"/);
  assert.match(html, /role="alert"/);
  assert.doesNotMatch(html, /<table/);
});

test("before the first read there is a skeleton and no counts", () => {
  const html = hooks({ rows: null, loading: true });
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /data-unread/);
});

test("no events yet is an empty state, not a blank table", () => {
  const html = hooks({ rows: [] });
  assert.match(html, /No Stripe webhook events recorded yet\./);
});

test("the reports tab opens with an empty state and a generate button", () => {
  const html = renderToStaticMarkup(<AdminReportsPanel />);
  assert.match(html, /Operations report/);
  assert.match(html, /Generate report/);
  assert.match(html, /No report yet in this visit\./);
});
