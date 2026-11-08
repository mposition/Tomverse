import assert from "node:assert/strict";
import test from "node:test";

import {
  ledgerBucket,
  ledgerDailyFlow,
  ledgerTotals,
  ledgerTypeTone,
  ledgerTypesPresent,
} from "../lib/adminCreditLedgerStats.ts";

const row = (type, creditsDelta, createdAt = "2026-11-07T03:00:00.000Z") => ({ type, creditsDelta, createdAt });

test("each movement lands in one card: grants, use, returns, expiry, and everything else", () => {
  assert.equal(ledgerBucket(row("purchase", 5000)), "granted");
  assert.equal(ledgerBucket(row("dispute_reinstatement", 100)), "granted");
  assert.equal(ledgerBucket(row("admin_adjustment", 1000)), "granted");
  assert.equal(ledgerBucket(row("admin_adjustment", -50)), "other");
  assert.equal(ledgerBucket(row("reserve", -400)), "used");
  assert.equal(ledgerBucket(row("refund", 120)), "returned");
  assert.equal(ledgerBucket(row("expire", -210)), "expired");
  assert.equal(ledgerBucket(row("payment_refund", -7520)), "other");
  assert.equal(ledgerBucket(row("chargeback", -10)), "other");
  assert.equal(ledgerBucket(row("settle", 0)), "other");
  // A type this screen does not know is still counted by its sign.
  assert.equal(ledgerBucket(row("purchase_grant", 700)), "granted");
  assert.equal(ledgerBucket(row("settlement", -300)), "used");
});

test("totals net the returned credits off the use and rank grant sources", () => {
  const totals = ledgerTotals([
    row("purchase", 15400),
    row("admin_adjustment", 1000),
    row("reserve", -400),
    row("reserve", -320),
    row("refund", 120),
    row("expire", -210),
    row("payment_refund", -7520),
    row("settle", 0),
  ]);
  assert.equal(totals.granted, 16400);
  assert.equal(totals.used, 600);
  assert.equal(totals.expired, 210);
  assert.deepEqual(totals.grantedByType, [
    { type: "purchase", credits: 15400 },
    { type: "admin_adjustment", credits: 1000 },
  ]);
  // Handing back more than was held never shows as negative use.
  assert.equal(ledgerTotals([row("reserve", -10), row("refund", 50)]).used, 0);
});

test("filter chips come from the types present, known ones first in a fixed order", () => {
  assert.deepEqual(
    ledgerTypesPresent([
      { type: "expire" },
      { type: "zzz_new" },
      { type: "settle" },
      { type: "settle" },
      { type: "purchase" },
      { type: "aaa_new" },
    ]),
    [
      { type: "settle", count: 2 },
      { type: "purchase", count: 1 },
      { type: "expire", count: 1 },
      { type: "aaa_new", count: 1 },
      { type: "zzz_new", count: 1 },
    ]
  );
  assert.equal(ledgerTypeTone("purchase"), "ok");
  assert.equal(ledgerTypeTone("payment_refund"), "bad");
  assert.equal(ledgerTypeTone("something_new"), "idle");
});

test("the daily flow fills empty days between the first and last and splits grants from use", () => {
  const flow = ledgerDailyFlow([
    row("purchase", 1000, "2026-11-05T02:00:00.000Z"),
    row("reserve", -300, "2026-11-05T03:00:00.000Z"),
    row("reserve", -200, "2026-11-07T01:00:00.000Z"),
    row("refund", 50, "2026-11-07T02:00:00.000Z"),
  ]);
  assert.deepEqual(flow.days, ["2026-11-05", "2026-11-06", "2026-11-07"]);
  assert.deepEqual(flow.granted, [1000, 0, 0]);
  assert.deepEqual(flow.used, [300, 0, 150]);
});

test("the daily flow reads days in Brisbane time and is left out for a single day", () => {
  // 15:00 (UTC) is the next calendar day in Brisbane.
  const flow = ledgerDailyFlow([row("purchase", 10, "2026-11-04T15:00:00.000Z"), row("purchase", 10, "2026-11-04T09:00:00.000Z")]);
  assert.deepEqual(flow.days, ["2026-11-04", "2026-11-05"]);
  assert.equal(ledgerDailyFlow([row("purchase", 10), row("reserve", -5)]), null);
  assert.equal(ledgerDailyFlow([]), null);
  assert.equal(ledgerDailyFlow([row("purchase", 10, "garbage"), row("purchase", 10)]), null);
});

test("the daily flow keeps only the latest days of a long span", () => {
  const flow = ledgerDailyFlow(
    [row("purchase", 1, "2026-09-01T02:00:00.000Z"), row("purchase", 1, "2026-11-07T02:00:00.000Z")],
    30
  );
  assert.equal(flow.days.length, 30);
  assert.equal(flow.days[29], "2026-11-07");
  assert.equal(flow.granted[0], 0);
  assert.equal(flow.granted[29], 1);
});
