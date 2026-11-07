import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminAddressRevealProvider } from "@/components/admin/AdminAddressReveal";
import { AdminEmailDeliveriesView } from "@/components/admin/AdminEmailDeliveriesPanel";
import { AdminEmailSuppressionsView } from "@/components/admin/AdminEmailSuppressionsPanel";
import type { AdminEmailDeliveryRow, AdminSuppressionRow } from "@/lib/adminEmailDeliveries";
import { parseDeliveryFilters } from "@/lib/adminEmailDeliveryFilters";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminEmailDeliveryMessages } from "@/lib/adminMessages/emailDelivery";

const en = adminMessagesFor(adminEmailDeliveryMessages, "en");
const ko = adminMessagesFor(adminEmailDeliveryMessages, "ko");

const counts = {
  abandoned: 1,
  failed: 0,
  bounced: 9,
  complained: 2,
  pending: 0,
  sent: 100,
  delivered: 880,
  suppressed: 7,
  skipped: 0,
};

const delivery = (overrides: Partial<AdminEmailDeliveryRow> = {}) =>
  ({
    id: "d1",
    status: "bounced",
    lane: "standard",
    attempts: 1,
    lastErrorKind: "address_unknown",
    skipReason: null,
    deferReason: null,
    nextAttemptAt: null,
    renderedSubject: "Your sign-in link",
    createdAt: new Date("2026-11-03T04:00:00Z"),
    jurisdictionCountry: "AU",
    language: "en",
    emailAddressMasked: "us•••@example.com",
    templateVersion: {
      classification: "transactional",
      version: 3,
      template: { key: "login_link" },
    },
    ...overrides,
  }) as unknown as AdminEmailDeliveryRow;

const render = (node: React.ReactNode) =>
  renderToStaticMarkup(<AdminAddressRevealProvider>{node}</AdminAddressRevealProvider>);

test("the number cards come from the status counts and an unread count is Unavailable", () => {
  const filters = parseDeliveryFilters({});
  const html = render(
    <AdminEmailDeliveriesView m={en} rows={[delivery()]} filters={filters} statusCounts={counts} nextCursor={null} mayRevealAddresses />
  );
  // Handed off = sent + delivered + bounced + complained = 991.
  assert.match(html, />991</);
  assert.match(html, />88\.8%</);
  assert.match(html, /880 of 991/);
  assert.match(html, /2 marked as spam/);
  const unread = render(
    <AdminEmailDeliveriesView m={en} rows={[delivery()]} filters={filters} statusCounts={null} nextCursor={null} mayRevealAddresses />
  );
  assert.equal((unread.match(/data-unread="true"/g) ?? []).length, 4);
  assert.doesNotMatch(unread, /hidden in other statuses|are not shown/);
});

test("the filter chips are links that keep the other filter, and the default says what it excludes", () => {
  const html = render(
    <AdminEmailDeliveriesView
      m={en}
      rows={[delivery()]}
      filters={parseDeliveryFilters({ classification: "legal" })}
      statusCounts={counts}
      nextCursor="cursor1"
      mayRevealAddresses
    />
  );
  assert.match(html, /data-testid="email-delivery-filter-undelivered"/);
  assert.match(html, /href="\/admin\/email-delivery\?tab=deliveries&amp;status=sent&amp;classification=legal"/);
  assert.match(html, /href="\/admin\/email-delivery\?tab=deliveries&amp;status=abandoned,failed,bounced,complained&amp;classification=marketing"/);
  assert.match(html, /aria-current="true"[^>]*data-testid="email-delivery-kind-legal"|data-testid="email-delivery-kind-legal"[^>]*aria-current="true"/);
  assert.match(html, /data-testid="email-delivery-scope"[^>]*>Showing 1 row in abandoned, failed, bounced, complained\./);
  assert.match(html, /880 rows in other statuses|rows in other statuses are not shown/);
  assert.match(html, /data-testid="email-delivery-next"[^>]*href="[^"]*&amp;cursor=cursor1"|href="[^"]*cursor=cursor1"[^>]*data-testid="email-delivery-next"/);
});

test("a delivery row shows the masked address, the kind in words and the status chip", () => {
  const html = render(
    <AdminEmailDeliveriesView m={ko} rows={[delivery()]} filters={parseDeliveryFilters({})} statusCounts={counts} nextCursor={null} mayRevealAddresses={false} />
  );
  assert.equal((html.match(/data-testid="email-delivery-row"/g) ?? []).length, 1);
  assert.match(html, /•••@example\.com/);
  assert.match(html, /로그인·영수증/);
  assert.match(html, /data-tone="warn"[^>]*>반송</);
  assert.match(html, /AEST/);
  assert.match(html, /data-testid="admin-reveal-not-permitted"/);
});

test("an empty log says so and a failed read is an error, not an empty log", () => {
  const filters = parseDeliveryFilters({});
  const empty = render(
    <AdminEmailDeliveriesView m={en} rows={[]} filters={filters} statusCounts={counts} nextCursor={null} mayRevealAddresses />
  );
  assert.match(empty, /data-testid="email-delivery-empty"/);
  const failed = render(
    <AdminEmailDeliveriesView m={en} rows={null} filters={filters} statusCounts={counts} nextCursor={null} mayRevealAddresses />
  );
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /email-delivery-empty|email-delivery-scope/);
});

const suppression = (): AdminSuppressionRow =>
  ({
    id: "s1",
    emailAddressMasked: "ol•••@example.com",
    scope: "global",
    purposeKey: "",
    causeSetDigest: "digest",
    causes: [
      {
        id: "c1",
        reason: "hard_bounce",
        source: "resend_webhook",
        sourceStream: "x",
        sourceClassification: "transactional",
        occurredAt: new Date("2026-11-01T00:00:00Z"),
        expiresAt: null,
        createdAt: new Date("2026-11-01T00:00:00Z"),
      },
      {
        id: "c2",
        reason: "unsubscribe",
        source: "link",
        sourceStream: "y",
        sourceClassification: null,
        occurredAt: new Date("2026-10-01T00:00:00Z"),
        expiresAt: new Date("2026-12-01T00:00:00Z"),
        createdAt: new Date("2026-10-01T00:00:00Z"),
      },
    ],
  }) as unknown as AdminSuppressionRow;

test("one suppressed address is one row listing every active reason with its own source and date", () => {
  const html = render(
    <AdminEmailSuppressionsView m={en} rows={[suppression()]} mayRevealAddresses />
  );
  assert.equal((html.match(/data-testid="email-suppression-row"/g) ?? []).length, 1);
  assert.equal((html.match(/data-testid="email-suppression-reason"/g) ?? []).length, 2);
  assert.match(html, /Address does not exist/);
  assert.match(html, /Unsubscribed/);
  assert.match(html, /never expires/);
  assert.match(html, /until .*AEST/);
  assert.match(html, /data-testid="email-suppression-provider-notice"[^>]*>[^<]*not the provider/);
  assert.match(html, /data-testid="admin-reveal-addresses"/);
});

test("an empty suppression list says so and a failed read is an error", () => {
  assert.match(
    render(<AdminEmailSuppressionsView m={en} rows={[]} mayRevealAddresses />),
    /data-testid="email-suppression-empty"/
  );
  const failed = render(<AdminEmailSuppressionsView m={ko} rows={null} mayRevealAddresses />);
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /email-suppression-empty|admin-reveal-addresses/);
});
