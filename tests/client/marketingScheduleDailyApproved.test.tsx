import assert from "node:assert/strict";
import test from "node:test";

import {
  scheduleAllApprovedActions,
  scheduleDailyApprovedActions,
} from "@/components/admin/AdminMarketingPanel";
import {
  marketingBatchToSend,
  sendMarketingBatch,
  type MarketingAction,
} from "@/components/admin/MarketingActions";
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
  postingCaps: { daily: 1, weekly: 4 },
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
  row("m", { provider: "manual", channelId: "manual", postingCaps: null }),
  row("s", { status: "scheduled" }),
];

/** The question the person is asked, built when the button is pressed. */
const asked = (action: MarketingAction) =>
  typeof action.confirm === "function" ? action.confirm({}) : String(action.confirm);

/** The scheduledAt of each request a press would send. */
const timesOf = (sent: Awaited<ReturnType<typeof marketingBatchToSend>>) =>
  sent !== null && !("refused" in sent)
    ? sent.map((request) => (request.body as { scheduledAt: string }).scheduledAt)
    : sent;

const json = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

for (const locale of ["en", "ko"] as const) {
  const m = adminMarketingMessages[locale] as unknown as Record<string, string>;

  test(`${locale}: the confirmation shows the plan account by account`, () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => NOW);
    assert.equal(action.id, "schedule-daily-approved");
    assert.ok(action.label.includes("4"), action.label);
    const confirm = asked(action);
    assert.ok(confirm.includes("Instagram ko: 11/8, 11/9, 11/10 (3"), confirm);
    assert.ok(confirm.includes("LinkedIn en: 11/8 (1"), confirm);
    assert.ok(!confirm.includes("{"), confirm);
    assert.equal(action.unavailable, undefined);
  });

  test(`${locale}: each post goes through its own schedule route at its planned time`, async () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => NOW);
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
      () => NOW
    );
    assert.ok(asked(action).includes("Instagram ko: 11/9, 11/11, 11/15 (3"), asked(action));
  });

  test(`${locale}: posts whose turn comes after their approval expires are named, not scheduled`, () => {
    const [action] = scheduleDailyApprovedActions(
      [row("a"), row("b", { approvedAt: "2026-11-07T01:00:00.000Z", approvalExpiresAt: "2026-11-08T12:00:00.000Z" })],
      [],
      m,
      () => NOW
    );
    const expired = m.scheduleDailyExpired.replace("{n}", "1");
    assert.ok(asked(action).includes(expired));
    assert.deepEqual(action.batch?.().map((request) => request.path), ["/api/admin/marketing/posts/a/schedule"]);
    const partial = action.describe?.({ sent: 1, failed: 0, unsent: 0, requiresReauthentication: false });
    assert.ok(partial?.includes(expired), partial ?? "");
  });

  test(`${locale}: nothing that fits is drawn disabled with the reason; nothing eligible draws no button`, () => {
    const [action] = scheduleDailyApprovedActions(
      [row("a", { approvalExpiresAt: "2026-11-07T00:00:00.000Z" })],
      [],
      m,
      () => NOW
    );
    assert.equal(action.unavailable, m.scheduleDailyNothingFits);
    assert.deepEqual(action.batch?.(), []);
    assert.deepEqual(scheduleDailyApprovedActions([row("m", { provider: "manual" })], [], m, () => NOW), []);
    assert.deepEqual(scheduleDailyApprovedActions([], [], m, () => NOW), []);
  });

  test(`${locale}: a batch that stopped never reads as done`, () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => NOW);
    const stopped = action.describe?.({ sent: 1, failed: 0, unsent: 3, requiresReauthentication: true });
    assert.equal(stopped, m.scheduleAllStopped.replace("{sent}", "1").replace("{failed}", "0").replace("{unsent}", "3"));
  });

  // Seoul 13:00:30 on 8 November: 10:00 has passed, so today's post goes "as
  // soon as possible", which moves with the clock.
  const AFTERNOON = Date.parse("2026-11-08T04:00:30.000Z");
  const seoulRows = () => [row("a"), row("b", { approvedAt: "2026-11-07T01:00:00.000Z" })];

  test(`${locale}: a page left open plans from the moment the button is pressed`, async () => {
    let now = AFTERNOON;
    const [action] = scheduleDailyApprovedActions(seoulRows(), [], m, () => now);
    now += 2 * 60 * 1000;
    const sent = await marketingBatchToSend(action, () => true);
    // Planned at the press (13:02:30 + 5 min), not at the render (13:06).
    assert.deepEqual(timesOf(sent), ["2026-11-08T04:08:00.000Z", "2026-11-09T01:00:00.000Z"]);
  });

  test(`${locale}: a confirmation left open past its times sends nothing and says to press again`, async () => {
    let now = AFTERNOON;
    const [action] = scheduleDailyApprovedActions(seoulRows(), [], m, () => now);
    let question = "";
    const sent = await marketingBatchToSend(action, (text) => {
      question = text;
      now += 60 * 1000; // the question stays open a minute
      return true;
    });
    // Today's slot shows its real local time; tomorrow's is the usual 10:00.
    assert.ok(question.includes("Instagram ko: 11/8 13:06, 11/9 (2"), question);
    assert.deepEqual(sent, { refused: m.scheduleDailyPlanChanged });
    assert.ok(!m.scheduleDailyPlanChanged.includes("{"));

    // Pressing again asks about the new plan, and that is what goes.
    const again = await marketingBatchToSend(action, () => true);
    assert.deepEqual(timesOf(again), ["2026-11-08T04:07:00.000Z", "2026-11-09T01:00:00.000Z"]);
    const seen: string[] = [];
    if (again === null || "refused" in again) throw new Error("expected requests");
    await sendMarketingBatch(again, async (request) => {
      seen.push((request.body as { scheduledAt: string }).scheduledAt);
      return json(200);
    });
    assert.deepEqual(seen, ["2026-11-08T04:07:00.000Z", "2026-11-09T01:00:00.000Z"]);
  });

  test(`${locale}: a plan that does not move with the clock survives a slow confirmation`, async () => {
    let now = NOW;
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => now);
    const sent = await marketingBatchToSend(action, () => {
      now += 3 * 60 * 1000;
      return true;
    });
    assert.deepEqual(timesOf(sent), [
      "2026-11-08T01:00:00.000Z",
      "2026-11-09T01:00:00.000Z",
      "2026-11-10T01:00:00.000Z",
      "2026-11-08T00:00:00.000Z",
    ]);
  });

  // Seoul 15:00 and Brisbane 16:00 on 8 November: both markets' 10:00 has passed.
  test(`${locale}: pressed in the afternoon, the confirmation shows today's real local time`, async () => {
    const afternoon = Date.parse("2026-11-08T06:00:00.000Z");
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => afternoon);
    const confirm = asked(action);
    assert.ok(confirm.includes("Instagram ko: 11/8 15:05, 11/9, 11/10 (3"), confirm);
    assert.ok(confirm.includes("LinkedIn en: 11/8 16:05 (1"), confirm);
    assert.ok(!confirm.includes("{"), confirm);
    assert.deepEqual(timesOf(await marketingBatchToSend(action, () => true)), [
      "2026-11-08T06:05:00.000Z",
      "2026-11-09T01:00:00.000Z",
      "2026-11-10T01:00:00.000Z",
      "2026-11-08T06:05:00.000Z",
    ]);
  });

  test(`${locale}: when the days already held could not all be read, the button is disabled and sends nothing`, async () => {
    const [action] = scheduleDailyApprovedActions(rows(), null, m, () => NOW);
    assert.equal(action.unavailable, m.scheduleDailyTakenIncomplete);
    assert.ok(!m.scheduleDailyTakenIncomplete.includes("{"));
    assert.deepEqual(action.batch?.(), []);
    assert.deepEqual(await marketingBatchToSend(action, () => true), { refused: m.scheduleDailyTakenIncomplete });
  });

  // Another tab scheduled a post on the same account for 9 Nov after this page was read.
  test(`${locale}: the plan is checked against the days held now, and a changed one sends nothing`, async () => {
    const reads: number[] = [];
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => NOW, async () => {
      reads.push(NOW);
      return {
        rows: rows(),
        taken: [{ channelId: "ig-ko", status: "scheduled", slotDay: null, scheduledAt: "2026-11-09T01:00:00.000Z" }],
      };
    });
    let question = "";
    const sent = await marketingBatchToSend(action, (text) => {
      question = text;
      return true;
    });
    assert.ok(question.includes("Instagram ko: 11/8, 11/9, 11/10 (3"), question);
    assert.equal(reads.length, 1, "read again after the yes, before anything is sent");
    assert.deepEqual(sent, { refused: m.scheduleDailyPlanChanged });
  });

  test(`${locale}: a re-read that fails, or comes back cut, sends nothing`, async () => {
    const [failed] = scheduleDailyApprovedActions(rows(), [], m, () => NOW, async () => null);
    assert.deepEqual(await marketingBatchToSend(failed, () => true), { refused: m.scheduleDailyRecheckFailed });
    assert.ok(!m.scheduleDailyRecheckFailed.includes("{"));
    const [cut] = scheduleDailyApprovedActions(rows(), [], m, () => NOW, async () => ({ rows: rows(), taken: null }));
    assert.deepEqual(await marketingBatchToSend(cut, () => true), { refused: m.scheduleDailyTakenIncomplete });
  });

  test(`${locale}: a re-read that shows the same days sends the confirmed plan`, async () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => NOW, async () => ({ rows: rows(), taken: [] }));
    assert.deepEqual(timesOf(await marketingBatchToSend(action, () => true)), [
      "2026-11-08T01:00:00.000Z",
      "2026-11-09T01:00:00.000Z",
      "2026-11-10T01:00:00.000Z",
      "2026-11-08T00:00:00.000Z",
    ]);
  });

  test(`${locale}: a declined confirmation sends nothing`, async () => {
    const [action] = scheduleDailyApprovedActions(rows(), [], m, () => NOW);
    assert.equal(await marketingBatchToSend(action, () => false), null);
  });

  test(`${locale}: the "publish all now" button is unchanged beside it`, () => {
    const [all] = scheduleAllApprovedActions(rows(), m);
    assert.equal(all.id, "schedule-all-approved");
    assert.ok(all.label.includes("4"));
  });
}
