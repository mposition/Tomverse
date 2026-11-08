import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AdminCampaignScheduleView } from "@/components/admin/AdminCampaignSchedulePanel";
import { AdminCampaignNewTab } from "@/components/admin/AdminCampaignComposer";
import { AdminEmailCampaignsView } from "@/components/admin/AdminEmailCampaignsPanel";
import type { AdminCampaignRow, AdminCampaignWaveRow } from "@/lib/adminEmailCampaigns";
import { adminMessagesFor } from "@/lib/adminLocale";
import { adminEmailCampaignsMessages } from "@/lib/adminMessages/emailCampaigns";

const en = adminMessagesFor(adminEmailCampaignsMessages, "en");
const ko = adminMessagesFor(adminEmailCampaignsMessages, "ko");

const campaign = (overrides: Partial<AdminCampaignRow> = {}): AdminCampaignRow => ({
  id: "camp1",
  category: "other",
  templateKey: "product_announcement",
  status: "pending_approval",
  triggerMode: "manual",
  locales: ["ko", "en"],
  targetModelId: null,
  replacementModelId: null,
  claimsAutomaticTransition: false,
  estimatedRecipients: 1284,
  effectiveAt: null,
  timezoneLabel: null,
  scheduledAt: null,
  approvedAt: null,
  createdByEmail: "owner@example.com",
  createdAt: new Date("2026-11-03T01:00:00Z"),
  waveCount: 2,
  overdueWaves: 0,
  nextWaveAt: null,
  ...overrides,
});

const wave = (overrides: Partial<AdminCampaignWaveRow> = {}): AdminCampaignWaveRow => ({
  id: "wave1",
  campaignId: "camp1",
  campaignTemplateKey: "product_announcement",
  campaignStatus: "approved",
  triggerMode: "approved_schedule",
  kind: "launch",
  sequence: 1,
  status: "pending",
  scheduledAt: new Date("2026-11-03T01:00:00Z"),
  dryRun: false,
  recipientCap: null,
  expandedCount: 0,
  overdue: false,
  ...overrides,
});

test("the campaign list shows recipients and a status chip, and no rate it cannot read", () => {
  const html = renderToStaticMarkup(
    <AdminEmailCampaignsView m={en} limit={100} rows={[campaign(), campaign({ id: "c2", estimatedRecipients: null, status: "halted" })]} />
  );
  assert.equal((html.match(/data-testid="admin-campaign-row"/g) ?? []).length, 2);
  assert.match(html, /1,284 people/);
  assert.match(html, /Not counted yet/);
  assert.match(html, /data-tone="warn"[^>]*>Waiting for approval</);
  assert.match(html, /data-tone="bad"[^>]*>Stopped</);
  assert.match(html, /Showing the newest 100\./);
  assert.match(html, /href="\/admin\/email-campaigns\/camp1"/);
  // Nothing the list loads records opens or clicks, so there is no such column.
  assert.doesNotMatch(html, /Open rate|Opened|Clicks/i);
  // The new-campaign entry is a link to its own section, not an open composer.
  assert.match(html, /href="\/admin\/email-campaigns\?tab=new"/);
  assert.doesNotMatch(html, /<iframe|<textarea/);
});

test("an overdue wave is flagged on its campaign row", () => {
  const html = renderToStaticMarkup(
    <AdminEmailCampaignsView m={en} limit={100} rows={[campaign({ overdueWaves: 1 })]} />
  );
  assert.match(html, /data-testid="admin-campaign-overdue"[^>]*>.*1 overdue/);
});

test("an empty list says there are none, and a failed read says it failed", () => {
  const empty = renderToStaticMarkup(<AdminEmailCampaignsView m={en} limit={100} rows={[]} />);
  assert.match(empty, /No campaigns have been drafted\./);
  assert.doesNotMatch(empty, /role="alert"/);
  const failed = renderToStaticMarkup(<AdminEmailCampaignsView m={ko} limit={100} rows={null} />);
  assert.match(failed, /role="alert"/);
  assert.match(failed, /캠페인 목록을 읽지 못했어요\./);
  assert.doesNotMatch(failed, /만든 캠페인이 아직 없어요/);
});

test("the schedule puts the overdue wave first and keeps the incident code in technical details", () => {
  const html = renderToStaticMarkup(
    <AdminCampaignScheduleView
      m={en}
      limit={100}
      rows={[wave({ id: "w1", overdue: true }), wave({ id: "w2", scheduledAt: new Date("2026-11-20T01:00:00Z") })]}
    />
  );
  assert.equal((html.match(/data-testid="admin-campaign-wave-overdue"/g) ?? []).length, 1);
  assert.equal((html.match(/data-testid="admin-campaign-wave-upcoming"/g) ?? []).length, 1);
  assert.ok(html.indexOf("admin-campaign-wave-overdue") < html.indexOf("admin-campaign-wave-upcoming"));
  assert.match(html, /<details[^>]*>[\s\S]*CAMPAIGN_WAVE_REFUSED_AT_SCHEDULE/);
  assert.doesNotMatch(html, /<details[^>]*open/);
  assert.match(html, /AEST/);
});

test("a clear schedule says so, and a failed read is not a clear schedule", () => {
  const clear = renderToStaticMarkup(<AdminCampaignScheduleView m={en} limit={100} rows={[]} />);
  assert.match(clear, /data-testid="admin-campaign-schedule-clear"/);
  const failed = renderToStaticMarkup(<AdminCampaignScheduleView m={en} limit={100} rows={null} />);
  assert.match(failed, /role="alert"/);
  assert.doesNotMatch(failed, /admin-campaign-schedule-clear/);
});

test("the new-campaign section shows one composer at a time and keeps the other mounted", () => {
  const html = renderToStaticMarkup(
    <AdminCampaignNewTab
      product={<p data-testid="product-composer">product</p>}
      notice={<p data-testid="notice-composer">notice</p>}
    />
  );
  assert.match(html, /<div hidden="">\s*<p data-testid="notice-composer"/);
  assert.doesNotMatch(html, /<div hidden="">\s*<p data-testid="product-composer"/);
  assert.match(html, /aria-pressed="true"[^>]*data-testid="admin-campaign-new-product"|data-testid="admin-campaign-new-product"[^>]*aria-pressed="true"/);
});
