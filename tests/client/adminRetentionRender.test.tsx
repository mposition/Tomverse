import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import { AdminRetentionOverview, type RetentionItem } from "@/components/admin/AdminRetentionPanel";

const item = (overrides: Partial<RetentionItem>): RetentionItem => ({
  key: "providerChecks",
  label: "Provider checks",
  policy: "Delete provider check records older than 30 days.",
  action: "delete",
  staleCount: 0,
  oldestAt: "2026-10-01T00:00:00Z",
  ...overrides,
});

test("each data type shows its rule, what is waiting and its oldest record in AEST", () => {
  const html = renderToStaticMarkup(
    <AdminRetentionOverview items={[item({ staleCount: 0 }), item({ key: "audit", label: "Audit log", action: "keep", policy: "Kept for seven years.", staleCount: 3 })]} />
  );
  assert.match(html, />Provider checks</);
  assert.match(html, /Delete provider check records older than 30 days\./);
  assert.match(html, /2026-10-01 10:00 AEST/);
  // A kept policy's number is history, labelled as such, and is not a cleanup count.
  assert.match(html, /Beyond the floor/);
  assert.match(html, />Deleted</);
  assert.match(html, />Kept</);
});

test("nothing waiting means no red notice", () => {
  const html = renderToStaticMarkup(<AdminRetentionOverview items={[item({ staleCount: 0 })]} />);
  assert.doesNotMatch(html, /admin-retention-pending-deletion/);
});

test("records past their window raise a red notice that counts only what a cleanup would remove", () => {
  const html = renderToStaticMarkup(
    <AdminRetentionOverview
      items={[
        item({ staleCount: 1204 }),
        item({ key: "notifications", label: "Alert logs", staleCount: 6, action: "clear" }),
        // History and settled rows are not deletions.
        item({ key: "audit", label: "Audit log", action: "keep", staleCount: 900 }),
        item({ key: "credit", label: "Credit holds", action: "refund", staleCount: 50 }),
      ]}
    />
  );
  assert.match(html, /data-testid="admin-retention-pending-deletion"/);
  assert.match(html, /1,210 records in 2 kinds of data are past their window/);
  assert.match(html, /that cannot be undone/);
  assert.match(html, /Provider checks · Alert logs/);
});

test("a failed read is an alert with a retry, never an empty table", () => {
  const html = renderToStaticMarkup(<AdminRetentionOverview items={null} failed onRetry={() => {}} />);
  assert.match(html, /role="alert"/);
  assert.match(html, /Could not load the retention status/);
  assert.match(html, /Try again/);
  assert.doesNotMatch(html, /<table/);
});

test("before the first read it shows a loading state, not an empty table", () => {
  const html = renderToStaticMarkup(<AdminRetentionOverview items={null} loading />);
  assert.match(html, /role="status"/);
  assert.doesNotMatch(html, /<table/);
});
