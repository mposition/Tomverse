import assert from "node:assert/strict";
import test from "node:test";

import {
  scheduleAllApprovedActions,
  scheduleDailyApprovedActions,
} from "@/components/admin/AdminMarketingPanel";
import { sendMarketingBatch } from "@/components/admin/MarketingActions";
import { adminMarketingMessages } from "@/lib/adminMessages/marketing";

/**
 * "One a day per account" beside "publish all now" (owner request 2026-11-08).
 * Executed, not read: the plan is built, confirmed and sent.
 */

// Seoul 05:00 and Brisbane 06:00 on 8 November.
const NOW = Date.parse("2026-11-07T20:00:00.000Z");

const row = (id: string, overrides: Record<string, unknown> = {}) => ({
  id,
  status: "approved",
  provider: "zernio",
  channel: "instagram",
  channelId: "ig-ko",
  accountSlug: "tomverse-ko",
  accountLocale: "ko",
  dailyCap: 1,
  weeklyCap: 4,
  approvedAt: "2026-11-07T00:00:00.000Z",
  approvalExpiresAt: "2026-11-30T00:00:00.000Z",
  envelopeDigest: id.repeat(64).slice(0, 64),
  historyVersion: 3,
  ...overrides,
});

const rows = () => [
  row("a"),
  row("b", { approvedAt: "2026-11-07T01:00:00.000Z" }),
  row("c", { approvedAt: "2026-11-07T02:00:00.000Z" }),
  row("d", { channel: "linkedin", channelId: "li-en", accountSlug: "tomverse-en", accountLocale: "en" }),
  row("m", { provider: "manual", channelId: "manual", dailyCap: null }),
  row("s", { status: "scheduled" }),
];

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

for (const locale of ["en", "ko"] as const) {
  const m = adminMarketingMessages[locale] as unknown as Record<string, string>;

  test(`${locale}: the confirmation shows the plan account by account`, () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, NOW);
    assert.equal(action.id, "schedule-daily-approved");
    assert.ok(action.label.includes("4"), action.label);
    const confirm = String(action.confirm);
    assert.ok(confirm.includes("Instagram ko: 11/8, 11/9, 11/10 (3"), confirm);
    assert.ok(confirm.includes("LinkedIn en: 11/8 (1"), confirm);
    assert.ok(!confirm.includes("{"), confirm);
    assert.equal(action.unavailable, undefined);
  });

  test(`${locale}: each post goes through its own schedule route at its planned time`, async () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, NOW);
    const requests = action.batch?.() ?? [];
    assert.deepEqual(
      requests.map((request) => [request.path, (request.body as { scheduledAt: string }).scheduledAt]),
      [
        ["/api/admin/marketing/posts/a/schedule", "2026-11-08T01:00:00.000Z"],
        ["/api/admin/marketing/posts/b/schedule", "2026-11-09T01:00:00.000Z"],
        ["/api/admin/marketing/posts/c/schedule", "2026-11-10T01:00:00.000Z"],
        ["/api/admin/marketing/posts/d/schedule", "2026-11-08T00:00:00.000Z"],
      ]
    );
    const body = requests[0].body as Record<string, unknown>;
    assert.deepEqual(body, {
      expectedEnvelopeDigest: "a".repeat(64),
      expectedHistoryVersion: 3,
      scheduledAt: "2026-11-08T01:00:00.000Z",
    });

    const seen: string[] = [];
    const result = await sendMarketingBatch(requests, async (request) => {
      seen.push(request.path);
      return json(200);
    });
    assert.equal(seen.length, 4);
    const done = action.describe?.(result);
    assert.equal(done, m.scheduleDailyDone.replace("{sent}", "4"));
  });

  // Instagram allows four a week: with 8 and 10 Nov taken, 12 Nov would be a fifth in its week.
  test(`${locale}: days the account already holds are skipped, and the week cap is kept`, () => {
    const [action] = scheduleDailyApprovedActions(
      rows(),
      [
        { channelId: "ig-ko", status: "published", slotDay: "2026-11-08", scheduledAt: null },
        { channelId: "ig-ko", status: "scheduled", slotDay: null, scheduledAt: "2026-11-10T03:00:00.000Z" },
      ],
      m,
      NOW
    );
    assert.ok(String(action.confirm).includes("Instagram ko: 11/9, 11/11, 11/15 (3"), String(action.confirm));
  });

  test(`${locale}: posts whose turn comes after their approval expires are named, not scheduled`, () => {
    const [action] = scheduleDailyApprovedActions(
      [row("a"), row("b", { approvedAt: "2026-11-07T01:00:00.000Z", approvalExpiresAt: "2026-11-08T12:00:00.000Z" })],
      [],
      m,
      NOW
    );
    const expired = m.scheduleDailyExpired.replace("{n}", "1");
    assert.ok(String(action.confirm).includes(expired));
    assert.deepEqual(action.batch?.().map((request) => request.path), ["/api/admin/marketing/posts/a/schedule"]);
    const partial = action.describe?.({ sent: 1, failed: 0, unsent: 0, requiresReauthentication: false });
    assert.ok(partial?.includes(expired), partial ?? "");
  });

  test(`${locale}: nothing that fits is drawn disabled with the reason; nothing eligible draws no button`, () => {
    const [action] = scheduleDailyApprovedActions(
      [row("a", { approvalExpiresAt: "2026-11-07T00:00:00.000Z" })],
      [],
      m,
      NOW
    );
    assert.equal(action.unavailable, m.scheduleDailyNothingFits);
    assert.deepEqual(action.batch?.(), []);
    assert.deepEqual(scheduleDailyApprovedActions([row("m", { provider: "manual" })], [], m, NOW), []);
    assert.deepEqual(scheduleDailyApprovedActions([], [], m, NOW), []);
  });

  test(`${locale}: a batch that stopped never reads as done`, () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, NOW);
    const stopped = action.describe?.({ sent: 1, failed: 0, unsent: 3, requiresReauthentication: true });
    assert.equal(stopped, m.scheduleAllStopped.replace("{sent}", "1").replace("{failed}", "0").replace("{unsent}", "3"));
  });

  test(`${locale}: the "publish all now" button is unchanged beside it`, () => {
    const [all] = scheduleAllApprovedActions(rows(), m);
    assert.equal(all.id, "schedule-all-approved");
    assert.ok(all.label.includes("4"));
  });
}
