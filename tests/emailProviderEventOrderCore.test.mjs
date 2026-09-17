import assert from "node:assert/strict";
import { test } from "node:test";

import {
  PROVIDER_EVENT_RANK,
  compareProviderEventKeys,
  deliveredReleasesSoftBounce,
  providerEventAdvancesStatus,
  providerEventOccurredAt,
  providerEventRank,
  softBounceRun,
  softBounceStillCurrent,
} from "../lib/emailProviderEventOrderCore.ts";

// Contract: docs/policy/email-product-news-redesign-draft.md, section 7.4
// (event order).

const receivedAt = new Date("2026-09-17T00:10:00.000Z");
const at = (iso) => new Date(iso);

test("the provider's own time is used unless it is missing, malformed or too far ahead", () => {
  assert.equal(
    providerEventOccurredAt({ createdAt: "2026-09-17T00:01:02.345Z", receivedAt }).toISOString(),
    "2026-09-17T00:01:02.345Z"
  );
  // Up to five minutes ahead is clock skew, and believed.
  assert.equal(
    providerEventOccurredAt({ createdAt: "2026-09-17T00:15:00.000Z", receivedAt }).toISOString(),
    "2026-09-17T00:15:00.000Z"
  );
  for (const createdAt of [undefined, null, 17, "", "yesterday", "2026-09-17", "2026-09-17T00:15:00.001Z", "2026-13-45T99:99"]) {
    assert.equal(
      providerEventOccurredAt({ createdAt, receivedAt }).getTime(),
      receivedAt.getTime(),
      String(createdAt)
    );
  }
});

test("ranks follow the table: sent, delivered, soft bounce, hard bounce, complaint", () => {
  assert.equal(providerEventRank({ kind: "delivery_status", status: "sent" }), 0);
  assert.equal(providerEventRank({ kind: "delivery_status", status: "delivered" }), 1);
  assert.equal(providerEventRank({ kind: "soft_bounce" }), 2);
  assert.equal(
    providerEventRank({ kind: "suppress", reason: "hard_bounce", deliveryStatus: "bounced", temporary: false }),
    3
  );
  assert.equal(
    providerEventRank({ kind: "suppress", reason: "complaint", deliveryStatus: "complained", temporary: false }),
    4
  );
  assert.equal(providerEventRank({ kind: "ignored" }), null);
});

test("keys order by time, then by the more blocking event, then by event id", () => {
  const t = at("2026-09-17T00:00:00.000Z");
  const later = at("2026-09-17T00:00:00.001Z");
  const key = (occurredAt, rank, eventId) => ({ occurredAt, rank, eventId });
  assert.ok(compareProviderEventKeys(key(t, 4, "z"), key(later, 0, "a")) < 0);
  assert.ok(compareProviderEventKeys(key(t, PROVIDER_EVENT_RANK.soft_bounce, "a"), key(t, PROVIDER_EVENT_RANK.delivered, "z")) > 0);
  assert.ok(compareProviderEventKeys(key(t, 2, "b"), key(t, 2, "a")) > 0);
  assert.equal(compareProviderEventKeys(key(t, 2, "a"), key(t, 2, "a")), 0);
});

test("a status moves only for a later event, whatever order they are processed in", () => {
  const t = (s) => at(`2026-09-17T00:00:0${s}.000Z`);
  const events = [
    { occurredAt: t(1), rank: 0, eventId: "sent", status: "sent" },
    { occurredAt: t(2), rank: 1, eventId: "delivered", status: "delivered" },
    { occurredAt: t(2), rank: 2, eventId: "delayed", status: "bounced" },
    { occurredAt: t(3), rank: 1, eventId: "delivered-2", status: "delivered" },
  ];
  const permutations = (list) =>
    list.length <= 1
      ? [list]
      : list.flatMap((item, index) =>
          permutations([...list.slice(0, index), ...list.slice(index + 1)]).map((rest) => [item, ...rest])
        );
  const finals = new Set();
  for (const order of permutations(events)) {
    let last = null;
    let status = "queued";
    for (const event of order) {
      if (providerEventAdvancesStatus(event, last)) {
        last = event;
        status = event.status;
      }
    }
    finals.add(`${status}:${last.eventId}`);
  }
  assert.deepEqual([...finals], ["delivered:delivered-2"]);
});

test("a soft bounce at the same instant as a delivery counts and stands; an earlier one does not", () => {
  const delivered = at("2026-09-17T00:00:05.000Z");
  assert.equal(softBounceStillCurrent({ occurredAt: delivered, latestDeliveredAt: delivered }), true);
  assert.equal(
    softBounceStillCurrent({ occurredAt: at("2026-09-17T00:00:04.999Z"), latestDeliveredAt: delivered }),
    false
  );
  assert.equal(softBounceStillCurrent({ occurredAt: delivered, latestDeliveredAt: null }), true);

  assert.equal(deliveredReleasesSoftBounce({ deliveredAt: delivered, causeOccurredAt: delivered }), false);
  assert.equal(
    deliveredReleasesSoftBounce({ deliveredAt: delivered, causeOccurredAt: at("2026-09-17T00:00:04.999Z") }),
    true
  );

  assert.equal(
    softBounceRun({
      softBounceTimes: [at("2026-09-17T00:00:04.000Z"), delivered, at("2026-09-17T00:00:06.000Z"), null],
      latestDeliveredAt: delivered,
    }),
    2
  );
  assert.equal(
    softBounceRun({ softBounceTimes: [at("2026-09-17T00:00:04.000Z"), null], latestDeliveredAt: null }),
    1
  );
});
