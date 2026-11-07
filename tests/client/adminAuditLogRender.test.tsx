import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  AdminAuditIntegrityCardView,
  AdminAuditIntegrityPanel,
} from "@/components/admin/AdminAuditIntegrityPanel";
import { AdminAuditTable, type AdminAuditRow } from "@/components/admin/AdminAuditPanel";

const row = (overrides: Partial<AdminAuditRow>): AdminAuditRow => ({
  id: "audit-1",
  actorUserId: "user-1",
  actorEmail: "owner@example.test",
  action: "app_settings.update",
  targetType: "platform",
  targetId: "settings",
  summary: "Turned memory on",
  ipAddress: "203.0.113.4",
  userAgent: "test",
  createdAt: "2026-11-06T14:20:00Z",
  ...overrides,
});

test("the records table says who, what, target and when, in AEST, with a way to open each entry", () => {
  const html = renderToStaticMarkup(
    <AdminAuditTable
      rows={[row({}), row({ id: "audit-2", action: "user.delete", actorEmail: null, summary: "Deleted a user" })]}
      onOpenDetail={() => {}}
    />
  );
  for (const heading of ["Who", "What", "Target", "When", "Details"]) {
    assert.match(html, new RegExp(`>${heading}</th>`));
  }
  // 14:20 UTC is 00:20 the next morning in Brisbane.
  assert.match(html, /2026-11-07 00:20 AEST/);
  assert.doesNotMatch(html, /UTC/);
  // The summary sits in a cell of its own.
  assert.match(html, /<td[^>]*>[^<]*<span[^>]*>Turned memory on<\/span><\/td>/);
  // A delete is drawn as a failure-coloured chip; an ordinary change is not.
  assert.match(html, /data-tone="bad"[^>]*>user\.delete</);
  assert.match(html, /data-tone="info"[^>]*>app_settings\.update</);
  // An actor with no address is named as unknown rather than left blank.
  assert.match(html, /Unknown admin/);
  assert.match(html, /aria-label="Details: user\.delete"/);
});

test("no matching rows read as an empty state, not an empty table", () => {
  const html = renderToStaticMarkup(<AdminAuditTable rows={[]} onOpenDetail={() => {}} />);
  assert.match(html, /No audit events match the current filters\./);
  assert.doesNotMatch(html, /<table/);
});

test("the integrity card starts unread, and never claims the chain is intact before a check", () => {
  const html = renderToStaticMarkup(<AdminAuditIntegrityCardView state="idle" onCheck={() => {}} />);
  assert.match(html, /data-outcome="idle"/);
  assert.match(html, /The chain has not been checked yet/);
  assert.match(html, /border-dashed/);
  assert.doesNotMatch(html, /intact/);
  assert.match(html, />Check now</);
});

test("each checked state names itself, with the count and the AEST time of the check", () => {
  const ok = renderToStaticMarkup(
    <AdminAuditIntegrityCardView state="ok" checked="12,480" checkedAt="2026-11-07 06:00 AEST" onCheck={() => {}} />
  );
  assert.match(ok, /data-outcome="ok"/);
  assert.match(ok, /The record chain is intact/);
  assert.match(ok, /12,480 records were checked from the start to the end\. Last checked 2026-11-07 06:00 AEST\./);

  const bad = renderToStaticMarkup(
    <AdminAuditIntegrityCardView state="bad" unverified="9" checkedAt="2026-11-07 06:00 AEST" onCheck={() => {}} />
  );
  assert.match(bad, /The record chain has a problem/);
  assert.match(bad, /9 records did not verify\./);
  // A finding sends the operator to the full check, where the rows can be diagnosed.
  assert.match(bad, /href="\/admin\/audit\?tab=integrity"/);

  const truncated = renderToStaticMarkup(
    <AdminAuditIntegrityCardView state="truncated" checked="100" checkedAt="x" onCheck={() => {}} />
  );
  assert.match(truncated, /The check stopped before the newest records/);
  assert.doesNotMatch(truncated, /is intact/);

  const failed = renderToStaticMarkup(<AdminAuditIntegrityCardView state="failed" onCheck={() => {}} />);
  assert.match(failed, /The check could not run/);
});

test("a running check disables the button and says so", () => {
  const html = renderToStaticMarkup(<AdminAuditIntegrityCardView state="idle" running onCheck={() => {}} />);
  assert.match(html, /<button[^>]*disabled=""[^>]*>[^]*Checking\.\.\./);
});

test("the integrity tab opens unverified, with its button and no verdict", () => {
  const html = renderToStaticMarkup(<AdminAuditIntegrityPanel />);
  assert.match(html, /<h2[^>]*>Admin audit integrity<\/h2>/);
  assert.match(html, /Verify chain/);
  assert.match(html, /Not verified in this session/);
  assert.doesNotMatch(html, /admin-audit-integrity-result/);
});
